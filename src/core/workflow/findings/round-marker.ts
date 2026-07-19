export interface RoundIdentity {
  runId: string;
  callNamespace: string;
  parentStepName: string;
  stepIteration: number;
}

export function computeRoundMarker(identity: RoundIdentity): string {
  return [identity.runId, identity.callNamespace, identity.parentStepName, identity.stepIteration].join('\0');
}

export function addRoundMarker(existing: readonly string[] | undefined, marker: string): string[] {
  return [...new Set([...(existing ?? []), marker])].sort();
}
