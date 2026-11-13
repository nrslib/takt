import { isDeepStrictEqual } from 'node:util';
import {
  EpicDefinitionSchema, EpicSchema, EpicVerificationResultSchema,
  type Epic, type EpicChange, type EpicDefinition, type EpicTarget,
  type EpicVerificationResult, type EpicVerificationRun, type EpicView,
} from './schema.js';
import { normalizeTargets, sameTargets, memberKey } from './targetIdentity.js';

export function epicDefinition(epic: Epic): EpicDefinition {
  return { objective: epic.objective, acceptanceCriteria: epic.acceptanceCriteria, verificationProcedure: epic.verificationProcedure };
}

export function assertEpicMutable(epic: Epic): void {
  if (epic.status === 'aborted') throw new Error('An aborted Epic cannot be changed');
}

export function reviseEpic(epic: Epic, changes: Partial<EpicDefinition> & { members?: Epic['members']; targets?: EpicTarget[] }, change: EpicChange): Epic {
  assertEpicMutable(epic);
  const definition = EpicDefinitionSchema.parse({
    objective: changes.objective === undefined ? epic.objective : changes.objective,
    acceptanceCriteria: changes.acceptanceCriteria === undefined ? epic.acceptanceCriteria : changes.acceptanceCriteria,
    verificationProcedure: changes.verificationProcedure === undefined ? epic.verificationProcedure : changes.verificationProcedure,
  });
  const targets = changes.targets === undefined ? epic.targets : normalizeTargets(changes.targets);
  const recorded = {
    ...change,
    ...(change.kind === 'definition' ? { definition } : {}),
    ...(change.kind === 'targets' ? { targets } : {}),
  };
  return EpicSchema.parse({
    ...epic, ...definition,
    members: changes.members === undefined ? epic.members : changes.members,
    targets,
    revision: epic.revision + 1, status: 'active',
    verificationRuns: epic.verificationRuns.map((run) => run.invalidationReason !== undefined ? run : {
      ...run, invalidationReason: change.reason, status: run.status === 'running' ? 'superseded' : run.status,
    }),
    changes: [...epic.changes, recorded],
  });
}

function hasCompleteAcceptanceResults(run: EpicVerificationRun, result: EpicVerificationResult): boolean {
  const criteria = run.definition.acceptanceCriteria;
  const resultIds = new Set(result.acceptanceResults.map(({ criterionId }) => criterionId));
  return result.acceptanceResults.length === criteria.length && resultIds.size === criteria.length
    && criteria.every(({ id }) => resultIds.has(id));
}

function resultHasEvidence(run: EpicVerificationRun): boolean {
  const result = run.result;
  if (result === undefined || result.outcome !== 'succeeded') return false;
  if (result.runId !== run.id || result.revision !== run.revision || result.procedureVersion !== run.procedureVersion
    || result.startedAt !== run.startedAt || !sameTargets(result.targets, run.targets)) return false;
  if (!hasCompleteAcceptanceResults(run, result)
    || result.acceptanceResults.some((entry) => entry.outcome !== 'passed')) return false;
  const sourceTargets = result.artifacts.flatMap(({ sources }) => sources);
  if (sourceTargets.some((source) => !run.targets.some((target) => isDeepStrictEqual(source, target)))
    || run.targets.some((target) => !sourceTargets.some((source) => isDeepStrictEqual(source, target)))) return false;
  if (result.workspace.artifactReferences.some((reference) => !result.artifacts.some((artifact) => artifact.reference === reference))) return false;
  const terraform = result.terraform;
  if (run.definition.verificationProcedure.terraform !== undefined && terraform === undefined) return false;
  if (run.definition.verificationProcedure.terraform?.requiresApply === true
    && (terraform?.phase !== 'post_apply' || terraform.applyStatus !== 'applied')) return false;
  return true;
}

function currentVerificationRuns(epic: Epic): EpicVerificationRun[] {
  return epic.verificationRuns.filter((run) => run.invalidationReason === undefined
    && run.revision === epic.revision && sameTargets(run.targets, epic.targets)
    && isDeepStrictEqual(run.definition, epicDefinition(epic)));
}

