import type { ProviderUsageSnapshot } from '../../models/response.js';

export class FindingContractAttemptUsageRecorder {
  private readonly recordedAttemptTokens = new Set<string>();

  record(
    attemptToken: string,
    usage: ProviderUsageSnapshot | undefined,
    publish: (usage: ProviderUsageSnapshot) => void,
  ): void {
    if (usage === undefined || this.recordedAttemptTokens.has(attemptToken)) return;
    this.recordedAttemptTokens.add(attemptToken);
    publish(usage);
  }
}
