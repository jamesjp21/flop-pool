import type { Asset } from './money';
import type { FeeModel, FeeResult } from './fees';

export type ISO = string;

export type ActorKind =
  | 'participant' // a customer acting on their own wallet and entitlements
  | 'operator' // a human operator of the service
  | 'orchestrator' // GPU automation: may only pay providers from campaign budgets
  | 'rewards' // reward accounting service: may only move FLOP along the reward path
  | 'settlement' // refund engine: may only return USDC from campaign budgets
  | 'system' // scheduler (deadlines, term completion)
  | 'demo' // clearly labeled simulation controls
  | 'seed'; // initial demo data

export interface Actor {
  kind: ActorKind;
  id: string;
}

export interface Posting {
  asset: Asset;
  from: string;
  to: string;
  amount: bigint;
  memo: string;
}

export interface DomainEvent<D = any> {
  seq: number;
  id: string;
  type: string;
  /** Domain time (simulated clock in the demo). */
  at: ISO;
  /** Wall-clock time when the event was written. */
  recordedAt: ISO;
  actor: string;
  actorKind: ActorKind;
  commandId?: string;
  data: D;
  postings?: Posting[];
}

// ---------- People and wallets ----------

export interface User {
  id: string;
  displayName: string;
  kind: 'demo_participant' | 'simulated_participant';
  createdAt: ISO;
}

// ---------- Miner account (FLOP identity, reused across campaigns) ----------

export interface OperatingWindow {
  campaignId: string;
  from: ISO;
  /** Undefined while the campaign is still operating the miner. */
  to?: ISO;
}

export interface MinerAccount {
  id: string;
  label: string;
  tier: 'SOFT';
  status: 'active' | 'blacklisted';
  stake: {
    requiredBaseUnits: bigint;
    supplier: string;
    supplierNote: string;
    bondNote: string;
    slashedUnits: bigint;
  };
  currentCampaignId?: string;
  windows: OperatingWindow[];
  createdAt: ISO;
}

// ---------- Campaigns ----------

export type CampaignStatus = 'funding' | 'funded' | 'running' | 'ended' | 'cancelled' | 'funding_failed';

export type OpsStatus =
  | 'not_started'
  | 'provisioning'
  | 'healthy'
  | 'recovering'
  | 'manual_intervention'
  | 'stopped';

export interface CostLine {
  key: string;
  label: string;
  units: bigint;
  note: string;
}

export interface HardwareRequirements {
  tier: 'SOFT';
  minVramGb: number;
  minReliabilityBps: number; // 9700 = 97.00%
  allowInterruptible: boolean;
  requireVerifiedHost: boolean;
  description: string;
}

export interface CampaignTerms {
  targetUnits: bigint;
  minContributionUnits: bigint;
  fundingOpensAt: ISO;
  fundingDeadline: ISO;
  termDays: number;
  allocationRule: 'pro_rata_contribution_v1';
  costLines: CostLine[];
  hardware: HardwareRequirements;
  feeModel: FeeModel;
}

export interface ExcludedOffer {
  offerId: string;
  reason: 'host_failed' | 'deploy_failed';
  at: ISO;
}

export interface CampaignOps {
  status: OpsStatus;
  activeDeploymentId?: string;
  deploymentIds: string[];
  excludedOffers: ExcludedOffer[];
  openIncidentIds: string[];
  incidentIds: string[];
  lastEvaluationId?: string;
  downSince?: ISO;
  downtimeMs: number;
}

export interface CampaignRewards {
  /** Total FLOP attributed to this campaign across all receipts. */
  receivedUnits: bigint;
  /** Portion that was liquid when received. */
  liquidAtReceiptUnits: bigint;
  /** Locked and not yet unlocked. */
  lockedRemainingUnits: bigint;
  /** Cumulative amount ever made distributable (liquid at receipt + unlocked). */
  distributableUnits: bigint;
  /** Cumulative credited to entitlements. distributable - credited = residual. */
  creditedUnits: bigint;
  claimedUnits: bigint;
  lotIds: string[];
}