export function epicView(epic: Epic): EpicView {
  const current = currentVerificationRuns(epic);
  const currentEvidence = epic.status === 'aborted' ? undefined : current.filter((run) => run.status === 'succeeded' && resultHasEvidence(run)).at(-1);
  const runningVerification = epic.status === 'active' ? current.find((run) => run.status === 'running') : undefined;
  return { ...epic, ...(currentEvidence === undefined ? {} : { currentEvidence }), ...(runningVerification === undefined ? {} : { runningVerification }) };
}

export function beginEpicVerification(epic: Epic, id: string, startedAt: string): { epic: Epic; run: EpicVerificationRun } {
  if (epic.status !== 'active') throw new Error('Only an active Epic can start verification');
  assertFixedTargets(epic);
  if (epicView(epic).runningVerification !== undefined) throw new Error('Epic verification is already running');
  if (epic.verificationRuns.some((run) => run.id === id)) throw new Error(`Verification run already exists: ${id}`);
  const run: EpicVerificationRun = {
    id, revision: epic.revision, targets: normalizeTargets(epic.targets), definition: epicDefinition(epic),
    procedureVersion: epic.verificationProcedure.version, startedAt, status: 'running',
  };
  const next = EpicSchema.parse({ ...epic, verificationRuns: [...epic.verificationRuns, run] });
  return { epic: next, run: next.verificationRuns.at(-1)! };
}

function assertFixedTargets(epic: Epic): void {
  if (epic.members.length === 0 || epic.targets.length !== epic.members.length
    || epic.members.some((member) => !epic.targets.some((target) => memberKey(target) === memberKey(member)))) {
    throw new Error('Every Epic member needs a completed target');
  }
}

function normalizeResult(input: EpicVerificationResult): EpicVerificationResult {
  const result = EpicVerificationResultSchema.parse(input);
  return { ...result, targets: normalizeTargets(result.targets), artifacts: result.artifacts.map((artifact) => ({
    ...artifact, sources: normalizeTargets(artifact.sources),
  })) };
}

export function applyEpicVerificationResult(epic: Epic, input: EpicVerificationResult): Epic {
  const result = normalizeResult(input);
  const run = epic.verificationRuns.find(({ id }) => id === result.runId);
  if (run === undefined) throw new Error(`Unknown Epic verification run: ${result.runId}`);
  if (run.revision !== result.revision || run.procedureVersion !== result.procedureVersion
    || run.startedAt !== result.startedAt || !sameTargets(run.targets, result.targets)) throw new Error('Verification result differs from its start record');
  if (!hasCompleteAcceptanceResults(run, result)) throw new Error('Verification results must include every start criterion exactly once');
  if (run.result !== undefined) {
    if (!isDeepStrictEqual(normalizeResult(run.result), result)) throw new Error('Conflicting result for the same verification run');
    return epic;
  }
  const stale = epic.status === 'aborted' || run.invalidationReason !== undefined || run.revision !== epic.revision
    || !sameTargets(run.targets, epic.targets) || !isDeepStrictEqual(run.definition, epicDefinition(epic));
  return EpicSchema.parse({ ...epic, verificationRuns: epic.verificationRuns.map((entry) => entry.id !== run.id ? entry : {
    ...entry, result, status: stale ? 'stale' : result.outcome,
  }) });
}

export function finishEpic(epic: Epic): Epic {
  assertEpicMutable(epic);
  assertFixedTargets(epic);
  if (currentVerificationRuns(epic).some((run) => run.status === 'running')) throw new Error('Epic verification is still running');
  if (epicView(epic).currentEvidence === undefined) throw new Error('Epic requires current successful verification evidence');
  return epic.status === 'completed' ? epic : EpicSchema.parse({ ...epic, status: 'completed' });
}

export function abortEpicState(epic: Epic, change: EpicChange): Epic {
  if (epic.status === 'aborted') return epic;
  const invalidated = reviseEpic(epic, {}, change);
  return EpicSchema.parse({ ...invalidated, revision: epic.revision, status: 'aborted' });
}

export function epicVerificationRecovery(epic: Epic): EpicVerificationRun[] {
  const running = epicView(epic).runningVerification;
  return running === undefined ? [] : [running];
}
