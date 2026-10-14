export type ErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'POLICY_VIOLATION'
  | 'CAMPAIGN_NOT_OPEN'
  | 'FUNDING_DEADLINE_PASSED'
  | 'BELOW_MINIMUM'
  | 'EXCEEDS_REMAINING'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_STATE'
  | 'STAKE_NOT_CONFIRMED'
  | 'MINER_BUSY'
  | 'DUPLICATE_REFERENCE'
  | 'LOCKED_INSUFFICIENT'
  | 'NOTHING_TO_CLAIM'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DEMO_DISABLED'
  | 'LEDGER_INVARIANT';

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
    case 'POLICY_VIOLATION':
    case 'DEMO_DISABLED':
      return 403;
    case 'IDEMPOTENCY_CONFLICT':
    case 'DUPLICATE_REFERENCE':
      return 409;
    case 'LEDGER_INVARIANT':
      return 500;
    default:
      return 422;
  }
}
