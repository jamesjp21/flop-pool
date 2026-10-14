// Reward accounting.
//
// 1. A receipt records FLOP that actually reached the miner account (simulated
//    here: entered by an operator). It is split into lots by the overlap of its
//    earning period with each campaign's operating window on that miner. Time
//    outside every window stays unattributed. The latest campaign never inherits
//    other periods' rewards.
// 2. Each lot carries a liquid part (distributable now) and a locked part.
// 3. An unlock moves locked FLOP of a specific receipt to distributable. It
//    belongs to the campaign(s) that earned the receipt, even if the unlock is
//    triggered during a later campaign.
// 4. Distribution credits entitlements by cumulative floor:
//      credited_i = floor(distributable_total × share_i)
//    This is path-independent (any batching of receipts and unlocks yields the
//    same credits) and leaves a residual of fewer base units than there are
//    holders. The residual stays in the campaign's undistributed account and is
//    carried forward; it is never swept to the operator.
// 5. A claim pays out exactly the credited-but-unclaimed balance. Repeating a
//    claim (same idempotency key) returns the original result; a new claim with
//    nothing claimable is rejected. Nothing can be paid twice.

import { acct } from '../accounts';
import { PROTOCOL_ASSUMPTIONS } from '../config';
import { SERVICE_ACTORS, type CommandDef, type Tx } from '../engine';
import { DomainError } from '../errors';
import { apportion, formatAmount, mulDivFloor, parseAmount, parsePositiveAmount } from '../money';
import { balanceOf } from '../state';
import { isBefore, isValidIso, overlapMs, toMs } from '../time';
import type { Posting, RewardKind, RewardLot, RewardReceipt, State } from '../types';
import { requireCampaign } from './campaigns';

const KINDS: RewardKind[] = ['block_reward', 'session_payment', 'airdrop', 'other'];
const UNATTRIBUTED = '__unattributed__';

