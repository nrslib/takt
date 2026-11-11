import { describe, expect, it } from 'vitest';
import { EpicSchema, type Epic } from '../infra/epics/schema.js';
import {
  abortEpicState, applyEpicVerificationResult, assertEpicMutable, beginEpicVerification,
  epicDefinition as definitionOf, epicVerificationRecovery, epicView, finishEpic, reviseEpic,
} from '../infra/epics/state.js';
import { epicDefinition, epicRecord, secondGoalId, verificationResultFor, verificationRunId, verificationStartedAt } from './helpers/epic-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const member = { repositoryDirectory: '/repositories/api', goalId: goalRecord().id };
const target = { ...member, targetSha: 'b'.repeat(40) };
const reason = { kind: 'definition' as const, reason: '受入条件を更新した', recordedAt: verificationStartedAt };

function readyEpic(): Epic {
  return EpicSchema.parse({ ...epicRecord(), members: [member], targets: [target] });
}

function verifiedEpic(): Epic {
  const started = beginEpicVerification(readyEpic(), verificationRunId, verificationStartedAt);
  return applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
}

describe('Epic domain transitions', () => {
  it('extracts the verification definition without persistence and lifecycle fields', () => {
    expect(definitionOf(readyEpic())).toEqual(epicDefinition());
  });

  it('starts a verification against the exact definition, revision and fixed targets', () => {
    const epic = readyEpic();
    const started = beginEpicVerification(epic, verificationRunId, verificationStartedAt);
    expect(started.run).toMatchObject({ revision: epic.revision, targets: [target], definition: epicDefinition(), status: 'running' });
    expect(epic.verificationRuns).toEqual([]);
    expect(epicVerificationRecovery(started.epic)).toEqual([started.run]);
  });

  it('rejects another start while the current verification is running', () => {
    const { epic } = beginEpicVerification(readyEpic(), verificationRunId, verificationStartedAt);
    expect(() => beginEpicVerification(epic, goalRecord().id, verificationStartedAt)).toThrow();
  });

  it('completes only with current successful evidence and is idempotent', () => {
    const verified = verifiedEpic();
    expect(verified.status).toBe('active');
    expect(epicVerificationRecovery(verified)).toEqual([]);
    const completed = finishEpic(verified);
    expect(completed.status).toBe('completed');
    expect(finishEpic(completed)).toEqual(completed);
    expect(() => finishEpic(readyEpic())).toThrow();
  });

  it('rejects completion during re-verification without changing successful evidence or running history', () => {
    const verified = verifiedEpic();
    const started = beginEpicVerification(verified, secondGoalId, verificationStartedAt);
    const before = structuredClone(started.epic);
    expect(epicView(started.epic).currentEvidence).toEqual(epicView(verified).currentEvidence);

    expect(() => finishEpic(started.epic)).toThrow();
    expect(started.epic).toEqual(before);
    expect(epicView(started.epic).runningVerification).toEqual(started.run);
    expect(epicVerificationRecovery(started.epic)).toEqual([started.run]);

    const finished = applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
    expect(epicVerificationRecovery(finished)).toEqual([]);
    const completed = finishEpic(finished);
    expect(completed.status).toBe('completed');
    expect(finishEpic(completed)).toEqual(completed);
    expect(completed.verificationRuns[0]).toEqual(verified.verificationRuns[0]);
  });

  it('invalidates evidence on the same completed Epic while preserving historical results', () => {
    const completed = finishEpic(verifiedEpic());
    const changed = reviseEpic(completed, { acceptanceCriteria: [{ id: 'api', description: '新しい条件' }] }, reason);
    expect(changed.revision).toBe(completed.revision + 1);
    expect(changed.status).toBe('active');
    expect(epicView(changed).currentEvidence).toBeUndefined();
    expect(changed.verificationRuns[0]?.result).toEqual(completed.verificationRuns[0]?.result);
    expect(changed.verificationRuns[0]?.invalidationReason).toBe(reason.reason);
    expect(epicView(completed).currentEvidence).toBeDefined();
  });

  it.each([true, false])('rejects missing Terraform evidence without changing history when requiresApply=%s', (requiresApply) => {
    const epic = EpicSchema.parse({ ...readyEpic(), verificationProcedure: {
      ...readyEpic().verificationProcedure, terraform: { requiresApply },
    } });
    const terraform = requiresApply
      ? { phase: 'post_apply' as const, applyStatus: 'applied' as const, artifactReferences: ['artifact://terraform/state'] }
      : { phase: 'plan' as const, applyStatus: 'not_applied' as const, artifactReferences: ['artifact://terraform/plan'] };
    const first = beginEpicVerification(epic, verificationRunId, verificationStartedAt);
    const verified = applyEpicVerificationResult(first.epic, { ...verificationResultFor(first.run), terraform });
    const second = beginEpicVerification(verified, secondGoalId, verificationStartedAt);
    const before = structuredClone(second.epic);
    expect(() => applyEpicVerificationResult(second.epic, verificationResultFor(second.run))).toThrow();
    expect(second.epic).toEqual(before);
    expect(epicView(second.epic).currentEvidence).toEqual(epicView(verified).currentEvidence);
    expect(epicVerificationRecovery(second.epic)).toEqual([second.run]);

    const incomplete = { ...verified, verificationRuns: verified.verificationRuns.map((run) => ({
      ...run, result: verificationResultFor(run),
    })) };
    expect(epicView(incomplete).currentEvidence).toBeUndefined();
    expect(() => finishEpic(incomplete)).toThrow();

    const received = applyEpicVerificationResult(second.epic, { ...verificationResultFor(second.run), terraform });
    expect(epicView(received).currentEvidence?.result?.terraform).toEqual(terraform);
    expect(finishEpic(received).status).toBe('completed');
    expect(received.verificationRuns[0]).toEqual(verified.verificationRuns[0]);
  });

  it.each([true, false])('checks the start definition for stale Terraform results with requiresApply=%s', (requiresApply) => {
    const epic = EpicSchema.parse({ ...readyEpic(), verificationProcedure: {
      ...readyEpic().verificationProcedure, terraform: { requiresApply },
    } });
    const started = beginEpicVerification(epic, verificationRunId, verificationStartedAt);
    const changed = reviseEpic(started.epic, { verificationProcedure: readyEpic().verificationProcedure }, reason);
    const before = structuredClone(changed);
    expect(() => applyEpicVerificationResult(changed, verificationResultFor(started.run))).toThrow();
    expect(changed).toEqual(before);
    const received = applyEpicVerificationResult(changed, { ...verificationResultFor(started.run), terraform: {
      phase: 'plan', applyStatus: 'not_applied', artifactReferences: ['artifact://terraform/plan'],
    } });
    expect(received.verificationRuns[0]?.status).toBe('stale');
    expect(epicView(received).currentEvidence).toBeUndefined();
    expect(() => finishEpic(received)).toThrow();
  });

  it('supersedes a running verification and records a later result as stale', () => {
    const { epic, run } = beginEpicVerification(readyEpic(), verificationRunId, verificationStartedAt);
    const changed = reviseEpic(epic, { verificationProcedure: { version: 2, steps: ['更新した確認'] } }, reason);
    expect(epicView(changed).runningVerification).toBeUndefined();
    const received = applyEpicVerificationResult(changed, verificationResultFor(run));
    expect(received.verificationRuns[0]?.status).toBe('stale');
    expect(epicView(received).currentEvidence).toBeUndefined();
    expect(() => finishEpic(received)).toThrow();
  });

  it('rejects duplicate and conflicting execution identities without replacing history', () => {
    const epic = verifiedEpic();
    const run = epic.verificationRuns[0]!;
    const result = verificationResultFor(run);
    expect(applyEpicVerificationResult(epic, result)).toEqual(epic);
    expect(() => applyEpicVerificationResult(epic, { ...result, outcome: 'failed' })).toThrow();
    expect(() => beginEpicVerification(epic, run.id, verificationStartedAt)).toThrow();
  });

  it.each(['missing criterion', 'unrelated artifact', 'unrelated workspace artifact', 'Terraform plan'] as const)('does not treat %s as completion evidence', (condition) => {
    let epic = readyEpic();
    if (condition === 'Terraform plan') epic = EpicSchema.parse({ ...epic, verificationProcedure: {
      ...epic.verificationProcedure, terraform: { requiresApply: true },
    } });
    const started = beginEpicVerification(epic, verificationRunId, verificationStartedAt);
    const result = {
      ...verificationResultFor(started.run),
      ...(condition === 'missing criterion' ? { acceptanceResults: [{ criterionId: 'api', outcome: 'passed' as const }] } : {}),
      ...(condition === 'unrelated artifact' ? { artifacts: [{ reference: 'artifact://integration/build-1', sources: [{ ...target, targetSha: 'c'.repeat(40) }] }] } : {}),
      ...(condition === 'unrelated workspace artifact' ? { workspace: { directory: '/temporary/integration', artifactReferences: ['artifact://unrelated'] } } : {}),
      ...(condition === 'Terraform plan' ? { terraform: { phase: 'plan' as const, applyStatus: 'not_applied' as const, artifactReferences: ['artifact://plan'] } } : {}),
    };
    expect(() => finishEpic(applyEpicVerificationResult(started.epic, result))).toThrow();
  });

  it('aborts only the Epic and refuses subsequent definition changes', () => {
    const epic = verifiedEpic();
    const aborted = abortEpicState(epic, { ...reason, kind: 'aborted' });
    expect(aborted.status).toBe('aborted');
    expect(aborted.members).toEqual(epic.members);
    expect(epicView(aborted).currentEvidence).toBeUndefined();
    expect(() => assertEpicMutable(aborted)).toThrow();
    expect(abortEpicState(aborted, { ...reason, kind: 'aborted' })).toEqual(aborted);
  });
});
