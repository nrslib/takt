import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  freshConflictAdjudicationSnapshot,
  refreshActiveConflictAdjudicationSnapshots,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { WorkflowEngine } from './helpers/workflow-engine.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { verifiedFindingEvidenceFixture } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import { makeRule, makeStep } from './test-helpers.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/phase-runner.js')>();
  return {
    ...actual,
    runReportPhase: vi.fn().mockResolvedValue(undefined),
    runStatusJudgmentPhase: vi.fn().mockResolvedValue(undefined),
  };
});

const OBSERVATION = {
  runId: 'run-0',
  stepName: 'reviewers',
  timestamp: '2026-06-13T00:00:00.000Z',
};

function isAdjudicationSchema(outputSchema: unknown): boolean {
  const schemaText = JSON.stringify(outputSchema);
  return schemaText.includes('terminate_subject') && schemaText.includes('undetermined');
}

function createTestTmpDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-adjudication-engine-'));
  mkdirSync(join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(cwd, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(cwd, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(cwd, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(cwd, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'personas'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const value = true;\n');
  writeFileSync(join(cwd, 'personas', 'supervisor.md'), '# Supervisor\n');
  initializeGitFixture(cwd, ['src/a.ts', 'personas/supervisor.md']);
  return cwd;
}

function createLedgerStore(cwd: string): FindingLedgerStore {
  return createTestFindingLedgerStore({
    projectCwd: cwd,
    runId: 'test-report-dir',
    reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
    workflowName: 'adjudication-engine-test',
  });
}

function workflowConfig(cwd: string): WorkflowConfig {
  return {
    name: 'adjudication-engine-test',
    maxSteps: 4,
    initialStep: 'finding-conflict-adjudication',
    provider: 'claude',
    findingContract: {
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
      adjudicator: {
        persona: 'supervisor',
        personaPath: join(cwd, 'personas', 'supervisor.md'),
        personaDisplayName: 'supervisor',
        providerRoutingPersonaKey: 'supervisor',
      },
    },
    steps: [makeStep({
      name: 'reviewers',
      persona: 'coding-reviewer',
      instruction: 'Review the code.',
      rules: [
        makeRule(
          'when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)',
          'finding-conflict-adjudication',
        ),
        makeRule('when(findings.conflicts.count > 0)', 'ABORT'),
        makeRule('approved', 'COMPLETE'),
      ],
    })],
  };
}

async function seedLedger(cwd: string): Promise<FindingLedgerStore> {
  const evidence = verifiedFindingEvidenceFixture({
    cwd,
    path: 'src/a.ts',
    startLine: 1,
    title: 'Disputed issue',
    description: 'Reviewers disagree about F-0001.',
    familyTag: 'bug',
    targetFindingId: 'F-0001',
  });
  const authorized = authorizeFindingLedgerFixture({
    workflowName: 'adjudication-engine-test',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: 'Disputed issue',
      description: 'Reviewers disagree about F-0001.',
      evidenceIds: [evidence.record.evidenceId],
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-1'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
    }],
    rawFindings: [{
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Disputed issue',
      description: 'Reviewers disagree about F-0001.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: {
        targetFindingId: 'F-0001',
        targetRevision: 1,
        targetStatus: 'open',
        targetEvidenceHash: '0'.repeat(64),
      },
      evidence: [evidence.evidence],
    }],
    conflicts: [{
      id: 'C-FA2947446963',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-1'],
      description: 'Reviewers disagree about F-0001.',
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
    }],
    evidenceRecords: [evidence.record],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
  });
  const ledger = refreshActiveConflictAdjudicationSnapshots({
    ledger: landUnownedConflictRawClaims({ ledger: authorized, observation: OBSERVATION }),
    originStep: 'reviewers',
    createdAt: OBSERVATION,
  });
  const store = createLedgerStore(cwd);
  await store.updateLedger(() => ({ ledger, result: undefined }));
  return store;
}

describe('finding-conflict-adjudication engine registry contract', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTestTmpDir();
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('runs the synthetic detour and records an undetermined result in the append-only registries', async () => {
    const store = await seedLedger(cwd);
    const snapshot = freshConflictAdjudicationSnapshot(store.loadLedger(), 'C-FA2947446963');
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      return isAdjudicationSchema(options?.outputSchema)
        ? {
            persona,
            status: 'done',
            content: '{}',
            structuredOutput: {
              proposal: {
                kind: 'undetermined',
                subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
                rationale: 'No verified terminal authority is available.',
              },
            },
            timestamp: new Date('2026-06-13T02:00:00.000Z'),
          }
        : {
            persona,
            status: 'done',
            content: 'approved',
            timestamp: new Date('2026-06-13T00:00:01.000Z'),
          };
    });

    const result = await new WorkflowEngine(workflowConfig(cwd), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();
    const ledger = store.loadLedger();

    expect(result.status).toBe('aborted');
    expect(ledger.conflicts[0]).not.toHaveProperty('adjudications');
    expect(ledger.conflictAdjudicationSnapshots).toHaveLength(1);
    expect(ledger.conflictAdjudicationEpisodes).toHaveLength(1);
    expect(ledger.conflictAdjudicationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        result: expect.objectContaining({ kind: 'verification_undetermined' }),
      }),
    ]);
    expect(ledger.conflictClaimSettlements).toEqual([]);
  });

  it('records legacy-shaped provider output as a diagnostic attempt without recreating adjudications', async () => {
    const store = await seedLedger(cwd);
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      return isAdjudicationSchema(options?.outputSchema)
        ? {
            persona,
            status: 'done',
            content: '{}',
            structuredOutput: { outcome: 'finding_stale' },
            timestamp: new Date('2026-06-13T02:00:00.000Z'),
          }
        : {
            persona,
            status: 'done',
            content: 'approved',
            timestamp: new Date('2026-06-13T00:00:01.000Z'),
          };
    });

    const result = await new WorkflowEngine(workflowConfig(cwd), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();
    const ledger = store.loadLedger();

    expect(result.status).toBe('aborted');
    expect(ledger.conflicts[0]).not.toHaveProperty('adjudications');
    expect(ledger.conflictAdjudicationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        result: expect.objectContaining({ kind: 'diagnostic_undetermined', code: 'provider_failed' }),
      }),
    ]);
    expect(ledger.conflictClaimSettlements).toEqual([]);
  });
});
