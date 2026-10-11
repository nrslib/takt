/**
 * Pipeline integration tests.
 *
 * Uses mock provider + scenario queue for end-to-end testing
 * of the pipeline execution flow. Git operations are skipped via --skip-git.
 *
 * Mocked: git operations (child_process), GitHub API, UI output, notifications, session
 * Not mocked: executeTask, executeWorkflow, WorkflowEngine, runAgent, rule evaluation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { execFileSync } from 'node:child_process';
import { getScenarioQueue, setMockScenario, resetScenario } from '../infra/mock/index.js';
import type { WorkflowStep } from '../core/models/index.js';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { detectCandidateIndex } from '../shared/utils/ruleIndex.js';

function selectSemanticLabelFromTag(step: WorkflowStep, context: { lastResponse?: string }) {
  const candidates = semanticRuleCandidatesOf(step.rules ?? [], false);
  const candidateIndex = detectCandidateIndex(context.lastResponse ?? '', step.name);
  const candidate = candidates[candidateIndex];
  if (!candidate) {
    throw new RuleDetectionExhaustedError(step.name);
  }
  return { label: candidate.label, method: 'phase3_tag' as const };
}

const { mockWorkflowWarn, mockUiError, mockConfirm } = vi.hoisted(() => ({
  mockWorkflowWarn: vi.fn(),
  mockUiError: vi.fn(),
  mockConfirm: vi.fn().mockResolvedValue(false),
}));

// --- Mocks ---

// Git operations (even with --skip-git, some imports need to be available)
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

vi.mock('../infra/github/issue.js', () => ({
  fetchIssue: vi.fn(),
  formatIssueAsTask: vi.fn(),
  checkGhCli: vi.fn(),
}));

vi.mock('../infra/github/pr.js', () => ({
  createPullRequest: vi.fn(),
  buildPrBody: vi.fn().mockReturnValue('PR body'),
  fetchPrReviewComments: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: mockUiError,
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: () => vi.fn(),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: (name: string) => {
      const logger = original.createLogger(name);
      return name === 'workflow' ? { ...logger, warn: mockWorkflowWarn } : logger;
    },
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    generateSessionId: vi.fn().mockReturnValue('test-session-id'),
    createSessionLog: vi.fn().mockReturnValue({
      startTime: new Date().toISOString(),
      iterations: 0,
    }),
    finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({ ...log, status })),
    initNdjsonLog: vi.fn().mockReturnValue('/tmp/test.ndjson'),
    appendNdjsonLine: vi.fn(),
    generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  };
});

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...original,
    loadPersonaSessions: vi.fn().mockReturnValue({}),
    updatePersonaSession: vi.fn(),
    loadWorktreeSessions: vi.fn().mockReturnValue({}),
    updateWorktreeSession: vi.fn(),
    getProjectConfigDir: vi.fn().mockImplementation((cwd: string) => join(cwd, '.takt')),
  };
});

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/global/globalConfig.js')>();
  return {
    ...original,
    loadGlobalConfig: vi.fn().mockReturnValue({
      language: 'en',
      provider: 'mock',
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
      workflowCommandGates: { customScripts: true },
    }),
    getLanguage: vi.fn().mockReturnValue('en'),
  };
});

vi.mock('../infra/config/project/projectConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/project/projectConfig.js')>();
  return {
    ...original,
    loadProjectConfig: vi.fn(original.loadProjectConfig),
  };
});

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: mockConfirm,
  selectOption: vi.fn().mockResolvedValue('stop'),
  promptInput: vi.fn().mockResolvedValue(null),
}));

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
  runReportPhase: vi.fn().mockImplementation(async (
    step: WorkflowStep,
    _stepIteration: number,
    context: { reportDir: string; lastResponse?: string },
  ) => {
    mkdirSync(context.reportDir, { recursive: true });
    for (const contract of step.outputContracts ?? []) {
      writeFileSync(join(context.reportDir, contract.name), context.lastResponse ?? 'Mock report');
    }
  }),
  runStatusJudgmentPhase: vi.fn().mockImplementation(selectSemanticLabelFromTag),
}));

vi.mock('../core/workflow/quality-gates/commandGateRunner.js', () => ({
  runCommandQualityGate: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
}));

// --- Imports (after mocks) ---

import { executePipeline } from '../features/pipeline/index.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { checkGhCli, fetchIssue } from '../infra/github/issue.js';
import { fetchPrReviewComments } from '../infra/github/pr.js';
import { info, warn } from '../shared/ui/index.js';
import { getProvider } from '../infra/providers/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import * as mockClients from '../infra/mock/index.js';
import * as taskSpecContext from '../features/tasks/execute/taskSpecContext.js';
import * as taskExecution from '../features/tasks/index.js';
import * as managedProviders from '../infra/managed-providers/loader.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';

const mockExecFileSync = vi.mocked(execFileSync);

/** Create a minimal test workflow YAML + agent files in a temp directory */
function createTestWorkflowDir(): { dir: string; workflowPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pipeline-'));

  // Create .takt/runs structure
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });

  // Create persona prompt files
  const personasDir = join(dir, '.takt', 'personas');
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'planner.md'), 'You are a planner. Analyze the task.');
  writeFileSync(join(personasDir, 'coder.md'), 'You are a coder. Implement the task.');
  writeFileSync(join(personasDir, 'reviewer.md'), 'You are a reviewer. Review the code.');

  // Create a simple workflow YAML
  const workflowYaml = `
name: it-simple
description: Integration test workflow
max_steps: 10
initial_step: plan

steps:
  - name: plan
    persona: ./.takt/personas/planner.md
    rules:
      - condition: Requirements are clear
        next: implement
      - condition: Requirements unclear
        next: ABORT
    instruction: "{task}"

  - name: implement
    persona: ./.takt/personas/coder.md
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: plan
    instruction: "{task}"

  - name: review
    persona: ./.takt/personas/reviewer.md
    rules:
      - condition: All checks passed
        next: COMPLETE
      - condition: Issues found
        next: implement
    instruction: "{task}"
`;

  const workflowPath = join(dir, 'workflow.yaml');
  writeFileSync(workflowPath, workflowYaml);

  return { dir, workflowPath };
}

