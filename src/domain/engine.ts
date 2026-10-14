// Command execution. A command runs against a draft copy of state inside a Tx.
// Every change is an event applied through the reducer. The caller persists the
// events and only then commits the draft, so a failed command or a failed write
// leaves state untouched.

import { findPolicy, acct } from './accounts';
import { DomainError } from './errors';
import { SimulatedProvider } from './providers/simulated';
import type { ComputeProviderAdapter } from './providers/types';
import { applyEvent, replay } from './state';
import { canonicalJson } from './serialize';
import type { Actor, ActorKind, DomainEvent, Posting, State } from './types';

export class Tx {
  readonly events: DomainEvent[] = [];
  private readonly actors: Actor[];
  readonly provider: ComputeProviderAdapter;

  constructor(
    public readonly state: State,
    actor: Actor,
    public readonly commandId: string | undefined,
    private readonly wallTime: string,
  ) {
    this.actors = [actor];
    this.provider = new SimulatedProvider(() => this.state.sim);
  }

  get actor(): Actor {
    return this.actors[this.actors.length - 1];
  }

  get now(): string {
    return this.state.clock;
  }

  /** Run `fn` with a narrower service identity, e.g. the orchestrator or the rewards service. */
  as<T>(actor: Actor, fn: () => T): T {
    this.actors.push(actor);
    try {
      return fn();
    } finally {
      this.actors.pop();
    }
  }

  emit<D>(type: string, data: D, postings?: Posting[]): DomainEvent<D> {
    const actor = this.actor;
    for (const p of postings ?? []) {
      if (!findPolicy(p.asset, p.from, p.to, actor.kind)) {
        throw new DomainError(
          'POLICY_VIOLATION',
          `${actor.kind} may not move ${p.asset} from ${p.from} to ${p.to}.`,
          { actor: actor.kind, from: p.from, to: p.to, asset: p.asset },
        );
      }
      if (actor.kind === 'participant' && p.from.startsWith('user:') && p.from !== acct.wallet(actor.id)) {
        throw new DomainError('POLICY_VIOLATION', 'A participant can only spend from their own wallet.');
      }
    }
    const seq = this.state.seq + 1;
    const ev: DomainEvent<D> = {
      seq,
      id: `EVT-${String(seq).padStart(6, '0')}`,
      type,
      at: this.state.clock,
      recordedAt: this.wallTime,
      actor: actor.id,
      actorKind: actor.kind,
      commandId: this.commandId,
      data,
      postings: postings && postings.length ? postings : undefined,
    };
    applyEvent(this.state, ev);
    this.events.push(ev);
    return ev;
  }

  /** Deterministic sequential id from the size of a collection. */
  nextId(prefix: string, collection: Record<string, unknown>, pad = 3): string {
    return `${prefix}-${String(Object.keys(collection).length + 1).padStart(pad, '0')}`;
  }
}

export const SERVICE_ACTORS = {
  orchestrator: { kind: 'orchestrator', id: 'svc-orchestrator' } as Actor,
  rewards: { kind: 'rewards', id: 'svc-rewards' } as Actor,
  settlement: { kind: 'settlement', id: 'svc-settlement' } as Actor,
  system: { kind: 'system', id: 'svc-scheduler' } as Actor,
};

export interface CommandDef<I = any, R = any> {
  type: string;
  /** Actor kinds allowed to invoke this command directly. */
  actors: ActorKind[];
  /** Demo-only control; refused when demo mode is disabled. */
  demo?: boolean;
  handler: (tx: Tx, input: I) => R;
}

export interface CommandRequest {
  type: string;
  input?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface Prepared {
  state: State;
  events: DomainEvent[];
  result: unknown;
  duplicate: boolean;
}

export interface EngineOptions {
  demoEnabled: boolean;
  wallClock: () => string;
}

export class Engine {
  state: State;
  private readonly commands = new Map<string, CommandDef>();

  constructor(
    events: DomainEvent[],
    commandDefs: CommandDef[],
    private readonly options: EngineOptions,
    genesisClock: string,
  ) {
    this.state = replay(events, genesisClock);
    for (const def of commandDefs) this.commands.set(def.type, def);
  }

  commandTypes(): string[] {
    return [...this.commands.keys()];
  }

  /** Run a command on a draft. Does not change `this.state`; call `commit` after persisting. */
  prepare(req: CommandRequest, actor: Actor): Prepared {
    const def = this.commands.get(req.type);
    if (!def) throw new DomainError('NOT_FOUND', `Unknown command ${req.type}.`);
    if (!def.actors.includes(actor.kind)) {
      throw new DomainError('FORBIDDEN', `${actor.kind} is not allowed to run ${req.type}.`);
    }
    if (def.demo && !this.options.demoEnabled) {
      throw new DomainError('DEMO_DISABLED', 'Demo controls are disabled on this deployment.');
    }
    const key = typeof req.idempotencyKey === 'string' ? req.idempotencyKey.trim() : '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new DomainError('INVALID_INPUT', 'Each request needs an idempotency key (8–128 letters, digits, ".", "_", ":", "-").');
    }
    const request = canonicalJson({ type: req.type, actor: `${actor.kind}:${actor.id}`, input: req.input ?? {} });
    const prior = this.state.idempotency[key];
    if (prior) {
      if (prior.request !== request) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request.');
      }
      return { state: this.state, events: [], result: prior.result, duplicate: true };
    }
    const draft = structuredClone(this.state);
    const tx = new Tx(draft, actor, key, this.options.wallClock());
    const result = def.handler(tx, (req.input ?? {}) as any);
    tx.emit('command.completed', { key, commandType: req.type, actor: `${actor.kind}:${actor.id}`, request, result });
    return { state: draft, events: tx.events, result, duplicate: false };
  }

  commit(prepared: Prepared): void {
    if (prepared.duplicate) return;
    this.state = prepared.state;
  }

  /** Convenience for tests and in-memory use: prepare + commit with no persistence. */
  execute(req: CommandRequest, actor: Actor): Prepared {
    const p = this.prepare(req, actor);
    this.commit(p);
    return p;
  }
}
