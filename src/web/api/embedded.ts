// In-page backend for the hosted preview. Runs the same domain engine as the Node
// server and persists the event log to, in order of preference:
//   1. the artifact's private database (claude.ai `db` capability),
//   2. this browser's localStorage,
//   3. memory only.

import { DEMO } from '../../domain/config';
import { DomainError } from '../../domain/errors';
import { decode, encode } from '../../domain/serialize';
import { MemoryStore, Service, type EventStore } from '../../domain/service';
import type { Actor, DomainEvent } from '../../domain/types';
import { ApiError, type ApiClient, type Role } from './types';

// Minimal shape of the artifact runtime's db namespace we rely on.
interface DocSnap { exists: boolean; data(): Record<string, unknown> | undefined }
interface QuerySnap { docs: DocSnap[] }
interface Query { where(f: string, op: string, v: unknown): Query; orderBy(f: string, d?: 'asc' | 'desc'): Query; limit(n: number): Query; get(): Promise<QuerySnap> }
interface DocRef { get(): Promise<DocSnap>; set(d: Record<string, unknown>): Promise<void>; delete(): Promise<void>; onSnapshot(n: (s: DocSnap) => void, e?: (err: unknown) => void): () => void }
interface Collection extends Query { doc(id?: string): DocRef }
interface Db { doc(path: string): DocRef; collection(path: string): Collection }

const PREFIX = 'fp1';
const MAX_DOC_BYTES = 180_000;

class ArtifactDbStore implements EventStore {
  readonly kind = 'artifact-db';
  readonly label = "Saved in this artifact's private database";
  readonly durable = true;
  private head: { generation: number; lastSeq: number } = { generation: 1, lastSeq: 0 };
  readonly instanceId = Math.random().toString(36).slice(2);
  constructor(private readonly db: Db) {}

  private headRef() {
    return this.db.doc(`${PREFIX}_meta/head`);
  }
  private chunks() {
    return this.db.collection(`${PREFIX}_chunks`);
  }

  async readHead() {
    const snap = await this.headRef().get();
    const d = snap.exists ? (snap.data() as any) : undefined;
    return d && typeof d.generation === 'number' ? { generation: d.generation as number, lastSeq: d.lastSeq as number, writer: d.writer as string | undefined } : undefined;
  }

  async load(): Promise<DomainEvent[]> {
    const head = await this.readHead();
    if (!head) return [];
    const events: DomainEvent[] = [];
    let after = 0;
    for (let page = 0; page < 100; page++) {
      const snap = await this.chunks().where('generation', '==', head.generation).where('firstSeq', '>', after).orderBy('firstSeq').limit(500).get();
      if (!snap.docs.length) break;
      for (const d of snap.docs) {
        const body = d.data() as { firstSeq: number; payload: string };
        for (const ev of decode<DomainEvent[]>(body.payload)) {
          if (ev.seq > head.lastSeq) continue; // written but never committed
          if (ev.seq !== events.length + 1) throw new Error(`Saved demo log has a gap at ${ev.seq}`);
          events.push(ev);
        }
        after = body.firstSeq;
      }
      if (snap.docs.length < 500) break;
    }
    if (events.length !== head.lastSeq) throw new Error('Saved demo log is incomplete');
    this.head = { generation: head.generation, lastSeq: head.lastSeq };
    return events;
  }

  private async writeChunks(generation: number, events: DomainEvent[]) {
    let batch: DomainEvent[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const firstSeq = batch[0].seq;
      await this.chunks().doc(`g${generation}-s${String(firstSeq).padStart(7, '0')}`).set({ generation, firstSeq, lastSeq: batch[batch.length - 1].seq, payload: encode(batch) });
      batch = [];
    };
    for (const ev of events) {
      batch.push(ev);
      if (encode(batch).length > MAX_DOC_BYTES) {
        const last = batch.pop()!;
        await flush();
        batch = [last];
      }
    }
    await flush();
  }

  async append(events: DomainEvent[]): Promise<void> {
    if (!events.length) return;
    const head = await this.readHead();
    const expected = events[0].seq - 1;
    if ((head?.lastSeq ?? 0) !== expected || (head && head.generation !== this.head.generation)) {
      throw new DomainError('INVALID_STATE', 'The demo changed in another tab or window. It has been reloaded; please try again.', { conflict: true });
    }
    const generation = head?.generation ?? this.head.generation;
    await this.writeChunks(generation, events);
    // Advancing the head is the commit point.
    const lastSeq = events[events.length - 1].seq;
    await this.headRef().set({ generation, lastSeq, writer: this.instanceId, updatedAt: new Date().toISOString() });
    this.head = { generation, lastSeq };
  }