function writeChildAutoRoutingWorkflow(dir: string, parallel: boolean): string {
  const workflowsDir = join(dir, '.takt', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(dir, '.takt', 'runtime.yaml'), `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: mock/default-model
    low:
      provider: mock
      model: mock/low-model
    medium:
      provider: mock
      model: mock/medium-model
    high:
      provider: mock
      model: mock/high-model
    router:
      provider: mock
      model: mock/router-model
  auto_routing:
    strategy: balanced
    router_profile: router
    pools:
      general:
        candidates:
          - profile: low
            tier: low
          - profile: medium
            tier: medium
          - profile: high
            tier: high
        fallback_profile: high
`);
  writeFileSync(join(workflowsDir, 'child-auto.yaml'), `name: child-auto
subworkflow:
  callable: true
initial_step: child-step
max_steps: 2
steps:
  - name: child-step
    persona: ./.takt/personas/coder.md
    instruction: Run child work
    rules:
      - condition: done
        next: COMPLETE
`);
  const workflowPath = join(dir, parallel ? 'parallel-parent.yaml' : 'direct-parent.yaml');
  const delegate = parallel
    ? `  - name: delegate
    parallel:
      - name: call-child
        kind: workflow_call
        call: child-auto
        rules:
          - condition: COMPLETE
            next: COMPLETE
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE`
    : `  - name: delegate
    kind: workflow_call
    call: child-auto
    rules:
      - condition: COMPLETE
        next: COMPLETE`;
  writeFileSync(workflowPath, `name: ${parallel ? 'parallel-parent' : 'direct-parent'}
initial_step: delegate
max_steps: 3
steps:
${delegate}
`);
  return workflowPath;
}

