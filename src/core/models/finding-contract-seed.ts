import type { FindingContractLedgerRegistries } from './finding-contract-types.js';

export function createEmptyFindingContractRegistries(): FindingContractLedgerRegistries {
  return {
    rawCanonicalSnapshots: [],
    conflictRawClaimLandings: [],
    conflictAdjudicationSnapshots: [],
    conflictAdjudicationEpisodes: [],
    conflictAdjudicationAttempts: [],
    conflictClaimSettlements: [],
    provisionalConflictNormalizationSnapshots: [],
    provisionalConflictNormalizations: [],
    interpretationCaseSnapshots: [],
    interpretationRawObservations: [],
    interpretationRecoveryOriginBindings: [],
    interpretationRecoveryOriginSettlements: [],
    interpretationAttempts: [],
    rawInterpretationOutcomes: [],
    findingManagerProviderBudgetScopes: [],
    findingManagerProviderCalls: [],
    findingScopeBindings: [],
    terminalAdjudicationRounds: [],
    terminalAdjudicationEpisodes: [],
    terminalAdjudicationAttempts: [],
    terminalAdjudicationSettlements: [],
  };
}

export function projectFindingContractRegistries(
  input: FindingContractLedgerRegistries,
): FindingContractLedgerRegistries {
  return {
    rawCanonicalSnapshots: input.rawCanonicalSnapshots,
    conflictRawClaimLandings: input.conflictRawClaimLandings,
    conflictAdjudicationSnapshots: input.conflictAdjudicationSnapshots,
    conflictAdjudicationEpisodes: input.conflictAdjudicationEpisodes,
    conflictAdjudicationAttempts: input.conflictAdjudicationAttempts,
    conflictClaimSettlements: input.conflictClaimSettlements,
    provisionalConflictNormalizationSnapshots: input.provisionalConflictNormalizationSnapshots,
    provisionalConflictNormalizations: input.provisionalConflictNormalizations,
    interpretationCaseSnapshots: input.interpretationCaseSnapshots,
    interpretationRawObservations: input.interpretationRawObservations,
    interpretationRecoveryOriginBindings: input.interpretationRecoveryOriginBindings,
    interpretationRecoveryOriginSettlements: input.interpretationRecoveryOriginSettlements,
    interpretationAttempts: input.interpretationAttempts,
    rawInterpretationOutcomes: input.rawInterpretationOutcomes,
    findingManagerProviderBudgetScopes: input.findingManagerProviderBudgetScopes,
    findingManagerProviderCalls: input.findingManagerProviderCalls,
    findingScopeBindings: input.findingScopeBindings,
    terminalAdjudicationRounds: input.terminalAdjudicationRounds,
    terminalAdjudicationEpisodes: input.terminalAdjudicationEpisodes,
    terminalAdjudicationAttempts: input.terminalAdjudicationAttempts,
    terminalAdjudicationSettlements: input.terminalAdjudicationSettlements,
  };
}
