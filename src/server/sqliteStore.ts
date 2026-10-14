// Append-only event store on SQLite (Node's built-in node:sqlite, no native deps).
//
//   events   — the source of truth, one row per domain event, never updated.
//   postings — double-entry ledger lines projected from events in the same
//              transaction, so the ledger can be inspected with plain SQL:
//                SELECT asset, to_account, SUM(CAST(amount AS INTEGER)) ...
// State is rebuilt by replaying `events` on startup.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decode, encode } from '../domain/serialize';
import type { EventStore } from '../domain/service';
import type { DomainEvent } from '../domain/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  at          TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_kind  TEXT NOT NULL,
  command_id  TEXT,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS events_command ON events(command_id);
CREATE TABLE IF NOT EXISTS postings (
  event_seq    INTEGER NOT NULL REFERENCES events(seq),
  line         INTEGER NOT NULL,
  asset        TEXT NOT NULL,
  from_account TEXT NOT NULL,
  to_account   TEXT NOT NULL,
  amount       TEXT NOT NULL,
  memo         TEXT NOT NULL,
  PRIMARY KEY (event_seq, line)
);
CREATE INDEX IF NOT EXISTS postings_from ON postings(from_account);
CREATE INDEX IF NOT EXISTS postings_to ON postings(to_account);
`;

export class SqliteStore implements EventStore {
  readonly kind = 'sqlite';
  readonly durable = true;
  readonly label: string;
  private readonly db: DatabaseSync;

  constructor(private readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
    this.label = path === ':memory:' ? 'SQLite (in memory)' : `SQLite file ${path}`;
  }

  async load(): Promise<DomainEvent[]> {
    const rows = this.db.prepare('SELECT seq, payload FROM events ORDER BY seq').all() as { seq: number; payload: string }[];
    const events = rows.map((r) => decode<DomainEvent>(r.payload));
    events.forEach((ev, i) => {
      if (ev.seq !== i + 1) throw new Error(`Event log is not contiguous at row ${i + 1} (seq ${ev.seq})`);
    });
    const postingRows = (this.db.prepare('SELECT COUNT(*) AS n FROM postings').get() as { n: number }).n;
    const expected = events.reduce((t, ev) => t + (ev.postings?.length ?? 0), 0);
    if (postingRows !== expected) throw new Error(`Ledger projection mismatch: ${postingRows} posting rows, ${expected} in events`);
    return events;
  }

  async append(events: DomainEvent[]): Promise<void> {
    if (!events.length) return;
    this.tx(() => this.insert(events));
  }

  async replaceAll(events: DomainEvent[]): Promise<void> {
    this.tx(() => {
      this.db.exec('DELETE FROM postings; DELETE FROM events;');
      this.insert(events);
    });
  }

  close() {
    this.db.close();
  }

  private tx(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private insert(events: DomainEvent[]) {
    const ev = this.db.prepare(
      'INSERT INTO events(seq, id, type, at, recorded_at, actor, actor_kind, command_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const po = this.db.prepare('INSERT INTO postings(event_seq, line, asset, from_account, to_account, amount, memo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const e of events) {
      ev.run(e.seq, e.id, e.type, e.at, e.recordedAt, e.actor, e.actorKind, e.commandId ?? null, encode(e));
      (e.postings ?? []).forEach((p, i) => po.run(e.seq, i + 1, p.asset, p.from, p.to, p.amount.toString(), p.memo));
    }
  }
}
