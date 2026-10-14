export type Role = 'participant' | 'operator' | 'demo';

export interface CommandOutcome<T = any> {
  result: T;
  duplicate: boolean;
}

export interface ApiClient {
  readonly mode: 'http' | 'embedded';
  view<T = any>(name: string, params?: Record<string, string | undefined>): Promise<T>;
  command<T = any>(role: Role, type: string, input: Record<string, unknown>, idempotencyKey: string): Promise<CommandOutcome<T>>;
  reset(): Promise<void>;
  /** Notified when state changed outside this page (another tab, another viewer). */
  onExternalChange?(fn: () => void): () => void;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function newKey(prefix = 'ui'): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}
