// Platform fee model: deliberately unconfigured.
//
// The initial suggestion was "about 5% of profit". That is not 5% of contributed
// funds and not 5% of token rewards, and this module must not silently substitute
// either. Until the questions below are answered, every campaign uses
// { kind: 'unconfigured' } and the fee is zero.

export type FeeModel =
  | { kind: 'unconfigured' }
  // Placeholder shape for the eventual agreed model. Not selectable in the prototype.
  | { kind: 'profit_share'; bps: number; profitDefinitionVersion: string };

export const FEE_OPEN_QUESTIONS = [
  'Profit calculation: rewards value minus which costs, per campaign or per participant?',
  'Token valuation: at what price and when are FLOP rewards valued for a profit test?',
  'Eligible costs: GPU rental only, or also replacements, monitoring, stake financing, operator time?',
  'Realization timing: charged at receipt, at unlock, at claim, or at campaign close? What if rewards unlock years later?',
  'Fee currency: taken in FLOP from rewards, or invoiced in USDC?',
];

export interface FeeResult {
  model: FeeModel['kind'];
  usdcUnits: bigint;
  flopUnits: bigint;
  note: string;
}

export function computeSettlementFee(model: FeeModel): FeeResult {
  if (model.kind === 'unconfigured') {
    return { model: model.kind, usdcUnits: 0n, flopUnits: 0n, note: 'Platform fee not configured; no fee charged.' };
  }
  // A profit-share model cannot be computed until the open questions are resolved.
  throw new Error('profit_share fee model is not implemented; see FEE_OPEN_QUESTIONS');
}

export function computeRewardFee(model: FeeModel): FeeResult {
  return computeSettlementFee(model);
}
