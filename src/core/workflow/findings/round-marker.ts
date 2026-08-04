import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

export interface RoundIdentity {
  runId: string;
  callNamespace: string;
  parentStepName: string;
  stepIteration: number;
  publicationIds: readonly string[];
}

export function computeRoundMarker(identity: RoundIdentity): string {
  return [
    identity.runId,
    identity.callNamespace,
    identity.parentStepName,
    identity.stepIteration,
    ...[...identity.publicationIds].sort(compareBinaryStrings),
  ].join('\0');
}

export function addRoundMarker(existing: readonly string[] | undefined, marker: string): string[] {
  return [...new Set([...(existing ?? []), marker])].sort(compareBinaryStrings);
}
