import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { executeAgent } from '../agents/agent-usecases.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import type {
  AgentResponse,
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowStep,
} from '../core/models/types.js';
import { buildManagerInstruction } from '../core/workflow/findings/manager-agent.js';
import { renderConflictAdjudicationInstruction } from '../core/workflow/findings/adjudication-evidence.js';
import {
  freshConflictAdjudicationSnapshot,
  refreshActiveConflictAdjudicationSnapshots,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import {
  prepareInterpretationCaseProviderRequest,
  requestInterpretationCases,
} from '../core/workflow/findings/manager-interpretation-agent.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import { runMainManagerTasks } from '../core/workflow/findings/manager-task-runner.js';
import { bindPreAdmissionEntities } from '../core/workflow/findings/pre-admission-entity-binding.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import type {
  FindingLedger,
  RawFinding,
} from '../core/workflow/findings/types.js';
import type { ReviewerIntakeResult } from '../core/workflow/findings/manager-admission.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import { prepareWorkflowExecutionBundle } from '../features/tasks/execute/workflowExecutionBundle.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { composeFindingManagerInstruction } from '../core/workflow/findings/manager-instruction-composer.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

const executeAgentMock = vi.mocked(executeAgent);
const REPO_ROOT = process.cwd();
const BASELINE_PATH = join(
  REPO_ROOT,
  'src',
  '__tests__',
  'fixtures',
  'takt-default-fc-compatibility-baseline.json',
);

const contract: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile only the supplied task.',
    outputContract: 'Return structured JSON.',
  },
};

const managerStep: AgentWorkflowStep = {
  kind: 'agent',
  name: 'findings-manager',
  persona: 'findings-manager',
  edit: false,
};

function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function byteGolden(bytes: string): { bytes: number; sha256: string } {
  return { bytes: Buffer.byteLength(bytes, 'utf8'), sha256: digest(bytes) };
}

function normalizePaths(bytes: string): string {
  return bytes.replaceAll(REPO_ROOT, '<REPO>');
}

function emptyLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'compatibility-baseline',
    nextId: 1,
    updatedAt: '2026-08-04T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
    ...createEmptyFindingContractRegistries(),
    ...overrides,
  };
}

function rawFinding(): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId: 'raw-compatibility-001',
    stepName: 'reviewer',
    reviewer: 'reviewer',
    familyTag: 'correctness',
    severity: 'high',
    title: 'Compatibility finding',
    description: 'The compatibility fixture exercises every manager prompt path.',
    suggestion: 'Preserve the prompt bytes.',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/compatibility.ts'] },
    evidence: [],
  });
}

function response(structuredOutput: Record<string, unknown>): AgentResponse {
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    timestamp: new Date('2026-08-04T00:00:00.000Z'),
    structuredOutput,
  };
}

