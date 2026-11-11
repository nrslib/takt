import { describe, expect, it } from 'vitest';
import { EpicSchema, EpicVerificationResultSchema } from '../infra/epics/schema.js';
import { epicDefinition, epicRecord, epicVerificationResult } from './helpers/epic-fixtures.js';

describe('Epic persistence schema', () => {
  it('preserves workspace ownership, definition, members, evidence and reasons', () => {
    const record = epicRecord();
    expect(EpicSchema.parse(record)).toEqual(record);
  });

  it.each(['active', 'aborted'])('represents the %s lifecycle state', (status) => {
    expect(EpicSchema.safeParse({ ...epicRecord(), status }).success).toBe(true);
  });

  it('rejects an unknown lifecycle state', () => {
    expect(EpicSchema.safeParse({ ...epicRecord(), status: 'running' }).success).toBe(false);
  });

  it.each([true, false])('requires Terraform records for results started with requiresApply=%s', (requiresApply) => {
    const result = epicVerificationResult();
    const definition = {
      ...epicDefinition(),
      verificationProcedure: { ...epicDefinition().verificationProcedure, terraform: { requiresApply } },
    };
    const record = {
      ...epicRecord(), ...definition,
      verificationRuns: [{
        id: result.runId, revision: result.revision, targets: result.targets, definition,
        procedureVersion: result.procedureVersion, startedAt: result.startedAt, status: 'succeeded', result,
      }],
    };
    for (const status of ['succeeded', 'failed', 'stale']) {
      const outcome = status === 'failed' ? 'failed' : 'succeeded';
      expect(EpicSchema.safeParse({ ...record, verificationRuns: [{ ...record.verificationRuns[0], status, result: { ...result, outcome } }] }).success).toBe(false);
    }
    const terraform = { phase: 'post_apply', applyStatus: 'applied', artifactReferences: ['artifact://terraform/state'] };
    expect(EpicSchema.safeParse({ ...record, verificationRuns: [{ ...record.verificationRuns[0], result: { ...result, terraform } }] }).success).toBe(true);
    expect(EpicSchema.safeParse({ ...record, verificationRuns: [{ ...record.verificationRuns[0], result: undefined, status: 'running' }] }).success).toBe(true);
  });
});

describe('Epic verification evidence schema', () => {
  it('roundtrips execution identity, fixed sources, environment, artifacts, times, conditions and logs', () => {
    const result = epicVerificationResult();
    expect(EpicVerificationResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    'runId', 'revision', 'targets', 'procedureVersion', 'startedAt', 'completedAt',
    'outcome', 'environment', 'artifacts', 'workspace', 'acceptanceResults',
  ])('rejects evidence missing %s', (field) => {
    const result: Record<string, unknown> = epicVerificationResult();
    delete result[field];
    expect(EpicVerificationResultSchema.safeParse(result).success).toBe(false);
  });

  it('preserves structured Terraform plan evidence separately from applied verification', () => {
    const result = {
      ...epicVerificationResult(),
      terraform: { phase: 'plan', applyStatus: 'not_applied', artifactReferences: ['artifact://terraform/plan'] },
    };
    expect(EpicVerificationResultSchema.parse(result)).toEqual(result);
  });

  it('preserves Terraform environment and applied artifacts after integration verification', () => {
    const result = {
      ...epicVerificationResult(),
      terraform: { phase: 'post_apply', applyStatus: 'applied', artifactReferences: ['artifact://terraform/applied-state'] },
    };
    expect(EpicVerificationResultSchema.parse(result)).toEqual(result);
  });

  it.each(['phase', 'applyStatus', 'artifactReferences'])('rejects Terraform records missing %s', (field) => {
    const terraform: Record<string, unknown> = {
      phase: 'plan', applyStatus: 'not_applied', artifactReferences: ['artifact://terraform/plan'],
    };
    delete terraform[field];
    expect(EpicVerificationResultSchema.safeParse({ ...epicVerificationResult(), terraform }).success).toBe(false);
  });
});