export interface Settlement {
  at: ISO;
  reason: string;
  budgetUnits: bigint;
  spentUnits: bigint;
  unusedUnits: bigint;
  refundIds: string[];
  fee: FeeResult;
}

export interface Campaign {
  id: string;
  name: string;
  summary: string;
  minerId: string;
  status: CampaignStatus;
  terms: CampaignTerms;
  fundedUnits: bigint;
  contributionIds: string[];
  entitlementIds: string[];
  createdAt: ISO;
  fundingClosedAt?: ISO;
  startedAt?: ISO;
  termEndsAt?: ISO;
  endedAt?: ISO;
  cancelledAt?: ISO;
  closeReason?: string;
  ops: CampaignOps;
  spentUnits: bigint;
  refundedUnits: bigint;
  settlement?: Settlement;
  rewards: CampaignRewards;
}

export interface Contribution {
  id: string;
  campaignId: string;
  userId: string;
  amountUnits: bigint;
  at: ISO;
  status: 'accepted' | 'refunded_in_full';
}

/**
 * A frozen allocation: the right to a fixed share of a campaign's eligible rewards.
 * Separate from tokens currently available (credited/claimable).
 * Ownership history is kept for a future transfer feature; transfers are not built.
 */
export interface Entitlement {
  id: string;
  campaignId: string;
  originalHolderId: string;
  holderId: string;
  contributedUnits: bigint;
  shareNumerator: bigint;
  shareDenominator: bigint;
  frozenAt: ISO;
  status: 'active' | 'void';
  creditedUnits: bigint;
  claimedUnits: bigint;
  refundedUsdcUnits: bigint;
  ownership: { holderId: string; from: ISO; reason: 'funding_closed' }[];
}

// ---------- Orchestration ----------

export interface ProviderOffer {
  id: string;
  providerId: string;
  providerLabel: string;
  simulated: true;
  gpuModel: string;
  gpuCount: number;
  vramGb: number;
  region: string;
  hourlyUnits: bigint;
  setupFeeUnits: bigint;
  reliabilityBps: number;
  interruptible: boolean;
  verifiedHost: boolean;
  available: boolean;
  /** Scripted simulator behaviour for this offer in normal market mode. */
  simDeployOutcome: 'success' | 'fail';
  simFailureDetail?: string;
}

export interface OfferCheck {
  offerId: string;
  eligible: boolean;
  reasons: string[];
  estimatedTotalUnits: bigint;
  /** Reliability-adjusted cost: estimated total ÷ reliability. Lower is better. */
  scoreUnits: bigint;
  rank?: number;
}

export interface OfferEvaluation {
  id: string;
  campaignId: string;
  at: ISO;
  purpose: 'initial' | 'replacement' | 'manual_retry';
  remainingHours: number;
  budgetUnits: bigint;
  checks: OfferCheck[];
  selectedOfferId?: string;
  marketMode: MarketMode;
}

export type DeploymentStatus = 'requested' | 'running' | 'deploy_failed' | 'failed' | 'terminated';

export interface Deployment {
  id: string;
  campaignId: string;
  minerId: string;
  offer: Omit<ProviderOffer, 'simDeployOutcome' | 'simFailureDetail' | 'available'>;
  attempt: number;
  purpose: OfferEvaluation['purpose'];
  status: DeploymentStatus;
  requestedAt: ISO;
  runningAt?: ISO;
  endedAt?: ISO;
  instanceRef?: string;
  failure?: { kind: string; detail: string; at: ISO };
  /** Rental is metered cumulatively from runningAt to billedTo; cost = floor(rate x hours). */
  billedTo?: ISO;
  rentalCostUnits: bigint;
  setupFeeUnits: bigint;
}

