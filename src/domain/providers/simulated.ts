// Simulated GPU marketplace. Every offer, price, and outcome here is illustrative
// and scripted. Nothing is fetched from a real provider, and no machine is rented.

import { usdc } from '../money';
import type { ProviderOffer, SimulationState } from '../types';
import type { ComputeProviderAdapter, DeployOutcome, WorkloadSpec } from './types';

const A = { providerId: 'sim-a', providerLabel: 'Simulated marketplace A' } as const;
const B = { providerId: 'sim-b', providerLabel: 'Simulated marketplace B' } as const;

function offer(o: Omit<ProviderOffer, 'simulated' | 'setupFeeUnits' | 'available' | 'simDeployOutcome'> & Partial<ProviderOffer>): ProviderOffer {
  return {
    simulated: true,
    setupFeeUnits: usdc('0.50'),
    available: true,
    simDeployOutcome: 'success',
    ...o,
  };
}

export function initialSimOffers(): ProviderOffer[] {
  return [
    offer({ id: 'O-101', ...A, gpuModel: 'RTX 4090', gpuCount: 1, vramGb: 24, region: 'eu-west', hourlyUnits: usdc('0.39'), reliabilityBps: 9200, interruptible: true, verifiedHost: false }),
    offer({ id: 'O-102', ...A, gpuModel: 'RTX 6000 Ada', gpuCount: 1, vramGb: 48, region: 'us-east', hourlyUnits: usdc('0.99'), reliabilityBps: 9820, interruptible: false, verifiedHost: true }),
    offer({ id: 'O-103', ...B, gpuModel: 'A100 80GB PCIe', gpuCount: 1, vramGb: 80, region: 'us-central', hourlyUnits: usdc('1.49'), reliabilityBps: 9500, interruptible: true, verifiedHost: true }),
    offer({ id: 'O-104', ...B, gpuModel: 'A100 80GB SXM', gpuCount: 1, vramGb: 80, region: 'eu-central', hourlyUnits: usdc('1.89'), reliabilityBps: 9760, interruptible: false, verifiedHost: true }),
    offer({ id: 'O-105', ...A, gpuModel: 'H100 80GB PCIe', gpuCount: 1, vramGb: 80, region: 'us-west', hourlyUnits: usdc('2.19'), reliabilityBps: 9610, interruptible: false, verifiedHost: true }),
    offer({
      id: 'O-106', ...B, gpuModel: 'H100 80GB SXM', gpuCount: 1, vramGb: 80, region: 'ap-northeast', hourlyUnits: usdc('2.69'), reliabilityBps: 9930, interruptible: false, verifiedHost: true,
      simDeployOutcome: 'fail', simFailureDetail: 'Scripted failure: workload health check timed out after image pull.',
    }),
    offer({ id: 'O-107', ...A, gpuModel: 'H200 141GB', gpuCount: 1, vramGb: 141, region: 'us-east', hourlyUnits: usdc('3.69'), reliabilityBps: 9950, interruptible: false, verifiedHost: true }),
    offer({ id: 'O-108', ...B, gpuModel: 'H100 80GB SXM', gpuCount: 1, vramGb: 80, region: 'eu-north', hourlyUnits: usdc('2.49'), reliabilityBps: 9840, interruptible: false, verifiedHost: false }),
  ];
}

/** Offers the demo can bring online later ("new simulated capacity"). */
export function reserveSimOffers(): ProviderOffer[] {
  return [
    offer({ id: 'O-109', ...A, gpuModel: 'A100 80GB PCIe', gpuCount: 1, vramGb: 80, region: 'us-central', hourlyUnits: usdc('1.99'), reliabilityBps: 9800, interruptible: false, verifiedHost: true }),
    offer({ id: 'O-110', ...B, gpuModel: 'H100 80GB PCIe', gpuCount: 1, vramGb: 80, region: 'eu-west', hourlyUnits: usdc('2.29'), reliabilityBps: 9880, interruptible: false, verifiedHost: true }),
    offer({ id: 'O-111', ...A, gpuModel: 'L40S 48GB ×2', gpuCount: 2, vramGb: 96, region: 'us-east', hourlyUnits: usdc('1.79'), reliabilityBps: 9790, interruptible: false, verifiedHost: true }),
  ];
}

export class SimulatedProvider implements ComputeProviderAdapter {
  readonly id = 'simulated';
  readonly label = 'Simulated provider adapter (scripted, no real machines)';
  readonly simulated = true;
  readonly configured = true;

  constructor(private readonly sim: () => SimulationState) {}

  listOffers(): ProviderOffer[] {
    const s = this.sim();
    return Object.values(s.offers).map((o) => ({ ...o, available: s.marketMode === 'no_capacity' ? false : o.available }));
  }

  deploy(offer: ProviderOffer, _spec: WorkloadSpec, deploymentId: string): DeployOutcome {
    const s = this.sim();
    if (s.marketMode === 'deploy_outage') {
      return { ok: false, kind: 'provider_api_error', detail: 'Simulated provider outage: deployment API returned errors.' };
    }
    if (s.marketMode === 'no_capacity' || !offer.available) {
      return { ok: false, kind: 'capacity_unavailable', detail: 'Simulated: offer was taken before the deployment started.' };
    }
    if (offer.simDeployOutcome === 'fail') {
      return { ok: false, kind: 'health_check_timeout', detail: offer.simFailureDetail ?? 'Scripted deployment failure.' };
    }
    return { ok: true, instanceRef: `sim-instance-${deploymentId}` };
  }

  terminate(_instanceRef: string): void {
    // Nothing to release in the simulator.
  }
}

/**
 * Real provider adapters are not implemented. This shows how they would report
 * missing credentials without blocking the rest of the system.
 */
export function realProviderStatus(env: Record<string, string | undefined>) {
  return [
    { id: 'vast', label: 'Vast.ai adapter', implemented: false, configured: Boolean(env.VAST_API_KEY), credentialEnv: 'VAST_API_KEY' },
    { id: 'runpod', label: 'Runpod adapter', implemented: false, configured: Boolean(env.RUNPOD_API_KEY), credentialEnv: 'RUNPOD_API_KEY' },
  ];
}
