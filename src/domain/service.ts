// Ties the engine to an event store. Used by the Node server (SQLite) and by the
// in-browser preview (artifact database / browser storage).

import { ALL_COMMANDS, SEED_ACTOR, SEED_REQUEST } from './commands';
import { DEMO } from './config';
import { Engine, type CommandRequest } from './engine';
import { DomainError } from './errors';
import type { Actor, DomainEvent } from './types';
import { viewAudit, viewCampaign, viewHome, viewLedger, viewOperator, viewPortfolio } from './views';

export interface EventStore {
  readonly kind: string;
  readonly label: string;
  readonly durable: boolean;
  load(): Promise<DomainEvent[]>;
  /** Append atomically: all or nothing. */
  append(events: DomainEvent[]): Promise<void>;
  /** Replace the whole log (demo reset). */
  replaceAll(events: DomainEvent[]): Promise<void>;
}

export interface ServiceOptions {
  demoEnabled: boolean;
  env?: Record<string, string | undefined>;
  wallClock?: () => string;
}

export interface ExecuteResult {
  result: unknown;
  duplicate: boolean;
  eventCount: number;
  seq: number;
}

function newEngine(events: DomainEvent[], opts: ServiceOptions) {
  return new Engine(events, ALL_COMMANDS, { demoEnabled: opts.demoEnabled, wallClock: opts.wallClock ?? (() => new Date().toISOString()) }, DEMO.clockStart);
}

export function seedEvents(opts: ServiceOptions): DomainEvent[] {
  const engine = newEngine([], opts);
  return engine.execute(SEED_REQUEST, SEED_ACTOR).events;
}

export class Service {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    private engine: Engine,
    private events: DomainEvent[],
    readonly store: EventStore,
    private readonly opts: ServiceOptions,
  ) {}

  static async open(store: EventStore, opts: ServiceOptions): Promise<Service> {
    let events = await store.load();
    if (events.length === 0) {
      events = seedEvents(opts);
      await store.append(events);
    }
    return new Service(newEngine(events, opts), events, store, opts);
  }

  get state() {
    return this.engine.state;
  }

  get eventLog(): readonly DomainEvent[] {
    return this.events;
  }

  /** Commands run one at a time so each sees the result of the previous one. */
  execute(req: CommandRequest, actor: Actor): Promise<ExecuteResult> {
    const run = async () => {
      const prepared = this.engine.prepare(req, actor);
      if (!prepared.duplicate) {
        await this.store.append(prepared.events);
        this.engine.commit(prepared);
        this.events.push(...prepared.events);
      }
      return { result: prepared.result, duplicate: prepared.duplicate, eventCount: prepared.events.length, seq: this.engine.state.seq };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Discard all demo state and re-seed. */
  reset(): Promise<void> {
    const run = async () => {
      if (!this.opts.demoEnabled) throw new DomainError('DEMO_DISABLED', 'Demo reset is disabled on this deployment.');
      const events = seedEvents(this.opts);
      await this.store.replaceAll(events);
      this.engine = newEngine(events, this.opts);
      this.events = [...events];
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Re-read the store (e.g. another tab wrote to the shared preview database). */
  async reload(): Promise<void> {
    const run = async () => {
      const events = await this.store.load();
      if (events.length === 0) return;
      this.engine = newEngine(events, this.opts);
      this.events = events;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  view(name: string, params: Record<string, string | undefined>): unknown {
    const s = this.engine.state;
    const viewer = params.viewer || DEMO.demoUserId;
    switch (name) {
      case 'home':
        return viewHome(s, viewer);
      case 'campaign': {
        const v = viewCampaign(s, params.id ?? '', viewer);
        if (!v) throw new DomainError('NOT_FOUND', `Campaign ${params.id} was not found.`);
        return v;
      }
      case 'portfolio':
        return viewPortfolio(s, viewer);
      case 'operator':
        return viewOperator(s, this.opts.env ?? {});
      case 'ledger':
        return viewLedger(s);
      case 'audit':
        return viewAudit(this.events as DomainEvent[], { campaignId: params.campaignId || undefined, limit: params.limit ? Number(params.limit) : undefined, includeCommands: params.includeCommands === '1' });
      case 'meta':
        return { store: { kind: this.store.kind, label: this.store.label, durable: this.store.durable }, demoEnabled: this.opts.demoEnabled, seq: s.seq, clock: s.clock, demoUserId: DEMO.demoUserId };
      default:
        throw new DomainError('NOT_FOUND', `Unknown view ${name}.`);
    }
  }
}

export class MemoryStore implements EventStore {
  readonly kind = 'memory';
  readonly label = 'In memory only (not saved)';
  readonly durable = false;
  private events: DomainEvent[] = [];
  async load() {
    return [...this.events];
  }
  async append(events: DomainEvent[]) {
    this.events.push(...events);
  }
  async replaceAll(events: DomainEvent[]) {
    this.events = [...events];
  }
}