  async replaceAll(events: DomainEvent[]): Promise<void> {
    const head = await this.readHead();
    const generation = (head?.generation ?? 0) + 1;
    await this.writeChunks(generation, events);
    await this.headRef().set({ generation, lastSeq: events.length ? events[events.length - 1].seq : 0, writer: this.instanceId, updatedAt: new Date().toISOString() });
    const old = head?.generation;
    this.head = { generation, lastSeq: events.length ? events[events.length - 1].seq : 0 };
    if (old !== undefined) void this.prune(old);
  }

  private async prune(generation: number) {
    try {
      const snap = await this.chunks().where('generation', '<=', generation).limit(500).get();
      for (const d of snap.docs) {
        const b = d.data() as { generation: number; firstSeq: number };
        await this.chunks().doc(`g${b.generation}-s${String(b.firstSeq).padStart(7, '0')}`).delete();
      }
    } catch {
      // Best effort: stale chunks are ignored on load anyway.
    }
  }

  watch(fn: () => void): () => void {
    return this.headRef().onSnapshot(
      (snap) => {
        const d = snap.exists ? (snap.data() as any) : undefined;
        if (!d) return;
        if (d.writer !== this.instanceId && (d.lastSeq !== this.head.lastSeq || d.generation !== this.head.generation)) fn();
      },
      () => undefined,
    );
  }
}

class LocalStore implements EventStore {
  readonly kind = 'browser-local';
  readonly label = 'Saved in this browser only';
  readonly durable = true;
  private readonly key = 'flop-pool:v1:events';
  async load() {
    const raw = localStorage.getItem(this.key);
    return raw ? decode<DomainEvent[]>(raw) : [];
  }
  async append(events: DomainEvent[]) {
    const all = await this.load();
    localStorage.setItem(this.key, encode([...all, ...events]));
  }
  async replaceAll(events: DomainEvent[]) {
    localStorage.setItem(this.key, encode(events));
  }
}

class EphemeralStore extends MemoryStore {
  override readonly label = 'Not saved: storage is unavailable in this view';
}

declare global {
  interface Window {
    claude?: { use?: (name: string) => Promise<unknown> };
  }
}

async function pickStore(): Promise<EventStore> {
  try {
    const use = window.claude?.use;
    if (use) {
      const db = (await Promise.race([use('db'), new Promise((r) => setTimeout(() => r(null), 12_000))])) as Db | null;
      if (db) {
        const store = new ArtifactDbStore(db);
        await store.readHead(); // probe: fails fast if reads are refused
        return store;
      }
    }
  } catch {
    // fall through
  }
  try {
    const probe = 'flop-pool:probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return new LocalStore();
  } catch {
    return new EphemeralStore();
  }
}

function actorFor(role: Role): Actor {
  if (role === 'operator') return { kind: 'operator', id: 'operator-console' };
  if (role === 'demo') return { kind: 'demo', id: 'demo-controls' };
  return { kind: 'participant', id: DEMO.demoUserId };
}

function toApiError(e: unknown): never {
  if (e instanceof DomainError) throw new ApiError(e.code, e.message, e.details);
  throw e;
}

export async function createEmbeddedApi(): Promise<ApiClient & { storageLabel: string }> {
  const store = await pickStore();
  let service: Service;
  try {
    service = await Service.open(store, { demoEnabled: true });
  } catch {
    // A corrupt or incompatible saved log: start fresh rather than fail to load.
    await store.replaceAll([]);
    service = await Service.open(store, { demoEnabled: true });
  }
  const listeners = new Set<() => void>();
  if (store instanceof ArtifactDbStore) {
    store.watch(async () => {
      await service.reload();
      listeners.forEach((fn) => fn());
    });
  }
  return {
    mode: 'embedded',
    storageLabel: store.label,
    async view(name, params = {}) {
      try {
        return service.view(name, params) as any;
      } catch (e) {
        toApiError(e);
      }
    },
    async command(role, type, input, idempotencyKey) {
      try {
        const out = await service.execute({ type, input, idempotencyKey }, actorFor(role));
        return { result: out.result as any, duplicate: out.duplicate };
      } catch (e) {
        if (e instanceof DomainError && e.details?.conflict) await service.reload();
        toApiError(e);
      }
    },
    async reset() {
      await service.reset();
    },
    onExternalChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
