// Adapter boundary between the orchestrator and GPU providers.
//
// The prototype ships only `SimulatedProvider`. A real adapter (Vast.ai, Runpod,
// ...) would implement this interface with network calls. Real calls are async;
// the orchestrator already persists each step (deployment.requested ->
// deployment.running / deployment.start_failed) as separate events, so moving to
// an async job runner means completing those events from a worker instead of
// inline. Provider credentials belong to the adapter only. They are never
// visible to reward accounting or settlement, and the orchestrator's ledger
// rights are limited to paying providers from a campaign budget (see
// accounts.ts POSTING_POLICY).

import type { ProviderOffer } from '../types';

export interface WorkloadSpec {
  minerAccountId: string;
  tier: 'SOFT';
  /** The FLOP miner runtime packaging is not defined yet. */
  image: string;
}

export type DeployOutcome = { ok: true; instanceRef: string } | { ok: false; kind: string; detail: string };

export interface ComputeProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly simulated: boolean;
  /** Whether credentials/configuration are present. Missing credentials disable the adapter, nothing else. */
  readonly configured: boolean;
  listOffers(): ProviderOffer[];
  deploy(offer: ProviderOffer, spec: WorkloadSpec, deploymentId: string): DeployOutcome;
  terminate(instanceRef: string): void;
}

export const WORKLOAD_SPEC_NOTE =
  'Workload image is a placeholder: the FLOP miner runtime packaging and configuration have not been verified.';
