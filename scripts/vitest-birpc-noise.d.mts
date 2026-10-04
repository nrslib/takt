export declare const BIRPC_REMEASURE_ON_CI_ENV: "TAKT_BIRPC_REMEASURE_ON_CI";
export function isBirpcNoiseOnlyFailure(input: {
  readonly output: string;
  readonly isCI: boolean;
  readonly remeasureOnCI: boolean;
}): boolean;