describe('Pipeline Integration Tests', () => {
  let testDir: string;
  let workflowPath: string;
  const restoreImageSpies: Array<() => void> = [];
  const restorePreflightState: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(false);
    vi.mocked(loadGlobalConfig).mockReturnValue({
      language: 'en',
      provider: 'mock',
      autoFetch: false,
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
    });
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return 'test/current\n' as never;
      }
      if (Array.isArray(args) && args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/main\n' as never;
      }
      return '' as never;
    });
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
    workflowPath = setup.workflowPath;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const restore of restorePreflightState.splice(0)) restore();
    for (const restore of restoreImageSpies.splice(0)) restore();
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  function prepareManagedPreflight(terminal: boolean) {
    vi.stubEnv('TAKT_CONFIG_DIR', join(testDir, 'managed-config'));
    vi.stubEnv('TAKT_NO_TTY', terminal ? '0' : '1');
    vi.stubEnv('CI', '');
    for (const stream of [process.stdin, process.stdout]) {
      const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
      Object.defineProperty(stream, 'isTTY', { value: terminal, configurable: true });
      restorePreflightState.push(() => {
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
    }
    const mockAgentCall = vi.spyOn(mockClients, 'callMockCustom');
    restorePreflightState.push(() => mockAgentCall.mockRestore());
    const engineEvents = vi.spyOn(WorkflowEngine.prototype, 'emit');
    restorePreflightState.push(() => engineEvents.mockRestore());
    const managedCall = vi.fn().mockResolvedValue({
      persona: 'coder', status: 'error', content: '', error: 'Unexpected managed provider invocation', timestamp: new Date(),
    });
    for (const provider of ['pi', 'codex', 'claude-sdk', 'deepseek-harness'] as const) {
      const setup = vi.spyOn(getProvider(provider), 'setup').mockReturnValue({ call: managedCall });
      restorePreflightState.push(() => setup.mockRestore());
    }
    setMockScenario([{ persona: 'planner', status: 'done', content: '[PLAN:1]\nPlan complete.' }]);
    return { mockAgentCall, managedCall, stepStarts: () => engineEvents.mock.calls.filter(([name]) => name === 'step:start').length };
  }

  function writeManagedRuntime(targets: Record<string, unknown>, routing = false, companionEnabled?: boolean) {
    writeFileSync(join(testDir, '.takt', 'runtime.yaml'), stringifyYaml({
      version: 1,
      ...(companionEnabled === undefined ? {} : { companion: { enabled: companionEnabled } }),
      provider: {
        defaults: { profile: 'active' },
        profiles: {
          active: { provider: 'mock', model: 'mock/default-model' },
          unused: { provider: 'pi', model: 'mock/pi-model' },
          coding: { provider: 'codex', model: 'gpt-5' },
          advanced: { provider: 'claude-sdk', model: 'claude-sonnet-4-5' },
          transport: { provider: 'opencode', model: 'opencode/model' },
        },
        targets,
        ...(routing ? { auto_routing: {
          strategy: 'balanced', router_profile: 'active', pools: {
            general: { candidates: [{ profile: 'coding', tier: 'low' }, { profile: 'advanced', tier: 'high' }], fallback_profile: 'advanced' },
          },
        } } : {}),
      },
    }));
  }

  it.each([false, true])('stops a pipeline before its first mock step when a later provider is missing with terminal=%s', async (terminal) => {
    const { mockAgentCall, managedCall, stepStarts } = prepareManagedPreflight(terminal);
    writeManagedRuntime({ steps: { implement: { profile: 'unused' } } });
    const code = await executePipeline({ task: 'Preflight missing provider', workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir });
    expect(stepStarts()).toBe(0);
    expect(mockAgentCall).not.toHaveBeenCalled();
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(code).not.toBe(0);
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
  });

  it.each(['tags', 'personas'] as const)('checks providers selected by %s before the first pipeline step', async (assignment) => {
    const { mockAgentCall, managedCall, stepStarts } = prepareManagedPreflight(false);
    writeManagedRuntime({ [assignment]: { [assignment === 'tags' ? 'implementation' : 'coder']: { profile: 'unused' } } });
    if (assignment === 'tags') {
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('  - name: implement', '  - name: implement\n    tags: [implementation]'));
    }
    const code = await executePipeline({ task: 'Check assigned providers', workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir });
    expect(code).not.toBe(0);
    expect(stepStarts()).toBe(0);
    expect(mockAgentCall).not.toHaveBeenCalled();
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('does not prompt in CI even when both streams report a terminal', async () => {
    const { stepStarts, managedCall } = prepareManagedPreflight(true);
    vi.stubEnv('CI', 'true');
    writeManagedRuntime({ steps: { implement: { profile: 'unused' } } });
    await taskExecution.selectAndExecuteTask(testDir, 'CI missing provider', { workflow: workflowPath, skipTaskList: true, failureMode: 'return' });
    expect(stepStarts()).toBe(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
  });

  it.each(['selector', 'loop judge', 'promotion'] as const)('checks an effective %s provider before the first pipeline step', async (operation) => {
    const { mockAgentCall, managedCall, stepStarts } = prepareManagedPreflight(false);
    if (operation === 'promotion') {
      writeManagedRuntime({ steps: { implement: { ladder: ['active', 'unused'] } } });
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('  - name: implement', '  - name: implement\n    promotion: [{ at: 2 }]'));
    } else if (operation === 'selector') {
      writeManagedRuntime({ internal_agents: { selector: { profile: 'unused' } } });
      writeFileSync(workflowPath, stringifyYaml({
        name: 'dynamic-selection', initial_step: 'plan', max_steps: 3,
        steps: [
          { name: 'plan', persona: './.takt/personas/planner.md', instruction: '{task}', rules: [{ condition: 'done', next: 'review' }] },
          { name: 'review', parallel: { pool: [
            { name: 'candidate', persona: './.takt/personas/reviewer.md', description: 'Review the task', instruction: '{task}', rules: [{ condition: 'approved' }] },
          ] }, rules: [{ condition: 'all("approved")', next: 'COMPLETE' }] },
        ],
      }));
    } else {
      writeManagedRuntime({ internal_agents: { 'loop-judge': { profile: 'unused' } } });
      writeFileSync(workflowPath, `${readFileSync(workflowPath, 'utf8')}\nloop_monitors:\n  - cycle: [implement, review]\n    threshold: 2\n    judge:\n      persona: ./.takt/personas/reviewer.md\n      rules: [{ condition: continue, next: implement }]\n`);
    }
    const code = await executePipeline({ task: 'Check effective auxiliary provider', workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir });
    expect(code).not.toBe(0);
    expect(stepStarts()).toBe(0);
    expect(mockAgentCall).not.toHaveBeenCalled();
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
  });

  it('does not check a configured selector when the workflow has no dynamic selection', async () => {
    const { managedCall, stepStarts } = prepareManagedPreflight(false);
    writeManagedRuntime({ internal_agents: { selector: { profile: 'unused' } } });
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\nPlan complete.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\nImplemented.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\nApproved.' },
    ]);
    const code = await executePipeline({ task: 'Ignore unused selector', workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir });
    expect(code).toBe(0);
    expect(stepStarts()).toBeGreaterThan(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'override'] as const)('checks an explicit %s selector before the workflow engine starts', async (selection) => {
    const { managedCall, stepStarts } = prepareManagedPreflight(false);
    writeManagedRuntime({});
    writeFileSync(workflowPath, stringifyYaml({
      name: 'explicit-selector', initial_step: 'review', max_steps: 3,
      steps: [{
        name: 'review', parallel: { pool: [{
          name: 'candidate', persona: './.takt/personas/reviewer.md', description: 'Review the task',
          instruction: '{task}', rules: [{ condition: 'approved' }],
        }] }, rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
      }],
    }));
    const workflow = loadWorkflowByIdentifier(workflowPath, testDir);
    expect(workflow).not.toBeNull();
    const selector = { provider: 'pi' as const, model: 'mock/pi-model' };
    await executeWorkflow(workflow!, 'Check explicit selector', testDir, {
      projectCwd: testDir, provider: 'mock',
      ...(selection === 'resolved' ? { selectorProvider: selector } : { selectorProviderOverrides: selector }),
    });
    expect(stepStarts()).toBe(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
  });

  it('does not require an explicit selector SDK when the workflow never selects dynamically', async () => {
    const { managedCall, stepStarts } = prepareManagedPreflight(false);
    writeManagedRuntime({});
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\nPlan complete.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\nImplemented.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\nApproved.' },
    ]);
    const workflow = loadWorkflowByIdentifier(workflowPath, testDir);
    expect(workflow).not.toBeNull();
    await executeWorkflow(workflow!, 'Ignore unused explicit selector', testDir, {
      projectCwd: testDir, selectorProvider: { provider: 'pi', model: 'mock/pi-model' },
    });
    expect(stepStarts()).toBeGreaterThan(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUiError).not.toHaveBeenCalled();
  });

  it.each(['companion', 'team leader part', 'report fallback', 'rate-limit fallback'] as const)('checks an effective %s SDK before a preceding mock step starts', async (operation) => {
    const { managedCall, stepStarts } = prepareManagedPreflight(false);
    if (operation === 'companion') {
      writeManagedRuntime({ companions: { reviewer: { profile: 'unused' } } }, false, true);
      mkdirSync(join(testDir, '.takt', 'companions'), { recursive: true });
      writeFileSync(join(testDir, '.takt', 'companions', 'reviewer.yaml'), 'name: reviewer\ndescription: Review implementation\ninterval_ms: 60000\n');
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('  - name: implement', '  - name: implement\n    companion: [reviewer]'));
    } else if (operation === 'team leader part') {
      writeManagedRuntime({ steps: { 'implement.coding-part': { profile: 'unused' } } });
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('  - name: implement', '  - name: implement\n    team_leader: { max_parts: 2 }'));
    } else {
      writeManagedRuntime({});
      vi.mocked(loadGlobalConfig).mockReturnValue({
        language: 'en', provider: 'mock', autoFetch: false, enableBuiltinWorkflows: true, disabledBuiltins: [],
        ...(operation === 'rate-limit fallback'
          ? { rateLimitFallback: { switchChain: [{ provider: 'pi' }] } }
          : { taktProviders: { assistant: { provider: 'pi' } }, providerRouting: { steps: { implement: { provider: 'opencode', model: 'opencode/model' } } } }),
      });
      if (operation === 'report fallback') {
        rmSync(join(testDir, '.takt', 'runtime.yaml'));
        const inspector = vi.spyOn(managedProviders, 'inspectProviderInstallation');
        inspector.mockImplementation(async (provider) => provider === 'opencode' ? { state: 'ready' } : { state: 'missing' });
        restorePreflightState.push(() => inspector.mockRestore());
        writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('  - name: implement', '  - name: implement\n    output_contracts: { report: [{ name: report.md, format: "# Report" }] }'));
      }
    }
    expect(await executePipeline({ task: 'Check auxiliary provider', workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir })).not.toBe(0);
    expect(stepStarts()).toBe(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
  });

  it.each([false, true])('detects a missing child workflow provider before a parent step starts with parallel=%s', async (parallel) => {
    const { managedCall, stepStarts } = prepareManagedPreflight(false);
    const parentPath = writeChildAutoRoutingWorkflow(testDir, parallel);
    writeManagedRuntime({ steps: { 'child-auto/child-step': { profile: 'unused' } } });
    const code = await executePipeline({ task: 'Check child providers', workflow: parentPath, autoPr: false, skipGit: true, cwd: testDir });
    expect(stepStarts()).toBe(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(code).not.toBe(0);
    expect(mockUiError.mock.calls.flat().join('\n')).toContain('takt install pi');
  });

  it('does not begin a terminal task after missing provider installation is declined', async () => {
    const { mockAgentCall, managedCall, stepStarts } = prepareManagedPreflight(true);
    writeManagedRuntime({ steps: { implement: { profile: 'unused' } } });
    await taskExecution.selectAndExecuteTask(testDir, 'Decline install', { workflow: workflowPath, skipTaskList: true, failureMode: 'return' });
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockConfirm.mock.calls.flat().join('\n')).toMatch(/pi[\s\S]*(?:MB|GB|MiB|GiB)|(?:MB|GB|MiB|GiB)[\s\S]*pi/u);
    expect(mockAgentCall).not.toHaveBeenCalled();
    expect(stepStarts()).toBe(0);
    expect(managedCall).not.toHaveBeenCalled();
  });

  it('blocks a routing workflow before every step when installation of a selected provider is declined', async () => {
    const { mockAgentCall, managedCall, stepStarts } = prepareManagedPreflight(true);
    writeManagedRuntime({ steps: { implement: { pool: 'general' }, review: { profile: 'unused' } } }, true);
    await taskExecution.selectAndExecuteTask(testDir, 'Collect providers before starting', { workflow: workflowPath, skipTaskList: true, failureMode: 'return' });
    const preparationOutput = [...vi.mocked(info).mock.calls.flat(), ...mockConfirm.mock.calls.flat()].join('\n');
    expect(mockConfirm).toHaveBeenCalled();
    expect(preparationOutput).toMatch(/codex|claude-sdk|pi/u);
    expect(stepStarts()).toBe(0);
    expect(mockAgentCall).not.toHaveBeenCalled();
    expect(managedCall).not.toHaveBeenCalled();
  });

  it('starts the mock workflow without prompting for an unused profile or provider text in its instruction', async () => {
    const { mockAgentCall, managedCall, stepStarts } = prepareManagedPreflight(true);
    writeManagedRuntime({});
    writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('instruction: "{task}"',
      'instruction: |\n      provider: pi\n      The quoted text is "provider: pi".\n      ```yaml\n      provider: pi\n      ```\n      ~~~yaml\n      provider: pi\n      ~~~\n      ```yaml\n      provider: pi\n      {task}\n    # provider: pi'));
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\nPlan complete.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\nImplemented.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\nApproved.' },
    ]);
    await taskExecution.selectAndExecuteTask(testDir, 'Ignore instruction text', { workflow: workflowPath, skipTaskList: true, failureMode: 'return' });
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockAgentCall).toHaveBeenCalled();
    expect(stepStarts()).toBeGreaterThan(0);
    expect(managedCall).not.toHaveBeenCalled();
    expect(mockUiError).not.toHaveBeenCalled();
  });

  it.each([
    { route: 'pr', outcome: 'complete', worktree: false },
    { route: 'issue', outcome: 'complete', worktree: false },
    { route: 'pr', outcome: 'abort', worktree: false },
    { route: 'issue', outcome: 'abort', worktree: false },
    { route: 'issue', outcome: 'complete', worktree: true },
  ] as const)('stages $route images and retains run artifacts after workflow $outcome with worktree=$worktree', async ({ route, outcome, worktree }) => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    const url = 'https://github.com/user-attachments/assets/pipeline-image';
    const syntax = `![a](${url})`;
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
    vi.mocked(fetchIssue).mockReturnValue({ number: 792, title: 'Issue image', body: syntax, labels: [], comments: [] });
    vi.mocked(fetchPrReviewComments).mockReturnValue({
      number: 792, title: 'PR image', body: syntax,
      url: 'https://github.com/org/repo/pull/792', headRefName: 'feature/images', baseRefName: 'main',
      reviews: [], comments: [], files: [],
    });
    const fetchImage = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchImage);
    const execCwd = worktree ? join(testDir, 'image-worktree') : testDir;
    if (worktree) {
      mkdirSync(join(execCwd, '.takt'), { recursive: true });
      cpSync(join(testDir, '.takt', 'personas'), join(execCwd, '.takt', 'personas'), { recursive: true });
      const createWorktree = vi.spyOn(taskExecution, 'confirmAndCreateWorktree').mockResolvedValue({
        execCwd, isWorktree: true, branch: 'feature/images', baseBranch: 'main', taskSlug: 'image-task',
      });
      restoreImageSpies.push(() => createWorktree.mockRestore());
    }
    const resolveSpec = vi.spyOn(taskSpecContext, 'resolveTaskSpecForExecution');
    restoreImageSpies.push(() => resolveSpec.mockRestore());
    const originalAgentCall = mockClients.callMockCustom;
    const sourceExistsWhileRunning: boolean[] = [];
    const agentCall = vi.spyOn(mockClients, 'callMockCustom').mockImplementation((...args) => {
      const resolved = resolveSpec.mock.results.find((result) => result.type === 'return');
      const sourceSpec = resolved?.value as taskSpecContext.ResolvedTaskSpec | undefined;
      sourceExistsWhileRunning.push(sourceSpec !== undefined && existsSync(sourceSpec.sourceTaskDir));
      return originalAgentCall(...args);
    });
    restoreImageSpies.push(() => agentCall.mockRestore());
    setMockScenario(outcome === 'abort' ? [
      { persona: 'planner', status: 'done', content: '[PLAN:2]\nCannot proceed.' },
    ] : [
      { persona: 'planner', status: 'done', content: '[PLAN:1]\nPlan complete.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\nImplemented.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\nApproved.' },
    ]);

    const exitCode = await executePipeline({
      ...(route === 'pr' ? { prNumber: 792 } : { issueNumber: 792 }),
      workflow: workflowPath, autoPr: false, skipGit: true, createWorktree: worktree, cwd: testDir, provider: 'mock',
    });

    expect(exitCode).toBe(outcome === 'complete' ? 0 : 3);
    expect(fetchImage.mock.calls.map(([requestedUrl]) => String(requestedUrl))).toEqual([url]);
    const runsDir = join(execCwd, '.takt', 'runs');
    const runSlugs = readdirSync(runsDir).filter((slug) => existsSync(join(runsDir, slug, 'context', 'task', 'order.md')));
    expect(runSlugs).toHaveLength(1);
    const orderRel = `.takt/runs/${runSlugs[0]}/context/task/order.md`;
    const imageRel = `.takt/runs/${runSlugs[0]}/context/task/attachments/image-1.png`;
    const order = readFileSync(join(execCwd, orderRel), 'utf-8');
    expect(order).toContain(syntax);
    expect(order).toMatch(/\)\s*\[Image #1\]/);
    expect(order).toContain('## 添付画像');
    const listedPaths = Array.from(order.matchAll(/^- \[Image #\d+\]: `([^`]+)`/gm), (match) => match[1]);
    expect(listedPaths).toEqual([imageRel]);
    expect(readFileSync(join(execCwd, listedPaths[0]!))).toEqual(png);
    expect(agentCall.mock.calls.some(([, prompt]) => prompt.includes(orderRel))).toBe(true);
    expect(sourceExistsWhileRunning.length).toBeGreaterThan(0);
    expect(sourceExistsWhileRunning.every(Boolean)).toBe(true);
    const sourceSpec = resolveSpec.mock.results.find((result) => result.type === 'return')!.value as taskSpecContext.ResolvedTaskSpec;
    expect(existsSync(sourceSpec.sourceTaskDir)).toBe(false);
    expect(readdirSync(join(testDir, '.takt', 'tmp', 'github-images'))).toEqual([]);
    expect(existsSync(join(execCwd, imageRel))).toBe(true);
    if (worktree) expect(existsSync(join(testDir, orderRel))).toBe(false);
  });

  it('removes temporary images and task specs when execution context resolution throws', async () => {
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
    vi.mocked(fetchIssue).mockReturnValue({
      number: 792, title: 'Issue image', labels: [], comments: [],
      body: '![a](https://github.com/user-attachments/assets/pipeline-image)',
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      new Uint8Array(Buffer.from('89504e470d0a1a0a', 'hex')), { headers: { 'content-type': 'image/png' } },
    )));
    let sourceTaskDir: string | undefined;
    const resolveSpec = vi.spyOn(taskSpecContext, 'resolveTaskSpecForExecution').mockImplementation((cwd, _execCwd, taskDir) => {
      sourceTaskDir = join(cwd, taskDir);
      expect(existsSync(sourceTaskDir)).toBe(true);
      throw new Error('task spec resolution failed');
    });
    restoreImageSpies.push(() => resolveSpec.mockRestore());

    await expect(executePipeline({ issueNumber: 792, workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir, provider: 'mock' }))
      .rejects.toThrow('task spec resolution failed');

    expect(sourceTaskDir).toBeDefined();
    expect(existsSync(sourceTaskDir!)).toBe(false);
    expect(readdirSync(join(testDir, '.takt', 'tmp', 'github-images'))).toEqual([]);
  });

  it.each(['pr', 'issue'] as const)('continues the %s pipeline when all image downloads fail', async (route) => {
    const syntax = '![a](https://github.com/user-attachments/assets/unavailable)';
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
    vi.mocked(fetchIssue).mockReturnValue({ number: 792, title: 'Issue image', body: syntax, labels: [], comments: [] });
    vi.mocked(fetchPrReviewComments).mockReturnValue({
      number: 792, title: 'PR image', body: syntax,
      url: 'https://github.com/org/repo/pull/792', headRefName: 'feature/images', baseRefName: 'main',
      reviews: [], comments: [], files: [],
    });
    const fetchImage = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetchImage);
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\nPlan complete.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\nImplemented.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\nApproved.' },
    ]);

    const exitCode = await executePipeline({
      ...(route === 'pr' ? { prNumber: 792 } : { issueNumber: 792 }),
      workflow: workflowPath, autoPr: false, skipGit: true, cwd: testDir, provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getScenarioQueue()?.remaining).toBe(0);
  });

  it('should complete pipeline with workflow path + skip-git + mock scenario', async () => {
    // Scenario: plan -> implement -> review -> COMPLETE
    // persona field must match extractPersonaName(step.persona), i.e., the .md filename without extension
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nPlan completed. Requirements are clear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a hello world function',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should handle ABORT transition from workflow', async () => {
    // Scenario: plan returns second rule -> ABORT
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear, insufficient info.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Vague task with no details',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    // ABORT means workflow failed -> EXIT_WORKFLOW_FAILED (3)
    expect(exitCode).toBe(3);
  });

  it('should fail the pipeline when the semantic tag is missing', async () => {
    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Task without a status tag',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(3);
  });

  it.each(['backend-mini', 'frontend-mini'])('should complete %s through the shared mini core', async (workflow) => {
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nPlan completed.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation completed.' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI-ANTIPATTERN-REVIEW-2ND:1]\n\nApproved.' },
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:2]\n\nApproved.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Implement a focused backend change',
      workflow,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(getScenarioQueue()?.remaining).toBe(0);
  });

  it('should handle review reject → implement → review loop', async () => {
    setMockScenario([
      // First pass
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix loop
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Task needing a fix',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it.each([
    { name: 'root workflow', child: false },
    { name: 'workflow_call child', child: true },
  ])('should accept a pool with one eligible tier regardless of strategy without reporting it as unused for $name', async ({ child }) => {
    writeFileSync(join(testDir, '.takt', 'runtime.yaml'), `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: mock/default-model
    medium:
      provider: mock
      model: mock/medium-model
    router:
      provider: mock
      model: mock/router-model
  auto_routing:
    strategy: balanced
    router_profile: router
    pools:
      general:
        candidates:
          - profile: medium
            tier: medium
        fallback_profile: medium
`);

    if (child) {
      const workflowsDir = join(testDir, '.takt', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, 'invalid-auto.yaml'), `name: invalid-auto
subworkflow:
  callable: true
initial_step: child-step
max_steps: 2
steps:
  - name: child-step
    persona: ./.takt/personas/coder.md
    instruction: Run child work
    rules:
      - condition: done
        next: COMPLETE
`);
      workflowPath = join(testDir, 'invalid-auto-parent.yaml');
      writeFileSync(workflowPath, `name: invalid-auto-parent
initial_step: delegate
max_steps: 2
steps:
  - name: delegate
    kind: workflow_call
    call: invalid-auto
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    } else {
      workflowPath = join(testDir, 'invalid-auto-root.yaml');
      writeFileSync(workflowPath, `name: invalid-auto-root
initial_step: implement
max_steps: 2
steps:
  - name: implement
    persona: ./.takt/personas/coder.md
    instruction: Run root work
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    const execution = executePipeline({
      task: 'Reject invalid automatic routing strategy',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      autoStrategy: 'performance',
    });
    await expect(execution).resolves.toBe(0);
    expect(mockWorkflowWarn).not.toHaveBeenCalledWith(
      expect.stringMatching(/auto-strategy.*ignored/i),
    );
  });

  it('should not warn when runtime auto routing is effective on a conditional parent', async () => {
    writeChildAutoRoutingWorkflow(testDir, false);
    workflowPath = join(testDir, 'conditional-parent.yaml');
    writeFileSync(workflowPath, `name: conditional-parent
initial_step: choose
max_steps: 3
steps:
  - name: choose
    persona: ./.takt/personas/coder.md
    instruction: Choose whether to run child work
    rules:
      - condition: skip child
        next: finish
      - condition: run child
        next: delegate
  - name: delegate
    kind: workflow_call
    call: child-auto
    rules:
      - condition: COMPLETE
        next: COMPLETE
  - name: finish
    persona: ./.takt/personas/coder.md
    instruction: Finish without child work
    rules:
      - condition: done
        next: COMPLETE
`);
    setMockScenario([
      { persona: 'coder', status: 'done', content: '[CHOOSE:1]\n\nSkip child.' },
      { persona: 'coder', status: 'done', content: '[FINISH:1]\n\nDone.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Skip conditional child routing',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      autoStrategy: 'performance',
    });

    expect(exitCode).toBe(0);
    expect(mockWorkflowWarn).not.toHaveBeenCalledWith(
      expect.stringMatching(/auto-strategy.*ignored/i),
    );
  });

});