function cleanRef(v: unknown): string {
  const ref = typeof v === 'string' ? v.trim() : '';
  if (!/^[A-Za-z0-9._:\-/#]{3,80}$/.test(ref)) {
    throw new DomainError('INVALID_INPUT', 'Reference must be 3–80 characters (letters, digits, . _ : - / #). Use the on-chain or provider reference.');
  }
  return ref;
}

export interface ReceiptInput {
  minerId: string;
  kind: RewardKind;
  amount: string;
  /** Liquid portion. Defaults to the full amount, or 25% for an airdrop (draft design). */
  liquidAmount?: string;
  earnedFrom: string;
  earnedTo: string;
  externalRef: string;
  note?: string;
}

/** Attribution weights (in ms) of an earning period across a miner's operating windows. */
export function attributionWeights(state: State, minerId: string, earnedFrom: string, earnedTo: string, now: string) {
  const miner = state.miners[minerId];
  const windows = miner.windows.map((w) => ({ campaignId: w.campaignId, from: w.from, to: w.to ?? now }));
  const weights = new Map<string, number>();
  if (earnedFrom === earnedTo) {
    // A point in time belongs to the window [from, to) — or [from, now] while still open.
    const t = toMs(earnedFrom);
    const w = miner.windows.find((x) => toMs(x.from) <= t && (x.to ? t < toMs(x.to) : t <= toMs(now)));
    weights.set(w ? w.campaignId : UNATTRIBUTED, 1);
    return weights;
  }
  const total = toMs(earnedTo) - toMs(earnedFrom);
  let covered = 0;
  for (const w of windows) {
    const ov = overlapMs(earnedFrom, earnedTo, w.from, w.to);
    if (ov > 0) {
      weights.set(w.campaignId, (weights.get(w.campaignId) ?? 0) + ov);
      covered += ov;
    }
  }
  if (total - covered > 0) weights.set(UNATTRIBUTED, total - covered);
  return weights;
}

export function recordReceipt(tx: Tx, input: ReceiptInput) {
  const miner = tx.state.miners[input.minerId];
  if (!miner) throw new DomainError('NOT_FOUND', `Miner account ${input.minerId} was not found.`);
  if (!KINDS.includes(input.kind)) throw new DomainError('INVALID_INPUT', `Reward type must be one of ${KINDS.join(', ')}.`);
  const amount = parsePositiveAmount(input.amount, 'FLOP', 'reward amount');
  let liquid: bigint;
  if (input.liquidAmount === undefined || input.liquidAmount === '') {
    liquid = input.kind === 'airdrop' ? (amount * BigInt(PROTOCOL_ASSUMPTIONS.airdropDraft.liquidAtGenesisBps)) / 10_000n : amount;
  } else {
    liquid = parseAmount(input.liquidAmount, 'FLOP', 'liquid amount');
  }
  if (liquid > amount) throw new DomainError('INVALID_INPUT', 'The liquid amount cannot exceed the total received.');
  if (!isValidIso(input.earnedFrom) || !isValidIso(input.earnedTo)) throw new DomainError('INVALID_INPUT', 'Earning period must be ISO timestamps.');
  if (isBefore(input.earnedTo, input.earnedFrom)) throw new DomainError('INVALID_INPUT', 'Earning period ends before it starts.');
  if (isBefore(tx.now, input.earnedTo)) throw new DomainError('INVALID_INPUT', 'Earning period cannot end in the future.');
  const externalRef = cleanRef(input.externalRef);
  if (tx.state.externalRefs[`receipt:${externalRef}`]) {
    throw new DomainError('DUPLICATE_REFERENCE', `Receipt ${externalRef} was already recorded as ${tx.state.externalRefs[`receipt:${externalRef}`]}. It will not be credited twice.`);
  }

  const weights = attributionWeights(tx.state, miner.id, input.earnedFrom, input.earnedTo, tx.now);
  const keys = [...weights.keys()];
  const amounts = apportion(amount, keys.map((k) => ({ key: k, weight: BigInt(weights.get(k)!), tiebreak: k })));
  const liquids = apportion(liquid, keys.map((k) => ({ key: k, weight: amounts.get(k)!, tiebreak: k })));

  const receiptId = tx.nextId('R', tx.state.receipts);
  const lots: RewardLot[] = keys.map((k, i) => {
    const a = amounts.get(k)!;
    const l = liquids.get(k)!;
    return {
      id: `${receiptId}-L${i + 1}`,
      receiptId,
      campaignId: k === UNATTRIBUTED ? null : k,
      overlapMs: weights.get(k)!,
      amountUnits: a,
      liquidUnits: l,
      lockedUnits: a - l,
      lockedRemainingUnits: a - l,
    };
  });
  const postings: Posting[] = [];
  for (const lot of lots) {
    const locked = lot.campaignId ? acct.rewardsLocked(lot.campaignId) : acct.unattributedLocked(miner.id);
    const open = lot.campaignId ? acct.rewardsUndistributed(lot.campaignId) : acct.unattributedUnlocked(miner.id);
    if (lot.liquidUnits > 0n) postings.push({ asset: 'FLOP', from: acct.protocol, to: open, amount: lot.liquidUnits, memo: `${lot.id} liquid` });
    if (lot.lockedUnits > 0n) postings.push({ asset: 'FLOP', from: acct.protocol, to: locked, amount: lot.lockedUnits, memo: `${lot.id} locked` });
  }
  const receipt: RewardReceipt = {
    id: receiptId,
    minerId: miner.id,
    kind: input.kind,
    amountUnits: amount,
    liquidUnits: liquid,
    lockedUnits: amount - liquid,
    unlockedUnits: 0n,
    earnedFrom: input.earnedFrom,
    earnedTo: input.earnedTo,
    externalRef,
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '',
    recordedAt: tx.now,
    lotIds: lots.map((l) => l.id),
  };
  tx.emit('reward.receipt_recorded', { receipt, lots, simulated: true }, postings);
  for (const lot of lots) if (lot.campaignId && lot.liquidUnits > 0n) distribute(tx, lot.campaignId, { kind: 'receipt', ref: receiptId });
  return { receiptId, lots: lots.map((l) => ({ lotId: l.id, campaignId: l.campaignId, amountUnits: l.amountUnits, lockedUnits: l.lockedUnits })) };
}

export function recordUnlock(tx: Tx, input: { receiptId: string; amount: string; externalRef: string; note?: string }) {
  const r = tx.state.receipts[input.receiptId];
  if (!r) throw new DomainError('NOT_FOUND', `Receipt ${input.receiptId} was not found.`);
  const amount = parsePositiveAmount(input.amount, 'FLOP', 'unlock amount');
  const remaining = r.lockedUnits - r.unlockedUnits;
  if (amount > remaining) {
    throw new DomainError('LOCKED_INSUFFICIENT', `Only ${formatAmount(remaining, 'FLOP')} is still locked on ${r.id}.`, { remainingUnits: remaining });
  }
  const externalRef = cleanRef(input.externalRef);
  if (tx.state.externalRefs[`unlock:${externalRef}`]) {
    throw new DomainError('DUPLICATE_REFERENCE', `Unlock ${externalRef} was already recorded. It will not be applied twice.`);
  }
  const lots = r.lotIds.map((id) => tx.state.lots[id]).filter((l) => l.lockedRemainingUnits > 0n);
  const parts = apportion(amount, lots.map((l) => ({ key: l.id, weight: l.lockedRemainingUnits, tiebreak: l.id })));
  const perLot = lots.map((l) => ({ lotId: l.id, campaignId: l.campaignId, units: parts.get(l.id) ?? 0n })).filter((p) => p.units > 0n);
  const postings: Posting[] = perLot.map((p) => ({
    asset: 'FLOP',
    from: p.campaignId ? acct.rewardsLocked(p.campaignId) : acct.unattributedLocked(r.minerId),
    to: p.campaignId ? acct.rewardsUndistributed(p.campaignId) : acct.unattributedUnlocked(r.minerId),
    amount: p.units,
    memo: `Unlock of ${p.lotId}`,
  }));
  const id = tx.nextId('U', tx.state.unlocks);
  tx.emit(
    'reward.unlocked',
    { unlock: { id, receiptId: r.id, amountUnits: amount, externalRef, note: typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '', at: tx.now, perLot }, simulated: true },
    postings,
  );
  for (const cid of new Set(perLot.map((p) => p.campaignId).filter((x): x is string => Boolean(x)))) {
    distribute(tx, cid, { kind: 'unlock', ref: id });
  }
  return { unlockId: id, perLot };
}

export function distribute(tx: Tx, campaignId: string, trigger: { kind: 'receipt' | 'unlock'; ref: string }) {
  const c = requireCampaign(tx.state, campaignId);
  const ents = c.entitlementIds.map((id) => tx.state.entitlements[id]).filter((e) => e.status === 'active');
  const cumulative = c.rewards.distributableUnits;
  const credits = ents
    .map((e) => ({ entitlementId: e.id, holderId: e.holderId, units: mulDivFloor(cumulative, e.shareNumerator, e.shareDenominator) - e.creditedUnits }))
    .filter((x) => x.units > 0n);
  const before = c.rewards.creditedUnits;
  const after = before + credits.reduce((s, x) => s + x.units, 0n);
  if (after > cumulative) throw new DomainError('LEDGER_INVARIANT', 'Distribution would exceed distributable rewards.');
  tx.emit(
    'reward.distributed',
    {
      distribution: {
        id: tx.nextId('DS', tx.state.distributions, 4),
        campaignId: c.id,
        at: tx.now,
        trigger,
        distributableBefore: before,
        distributableAfter: cumulative,
        credits,
        residualAfter: cumulative - after,
      },
    },
    credits.map((x) => ({ asset: 'FLOP', from: acct.rewardsUndistributed(c.id), to: acct.claimable(x.entitlementId), amount: x.units, memo: `Credit to ${x.entitlementId}` })),
  );
}

export function claim(tx: Tx, userId: string, entitlementId: unknown) {
  const e = typeof entitlementId === 'string' ? tx.state.entitlements[entitlementId] : undefined;
  if (!e) throw new DomainError('NOT_FOUND', 'Allocation not found.');
  if (e.holderId !== userId) throw new DomainError('FORBIDDEN', 'You can only claim rewards for allocations you hold.');
  if (e.status !== 'active') throw new DomainError('INVALID_STATE', 'This allocation is void (the campaign never operated).');
  const claimable = balanceOf(tx.state, acct.claimable(e.id), 'FLOP');
  if (claimable <= 0n) {
    throw new DomainError('NOTHING_TO_CLAIM', 'Nothing is claimable right now. Locked rewards become claimable only after they unlock.');
  }
  const id = tx.nextId('CL', tx.state.claims, 4);
  const simulatedTxRef = `sim-tx-${id.toLowerCase()}`;
  tx.as(SERVICE_ACTORS.rewards, () =>
    tx.emit('claim.paid', { claim: { id, entitlementId: e.id, campaignId: e.campaignId, holderId: userId, units: claimable, at: tx.now, simulatedTxRef }, simulated: true }, [
      { asset: 'FLOP', from: acct.claimable(e.id), to: acct.wallet(userId), amount: claimable, memo: `Claim ${id}` },
    ]),
  );
  return { claimId: id, entitlementId: e.id, units: claimable, simulatedTxRef };
}

export const rewardCommands: CommandDef[] = [
  {
    type: 'reward.recordReceipt',
    actors: ['operator'],
    handler: (tx, input: ReceiptInput) => tx.as(SERVICE_ACTORS.rewards, () => recordReceipt(tx, input)),
  },
  {
    type: 'reward.recordUnlock',
    actors: ['operator'],
    handler: (tx, input: { receiptId: string; amount: string; externalRef: string; note?: string }) =>
      tx.as(SERVICE_ACTORS.rewards, () => recordUnlock(tx, input)),
  },
  {
    type: 'claim.submit',
    actors: ['participant'],
    handler: (tx, input: { entitlementId: string }) => claim(tx, tx.actor.id, input.entitlementId),
  },
];
