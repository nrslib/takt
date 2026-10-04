import type { PreparedLiveInterventionDelivery } from '../live-intervention/types.js';
import type { Phase1ReportInputs } from './prepared-instruction.js';

/** Keeps only the live instruction bodies dispatched within one Phase 1 operation. */
export class Phase1ReportInputTracker {
  private readonly deliveries = new Set<PreparedLiveInterventionDelivery>();

  constructor(private inputs: Phase1ReportInputs | undefined) {}

  recordDelivery(delivery: PreparedLiveInterventionDelivery | undefined): void {
    if (delivery === undefined || this.deliveries.has(delivery)) return;
    this.deliveries.add(delivery);
    this.inputs = {
      ...this.inputs,
      userInputs: [...(this.inputs?.userInputs ?? []), delivery.prompt],
    };
  }

  snapshot(): Phase1ReportInputs | undefined {
    return this.inputs;
  }
}