function sectionJson<T>(instruction: string, heading: string): T {
  const start = instruction.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`Missing section ${heading}`);
  const rest = instruction.slice(start + heading.length + 1);
  const match = /^(`{3,})json\n([\s\S]*?)\n\1/m.exec(rest);
  if (match?.[2] === undefined) throw new Error(`Missing JSON block after ${heading}`);
  return JSON.parse(match[2]) as T;
}

function runInput() {
  return {
    optionsBuilder: {
      buildAgentOptions: () => ({}),
    },
    stepExecutor: {
      buildPhase1Instruction: (instruction: string) => instruction,
      normalizeStructuredOutput: (_step: WorkflowStep, agentResponse: AgentResponse) => agentResponse,
      recordSynthesizedAgentUsage: () => {},
    },
  } as Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
}

function reviewerIntake(ledger: FindingLedger, raw: RawFinding): ReviewerIntakeResult {
  const canonical = canonicalizeReviewerRawFinding(
    candidateFromStoredRawFinding(raw, 'reviewer-stable-compatibility'),
    { ledger },
  ).canonical;
  return {
    items: [{ canonical, wire: toLedgerRawFinding(canonical) }],
    entityBindings: new Map(),
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    intakeAnomalySpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
}

function bundleGolden(): { rootOwned: string; inheritedChild: string } {
  const loadedBuiltin = loadWorkflowFromFile(
    join(REPO_ROOT, 'builtins', 'en', 'workflows', 'takt-default-high.yaml'),
    REPO_ROOT,
  );
  if (loadedBuiltin.findingContract === undefined) {
    throw new Error('Expected takt-default-high to load its finding contract facets');
  }
  const child = attachWorkflowOpaqueRef({
    name: 'compatibility-child',
    subworkflow: { callable: true, visibility: 'internal', requiresFindingContract: true },
    initialStep: 'review',
    maxSteps: 2,
    steps: [{
      kind: 'agent',
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review.',
      rules: [{ condition: { kind: 'semantic', label: 'COMPLETE' }, next: 'COMPLETE' }],
    }],
  } satisfies WorkflowConfig, `builtin:sha256:${'b'.repeat(64)}`);
  const root = attachWorkflowOpaqueRef({
    name: 'compatibility-root',
    findingContract: loadedBuiltin.findingContract,
    initialStep: 'review-call',
    maxSteps: 2,
    steps: [{
      kind: 'workflow_call',
      name: 'review-call',
      call: 'compatibility-child',
      personaDisplayName: 'review-call',
      instruction: '',
      rules: [{ condition: { kind: 'semantic', label: 'COMPLETE' }, next: 'COMPLETE' }],
    }],
  } satisfies WorkflowConfig, `builtin:sha256:${'a'.repeat(64)}`);
  const prepared = prepareWorkflowExecutionBundle({
    rootWorkflow: root,
    workflowCallResolver: () => child,
    projectCwd: REPO_ROOT,
    lookupCwd: REPO_ROOT,
  });
  const objects = [...prepared.objects.values()].sort();
  const rootObjectHash = prepared.manifest.nodes[prepared.manifest.root.nodeId];
  const rootObject = prepared.objects.get(rootObjectHash!);
  if (rootObject === undefined) throw new Error('Missing root bundle object');
  const childObject = objects.find((value) => value !== rootObject);
  if (childObject === undefined) throw new Error('Missing inherited child bundle object');
  return {
    rootOwned: digest(rootObject),
    inheritedChild: digest(childObject),
  };
}

function conflictPromptGolden(): { bytes: number; sha256: string } {
  const raw = rawFinding();
  const observation = {
    runId: 'compatibility-run',
    stepName: 'reviewer',
    timestamp: '2026-08-04T00:00:00.000Z',
  };
  const ledger = refreshActiveConflictAdjudicationSnapshots({
    ledger: authorizeFindingLedgerFixture(emptyLedger({
        nextId: 2,
        rawFindings: [raw],
        rawCanonicalSnapshots: [rawCanonicalSnapshotFixture(raw, observation)],
        findings: [{
          id: 'F-0001',
          status: 'open',
          lifecycle: 'new',
          revision: 1,
          target: raw.target,
          targetIdentityHash: raw.targetIdentityHash,
          claimIdentityHash: raw.claimIdentityHash,
          semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
          severity: raw.severity,
          title: raw.title,
          description: raw.description ?? undefined,
          suggestion: raw.suggestion ?? undefined,
          evidenceIds: [],
          reviewers: ['reviewer'],
          rawFindingIds: [raw.rawFindingId],
          firstSeen: observation,
          lastSeen: observation,
        }],
        conflicts: [{
          id: 'C-FA2947446963',
          status: 'active',
          findingIds: ['F-0001'],
          rawFindingIds: [raw.rawFindingId],
          description: 'Compatibility conflict.',
          firstSeen: observation,
          lastSeen: observation,
          revision: 1,
        }],
    })),
    originStep: 'reviewer',
    createdAt: observation,
  });
  const snapshot = freshConflictAdjudicationSnapshot(ledger, 'C-FA2947446963');
  return byteGolden(renderConflictAdjudicationInstruction(snapshot));
}

async function collectManagerPrompts(
  promptContract: FindingContractConfig,
  promptManagerStep: AgentWorkflowStep,
): Promise<Record<string, string>> {
  const raw = rawFinding();
  const ledger = emptyLedger({
    nextId: 2,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      target: raw.target,
      targetIdentityHash: raw.targetIdentityHash,
      claimIdentityHash: raw.claimIdentityHash,
      semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
      severity: raw.severity,
      title: raw.title,
      description: raw.description ?? undefined,
      suggestion: raw.suggestion ?? undefined,
      evidenceIds: [],
      reviewers: ['reviewer'],
      rawFindingIds: [],
      firstSeen: {
        runId: 'compatibility-run',
        stepName: 'reviewer',
        timestamp: '2026-08-04T00:00:00.000Z',
      },
      lastSeen: {
        runId: 'compatibility-run',
        stepName: 'reviewer',
        timestamp: '2026-08-04T00:00:00.000Z',
      },
    }],
  });
  const prompts: Record<string, string> = {};
  executeAgentMock.mockImplementation(async (_persona, instruction) => {
    if (instruction.includes('## Control task output override')) {
      const manifest = sectionJson<{
        taskId: string;
        candidateIntents: Array<{ intentId: string }>;
      }>(instruction, '## Task manifest');
      prompts.control = instruction;
      return response({
        taskId: manifest.taskId,
        evaluations: manifest.candidateIntents.map(({ intentId }) => ({
          intentId,
          result: { kind: 'no_action', reason: 'No control action is authorized.' },
        })),
        selectedIntentId: null,
      });
    }
    const manifest = sectionJson<{
      taskId: string;
      rawFindings: Array<{ rawFindingId: string; componentId: string }>;
    }>(instruction, '## Task manifest');
    prompts.raw = instruction;
    return response({
      taskId: manifest.taskId,
      decisions: manifest.rawFindings.map(({ rawFindingId, componentId }) => ({
        rawFindingId,
        componentId,
        decision: 'new',
        findingId: '',
        evidence: 'Compatibility baseline decision.',
      })),
    });
  });
  await runMainManagerTasks({
    contract: promptContract,
    previousLedger: ledger,
    reviewScopeSnapshotId: 'scope-compatibility',
    residualRawFindings: [raw],
    mechanicallyClassifiedCount: 0,
    priorStepResponseText: undefined,
    invalidLocationCandidates: new Map(),
    dismissCandidates: new Map([['F-0001', 'The finding is outside the requested scope.']]),
    evidenceRecordsByRawFindingId: new Map(),
    managerStep: promptManagerStep,
    runInput: runInput(),
    managerAuthority: 'standard',
    workflowTask: 'Preserve compatibility.',
    subResults: [],
  });

  executeAgentMock.mockImplementation(async (_persona, instruction) => {
    const manifest = sectionJson<{
      taskId: string;
      ownedRawFindingIds: string[];
    }>(instruction, '## Task manifest');
    prompts.entityBinding = instruction;
    return response({
      taskId: manifest.taskId,
      decisions: manifest.ownedRawFindingIds.map((rawFindingId) => ({
        rawFindingId,
        decision: 'new_entity',
        findingId: '',
        groupRawFindingId: rawFindingId,
        reason: 'Compatibility baseline entity.',
      })),
    });
  });
  const entityLedger = emptyLedger();
  await bindPreAdmissionEntities({
    contract: promptContract,
    previousLedger: entityLedger,
    intake: reviewerIntake(entityLedger, raw),
    managerStep: promptManagerStep,
    roundMarker: 'round-compatibility',
    runInput: runInput(),
  });

  prompts.legacy = buildManagerInstruction({
    contract: promptContract,
    previousLedger: ledger,
    residualRawFindings: [raw],
    mechanicallyClassifiedCount: 0,
    priorStepResponseText: undefined,
    invalidLocationCandidates: new Map(),
    dismissCandidates: new Map(),
    verifiedEvidenceRecordsByRawFindingId: new Map(),
  });
  const prepared = prepareInterpretationCaseProviderRequest({
    cases: [],
    contract: promptContract,
    optionsBuilder: runInput().optionsBuilder as never,
    stepExecutor: runInput().stepExecutor,
    ledger,
  });
  prompts.interpretation = prepared.phase1Instruction;

  executeAgentMock.mockResolvedValue(response({ decisions: [] }));
  await requestInterpretationCases({
    cases: [],
    contract: promptContract,
    optionsBuilder: runInput().optionsBuilder as never,
    stepExecutor: runInput().stepExecutor,
    ledger,
    prepared,
  });

  return prompts;
}

async function collectBaseline() {
  const loaded = loadWorkflowFromFile(
    join(REPO_ROOT, 'builtins', 'en', 'workflows', 'takt-default-high.yaml'),
    REPO_ROOT,
  );
  const normalizedContractBytes = normalizePaths(canonicalJson(loaded.findingContract));
  const managerPromptBytes = await collectManagerPrompts(contract, managerStep);
  const managerPrompts = Object.fromEntries(
    Object.entries(managerPromptBytes).map(([name, prompt]) => [name, byteGolden(prompt)]),
  );
  const interpretationRequest = prepareInterpretationCaseProviderRequest({
    cases: [],
    contract,
    optionsBuilder: runInput().optionsBuilder as never,
    stepExecutor: runInput().stepExecutor,
    ledger: emptyLedger(),
  }).requestBytes;
  return {
    head: '3847cda1',
    normalizedFindingContract: byteGolden(normalizedContractBytes),
    executionBundle: bundleGolden(),
    adjudicatorPrompts: {
      conflict: conflictPromptGolden(),
    },
    managerPrompts,
    interpretationRequest: byteGolden(interpretationRequest),
  };
}

describe('takt-default-fc compatibility baseline', () => {
  it('pins omitted manager additions and adjudicator configuration before production changes', async () => {
    const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as unknown;
    const actual = await collectBaseline();
    expect(actual).toEqual(expected);
  });

  it('prepends additions exactly once while preserving all five manager prompt suffixes', async () => {
    const additionsContract: FindingContractConfig = {
      manager: {
        ...contract.manager,
        knowledgeContents: ['Knowledge one', 'Knowledge two'],
        policyContents: ['Policy one', 'Policy two'],
      },
    };
    const additionsStep: AgentWorkflowStep = {
      ...managerStep,
      knowledgeContents: additionsContract.manager.knowledgeContents,
      policyContents: additionsContract.manager.policyContents,
    };
    const basePrompts = await collectManagerPrompts(contract, managerStep);
    const composedPrompts = await collectManagerPrompts(additionsContract, additionsStep);
    const prefix = [
      '## Knowledge additions',
      'Knowledge one',
      '---',
      'Knowledge two',
      '',
      '## Policy additions',
      'Policy one',
      '---',
      'Policy two',
      '',
      '',
    ].join('\n');
    expect(Object.keys(composedPrompts).sort()).toEqual(
      ['control', 'entityBinding', 'interpretation', 'legacy', 'raw'],
    );
    for (const [name, basePrompt] of Object.entries(basePrompts)) {
      expect(composedPrompts[name]).toBe(`${prefix}${basePrompt}`);
    }
  });

  it('rejects defined-empty manager additions instead of treating them as omitted', () => {
    for (const additions of [
      { policyContents: [] },
      { knowledgeContents: [] },
      { policyContents: [], knowledgeContents: undefined },
      { policyContents: undefined, knowledgeContents: [] },
    ]) {
      expect(() => composeFindingManagerInstruction({
        baseInstruction: 'base',
        ...additions,
      })).toThrow('Finding Manager policy/knowledge additions must not be empty');
    }
  });

  it('does not impose the new 24KB task ceiling on the legacy manager composer', () => {
    const legacyBase = `Legacy manager input ${'x'.repeat(24_100)}`;

    const composed = composeFindingManagerInstruction({
      baseInstruction: legacyBase,
    });

    expect(composed).toBe(legacyBase);
    expect(Buffer.byteLength(composed, 'utf8')).toBeGreaterThan(24_000);
  });
});
