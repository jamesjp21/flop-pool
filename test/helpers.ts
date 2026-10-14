import { ALL_COMMANDS, SEED_ACTOR, SEED_REQUEST } from '../src/domain/commands';
import { DEMO } from '../src/domain/config';
import { Engine } from '../src/domain/engine';
import { DomainError } from '../src/domain/errors';
import type { Actor, DomainEvent } from '../src/domain/types';

let n = 0;
export const key = (label = 'k') => `test-${label}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

export const ME: Actor = { kind: 'participant', id: DEMO.demoUserId };
export const OP: Actor = { kind: 'operator', id: 'op-founder' };
export const DEMO_ACTOR: Actor = { kind: 'demo', id: 'demo-controls' };
export const participant = (id: string): Actor => ({ kind: 'participant', id });

export function seededEngine(opts: { demoEnabled?: boolean } = {}) {
  let t = 0;
  const engine = new Engine([], ALL_COMMANDS, { demoEnabled: opts.demoEnabled ?? true, wallClock: () => new Date(Date.UTC(2026, 9, 14, 12, 0, t++)).toISOString() }, DEMO.clockStart);
  const log: DomainEvent[] = [];
  const execute = engine.execute.bind(engine);
  engine.execute = (req, actor) => {
    const p = execute(req, actor);
    log.push(...p.events);
    return p;
  };
  engine.execute(SEED_REQUEST, SEED_ACTOR);
  return Object.assign(engine, { log });
}

export function run(engine: Engine, actor: Actor, type: string, input: Record<string, unknown> = {}, idempotencyKey = key(type)) {
  return engine.execute({ type, input, idempotencyKey }, actor).result as any;
}

export function expectError(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError && e.code === code) return e;
    throw new Error(`Expected ${code}, got ${e instanceof DomainError ? `${e.code}: ${e.message}` : String(e)}`);
  }
  throw new Error(`Expected ${code}, but the call succeeded`);
}