export interface Incident {
  id: string;
  campaignId: string;
  kind: 'recovery_exhausted' | 'budget_exhausted' | 'miner_blacklisted';
  severity: 'critical' | 'warning';
  status: 'open' | 'acknowledged' | 'resolved';
  openedAt: ISO;
  title: string;
  detail: string;
  attempts: { deploymentId: string; offerId: string; outcome: string }[];
  escalation: { recipient: string; channel: string };
  acknowledgedAt?: ISO;
  resolvedAt?: ISO;
  resolutionNote?: string;
}

export interface Expenditure {
  id: string;
  campaignId: string;
  deploymentId: string;
  providerId: string;
  kind: 'gpu_rental' | 'setup_fee';
  units: bigint;
  at: ISO;
  periodFrom?: ISO;
  periodTo?: ISO;
}

export interface Refund {
  id: string;
  campaignId: string;
  userId: string;
  entitlementId?: string;
  units: bigint;
  reason: 'unused_budget' | 'campaign_cancelled' | 'funding_failed';
  at: ISO;
}

// ---------- Rewards ----------

export type RewardKind = 'block_reward' | 'session_payment' | 'airdrop' | 'other';

export interface RewardReceipt {
  id: string;
  minerId: string;
  kind: RewardKind;
  amountUnits: bigint;
  liquidUnits: bigint;
  lockedUnits: bigint;
  unlockedUnits: bigint;
  earnedFrom: ISO;
  earnedTo: ISO;
  externalRef: string;
  note: string;
  recordedAt: ISO;
  lotIds: string[];
}

/** The part of a receipt attributed to one campaign (or unattributed when campaignId is null). */
export interface RewardLot {
  id: string;
  receiptId: string;
  campaignId: string | null;
  overlapMs: number;
  amountUnits: bigint;
  liquidUnits: bigint;
  lockedUnits: bigint;
  lockedRemainingUnits: bigint;
}

export interface UnlockRecord {
  id: string;
  receiptId: string;
  amountUnits: bigint;
  externalRef: string;
  note: string;
  at: ISO;
  perLot: { lotId: string; campaignId: string | null; units: bigint }[];
}

export interface DistributionRecord {
  id: string;
  campaignId: string;
  at: ISO;
  trigger: { kind: 'receipt' | 'unlock'; ref: string };
  distributableBefore: bigint;
  distributableAfter: bigint;
  credits: { entitlementId: string; holderId: string; units: bigint }[];
  residualAfter: bigint;
}

export interface Claim {
  id: string;
  entitlementId: string;
  campaignId: string;
  holderId: string;
  units: bigint;
  at: ISO;
  simulatedTxRef: string;
}

// ---------- Simulation ----------

export type MarketMode = 'normal' | 'deploy_outage' | 'no_capacity';

export interface SimulationState {
  marketMode: MarketMode;
  offers: Record<string, ProviderOffer>;
}

// ---------- Root state ----------

export interface IdempotencyRecord {
  key: string;
  commandType: string;
  actor: string;
  request: string;
  result: unknown;
  seq: number;
}

export interface State {
  schemaVersion: 1;
  seq: number;
  clock: ISO;
  balances: Record<string, Partial<Record<Asset, bigint>>>;
  postingCount: number;
  users: Record<string, User>;
  miners: Record<string, MinerAccount>;
  campaigns: Record<string, Campaign>;
  contributions: Record<string, Contribution>;
  entitlements: Record<string, Entitlement>;
  evaluations: Record<string, OfferEvaluation>;
  deployments: Record<string, Deployment>;
  incidents: Record<string, Incident>;
  expenditures: Record<string, Expenditure>;
  refunds: Record<string, Refund>;
  receipts: Record<string, RewardReceipt>;
  lots: Record<string, RewardLot>;
  unlocks: Record<string, UnlockRecord>;
  distributions: Record<string, DistributionRecord>;
  claims: Record<string, Claim>;
  externalRefs: Record<string, string>;
  idempotency: Record<string, IdempotencyRecord>;
  sim: SimulationState;
}
