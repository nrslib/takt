import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentResponse, WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import type { ReportPhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return { ...actual, RuleEvaluator: MockRuleEvaluator };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'approved', method: 'structured_output' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { REVIEW_COMPLETION_JUDGE_NAME } from '../core/workflow/review-completion.js';
import { resolveCompiledProviderEnvironment } from '../infra/config/runtime-provider/provider-environment.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
} from './engine-test-helpers.js';

const completion = {
  minRetry: 0,
  maxRetry: 1,
  retryInstruction: 'Recheck the identified gaps.',
};

function reviewStep(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep(name, {
    reviewCompletion: completion,
    outputContracts: [{ name: `${name}.md`, format: name, useJudge: false }],
    rules: [makeRule('approved', 'COMPLETE')],
    ...overrides,
  });
}

function normalConfig(step: WorkflowStep): WorkflowConfig {
  return {
    name: 'review-completion-normal',
    maxSteps: 1,
    initialStep: step.name,
    steps: [step],
  };
}

function reviewerResponse(persona: string, content: string, sessionId: string): AgentResponse {
  return makeResponse({ persona, content, sessionId });
}

function reviewerResponseWithoutSession(persona: string, content: string): AgentResponse {
  return {
    persona,
    status: 'done',
    content,
    timestamp: new Date(),
  };
}

function judgeResponse(complete: boolean): AgentResponse {
  return makeResponse({
    persona: 'review-completion-judge',
    content: 'decision',
    sessionId: 'must-not-be-reused',
    structuredOutput: {
      complete,
      reason: complete ? 'closed' : 'missing consumer',
      missing_obligations: complete ? [] : [{
        kind: 'family_lifecycle_gap',
        contract_family: 'config',
        path: 'consumer.ts',
        reason: 'not inspected',
      }],
    },
  });
}

describe('WorkflowEngine review completion wiring', () => {
  let cwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    cwd = createTestTmpDir();
  });

  afterEach(() => {
    cleanupWorkflowEngine(engine);
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it('runs the normal reviewer and fresh judge twice for min_retry and reports the latest session', async () => {
    const step = reviewStep('reviewer', {
      reviewCompletion: { ...completion, minRetry: 1 },
    });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    let reviewerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        expect(options.sessionId).toBeUndefined();
        return judgeResponse(true);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      reviewerCalls++;
      expect(options.sessionId).toBe(reviewerCalls === 1 ? undefined : 'review-session-1');
      return reviewerResponse(String(persona), `review-${reviewerCalls}`, `review-session-${reviewerCalls}`);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(reviewerCalls).toBe(2);
    expect(vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options.internalAgentName === 'review-completion-judge'
    ))).toHaveLength(2);
    expect(runReportPhase).toHaveBeenCalledOnce();
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as ReportPhaseRunnerContext;
    expect(phase2.getSessionId(phase2.resolveSessionKey(step))).toBe('review-session-2');
  });

  it('loads the review-completion judge runtime seat through to the common transport', async () => {
    const step = reviewStep('reviewer', {
      provider: 'mock',
      providerSpecified: true,
      reviewCompletion: { ...completion, maxRetry: 0 },
    });
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), stringifyYaml({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'mock', model: 'default-model' },
          judge: {
            provider: 'claude',
            model: 'judge-model',
            permission_mode: 'readonly',
            options: { allowed_tools: ['Read'] },
          },
        },
        targets: {
          internal_agents: {
            'review-completion-judge': { profile: 'judge' },
          },
        },
      },
    }));
    const legacy: LegacyProviderEnvironmentInput = {
      provider: 'mock',
      providerSource: 'default',
      model: undefined,
      modelSource: 'default',
      personaProviders: undefined,
      providerRouting: undefined,
      autoRouting: undefined,
      providerOptions: undefined,
    };
    const environment = resolveCompiledProviderEnvironment({
      projectCwd: cwd,
      legacy,
      legacySignals: [],
    });
    expect(environment.internalAgents?.reviewCompletionJudge).toEqual({
      provider: 'claude',
      model: 'judge-model',
      permissionMode: 'readonly',
      providerOptions: { claude: { allowedTools: ['Read'] } },
    });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', {
      projectCwd: cwd,
      provider: environment.provider,
      providerSource: environment.providerSource,
      model: environment.model,
      modelSource: environment.modelSource,
      providerOptions: environment.providerOptions,
      providerPermissionMode: environment.permissionMode,
      internalAgentSeats: environment.internalAgents,
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        expect(options.sessionId).toBeUndefined();
        expect(options.resolvedExecution).toEqual({
          provider: 'claude',
          model: 'judge-model',
          permissionMode: 'readonly',
          providerOptions: { claude: { allowedTools: ['Read'] } },
        });
        expect(options.allowedTools).toEqual(['Read']);
        expect(options.failureDir).toContain('.takt');
        return judgeResponse(true);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return reviewerResponse(String(persona), 'review', 'review-session');
    });

    await expect(engine.run()).resolves.toMatchObject({ status: 'completed' });
  });

  it('clears the normal reviewer session after double-empty recovery succeeds fresh without one', async () => {
    const step = reviewStep('reviewer');
    const delegatedUsage = vi.fn();
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', {
      projectCwd: cwd,
      provider: 'mock',
      onDelegatedAgentUsage: delegatedUsage,
    });
    let reviewerCalls = 0;
    let judgeCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeCalls += 1;
        return judgeResponse(judgeCalls === 2);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      reviewerCalls += 1;
      expect(options.sessionId).toBe([
        undefined,
        'review-session',
        'review-session',
        undefined,
      ][reviewerCalls - 1]);
      if (reviewerCalls === 1) {
        return reviewerResponse(String(persona), 'initial review', 'review-session');
      }
      return reviewerResponseWithoutSession(
        String(persona),
        reviewerCalls < 4 ? '  ' : 'fresh review',
      );
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(reviewerCalls).toBe(4);
    const reviewerUsage = delegatedUsage.mock.calls
      .filter(([context]) => context.step === step.name)
      .map(([, result]) => result.success);
    expect(reviewerUsage.length).toBeGreaterThan(0);
    expect(reviewerUsage).not.toContain(false);
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as ReportPhaseRunnerContext;
    expect(phase2.getSessionId(phase2.resolveSessionKey(step))).toBeUndefined();
  });

  it('includes bounded repository source and diff in the judge prompt without relying on tools', async () => {
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const version = 1;\n');
    execFileSync('git', ['add', 'review-target.ts'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const version = 2;\n');
    const step = reviewStep('reviewer', {
      reviewCompletion: { ...completion, maxRetry: 0 },
    });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    let judgeInstruction: string | undefined;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeInstruction = instruction;
        expect(options.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
        return judgeResponse(true);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return reviewerResponse(String(persona), 'review report', 'review-session');
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const judgePayload = JSON.parse(judgeInstruction!.slice(judgeInstruction!.indexOf('{')));
    expect(judgePayload.repository_evidence.files).toEqual([expect.objectContaining({
      path: 'review-target.ts',
      content: 'export const version = 2;\n',
    })]);
    expect(judgePayload.repository_evidence.diff).toMatch(/-export const version = 1;[\s\S]*\+export const version = 2;/);
  });

  it('adds a tracked consumer claimed by the structured reviewer output to judge evidence', async () => {
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const version = 1;\n');
    writeFileSync(`${cwd}/consumer.ts`, 'export const consumer = true;\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const version = 2;\n');
    const step = reviewStep('reviewer', { reviewCompletion: { ...completion, maxRetry: 0 } });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    let judgeInstruction = '';
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeInstruction = instruction;
        return judgeResponse(true);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return makeResponse({
        persona: String(persona),
        content: 'consumer.ts is an affected consumer',
        sessionId: 'review-session',
        structuredOutput: {
          rawFindings: [{
            candidate: {
              target: { kind: 'code', paths: ['consumer.ts'] },
              evidenceRequests: [],
            },
          }],
        },
      });
    });

    await engine.run();

    const judgePayload = JSON.parse(judgeInstruction.slice(judgeInstruction.indexOf('{')));
    expect(judgePayload.repository_evidence.files).toEqual([
      expect.objectContaining({ path: 'review-target.ts' }),
    ]);
    expect(judgePayload.repository_evidence.claimedPaths).toEqual(['consumer.ts']);
    expect(judgeInstruction).not.toContain('export const consumer = true');
  });

  it('validates and adds a prior judge gap path to the next attempt evidence', async () => {
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const version = 1;\n');
    writeFileSync(`${cwd}/consumer.ts`, 'export const consumer = true;\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const version = 2;\n');
    const step = reviewStep('reviewer');
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    const judgeInstructions: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeInstructions.push(instruction);
        return judgeInstructions.length === 1 ? makeResponse({
          persona: 'review-completion-judge',
          content: 'decision',
          structuredOutput: {
            complete: false,
            reason: 'consumer not checked',
            missing_obligations: [{
              kind: 'family_lifecycle_gap',
              contract_family: 'consumer',
              path: 'consumer.ts',
              reason: 'consumer path is unverified',
            }],
          },
        }) : judgeResponse(true);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return reviewerResponse(String(persona), 'review report', 'review-session');
    });

    await engine.run();

    const secondPayload = JSON.parse(judgeInstructions[1]!.slice(judgeInstructions[1]!.indexOf('{')));
    expect(secondPayload.repository_evidence.files).toEqual([
      expect.objectContaining({ path: 'review-target.ts' }),
    ]);
    expect(secondPayload.repository_evidence.priorGapPaths).toEqual(['consumer.ts']);
    expect(judgeInstructions[1]).not.toContain('export const consumer = true');
  });

  it('retries a reviewer with no findings when metadata exposes an unvisited consumer', async () => {
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const stableContract = 1;\n');
    writeFileSync(
      `${cwd}/consumer.ts`,
      'import { stableContract } from "./review-target.js";\nconst privateConsumerBody = stableContract;\n',
    );
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    writeFileSync(`${cwd}/review-target.ts`, 'export const stableContract = 2;\n');
    const step = reviewStep('reviewer');
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    const judgeInstructions: string[] = [];
    let reviewerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeInstructions.push(instruction);
        const payload = JSON.parse(instruction.slice(instruction.indexOf('{')));
        const consumerWasDiscovered = payload.repository_evidence.references.some(
          (reference: { path: string }) => reference.path === 'consumer.ts',
        );
        const reviewerCoveredConsumer = payload.reviewer_report.includes('consumer.ts');
        return consumerWasDiscovered && !reviewerCoveredConsumer
          ? makeResponse({
            persona: 'review-completion-judge',
            content: 'decision',
            structuredOutput: {
              complete: false,
              reason: 'tracked consumer was not reviewed',
              missing_obligations: [{
                kind: 'family_lifecycle_gap',
                contract_family: 'stableContract',
                path: 'consumer.ts',
                reason: 'metadata identifies an unvisited consumer',
              }],
            },
          })
          : judgeResponse(true);
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      reviewerCalls += 1;
      return makeResponse({
        persona: String(persona),
        content: reviewerCalls === 1 ? 'changed target reviewed' : 'consumer.ts reviewed',
        sessionId: `review-session-${reviewerCalls}`,
        structuredOutput: { rawFindings: [] },
      });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(reviewerCalls).toBe(2);
    const firstPayload = JSON.parse(judgeInstructions[0]!.slice(judgeInstructions[0]!.indexOf('{')));
    expect(firstPayload.repository_evidence.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'consumer.ts',
        line: 1,
        relationKind: 'module_name',
        seed: 'review-target',
      }),
    ]));
    expect(judgeInstructions.join('\n')).not.toContain('privateConsumerBody');
  });

  it('keeps parallel reviewer completion episodes independent', async () => {
    const reviewerA = reviewStep('reviewer-a');
    const reviewerB = reviewStep('reviewer-b');
    const parent = makeStep('reviewers', {
      parallel: [reviewerA, reviewerB],
      rules: [makeRule('all("approved")', 'COMPLETE')],
    });
    const delegatedUsage = vi.fn();
    engine = new WorkflowEngine({
      name: 'review-completion-parallel',
      maxSteps: 1,
      initialStep: parent.name,
      steps: [parent],
    }, cwd, 'task', {
      projectCwd: cwd,
      provider: 'mock',
      onDelegatedAgentUsage: delegatedUsage,
    });
    const reviewerCalls = new Map<string, number>();
    const reviewerBSessions: Array<string | undefined> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        return judgeResponse(!instruction.includes('reviewer-b-first'));
      }
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      const name = String(persona).includes('reviewer-a') ? 'reviewer-a' : 'reviewer-b';
      const count = (reviewerCalls.get(name) ?? 0) + 1;
      reviewerCalls.set(name, count);
      if (name === 'reviewer-b') {
        reviewerBSessions.push(options.sessionId);
        if (count === 1) {
          return reviewerResponse(name, `${name}-first`, `${name}-session-1`);
        }
        return reviewerResponseWithoutSession(name, count < 4 ? '  ' : `${name}-fresh`);
      }
      return reviewerResponse(name, `${name}-first`, `${name}-session-1`);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(Object.fromEntries(reviewerCalls)).toEqual({ 'reviewer-a': 1, 'reviewer-b': 4 });
    expect(reviewerBSessions).toEqual([
      undefined,
      'reviewer-b-session-1',
      'reviewer-b-session-1',
      undefined,
    ]);
    const reviewerBUsage = delegatedUsage.mock.calls
      .filter(([context]) => context.step === 'reviewer-b')
      .map(([, result]) => result.success);
    expect(reviewerBUsage.length).toBeGreaterThan(0);
    expect(reviewerBUsage).not.toContain(false);
    expect(runReportPhase).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runReportPhase).mock.calls.map(([reportedStep]) => reportedStep.name).sort())
      .toEqual(['reviewer-a', 'reviewer-b']);
    const reviewerBPhase2 = vi.mocked(runReportPhase).mock.calls
      .find(([reportedStep]) => reportedStep.name === 'reviewer-b')![2] as ReportPhaseRunnerContext;
    expect(reviewerBPhase2.getSessionId(reviewerBPhase2.resolveSessionKey(reviewerB))).toBeUndefined();
  });

  it('keeps a judge failure in Phase 2 without leaking it to response, state, or Phase 3', async () => {
    const step = reviewStep('reviewer', {
      reviewCompletion: { ...completion, maxRetry: 0 },
      rules: [makeRule('approved', 'COMPLETE'), makeRule('rejected', 'ABORT')],
    });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') throw new Error('judge unavailable');
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return reviewerResponse(String(persona), 'authoritative report', 'review-session');
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as ReportPhaseRunnerContext;
    expect(phase2.reviewCompletionDiagnostic).toContain('judge_unavailable');
    const phase3 = vi.mocked(runStatusJudgmentPhase).mock.calls[0]![1] as Record<string, unknown>;
    expect(phase3).not.toHaveProperty('reviewCompletionDiagnostic');
    expect(state.stepOutputs.get(step.name)?.content).toBe('authoritative report');
    expect(vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options.internalAgentName !== 'review-completion-judge'
    ))).toHaveLength(1);
    expect(JSON.stringify([...state.structuredOutputs.values()])).not.toContain('judge_unavailable');
  });

  it('preserves a judge provider-resolution failure when usage cannot be attributed', async () => {
    const step = reviewStep('reviewer', {
      reviewCompletion: { ...completion, maxRetry: 0 },
    });
    const resolveStepProviderModel = OptionsBuilder.prototype.resolveStepProviderModel;
    const providerResolution = vi
      .spyOn(OptionsBuilder.prototype, 'resolveStepProviderModel')
      .mockImplementation(function (candidate, runtime) {
        if (candidate.providerRoutingPersonaKey === REVIEW_COMPLETION_JUDGE_NAME) {
          throw new Error('judge provider resolution failed');
        }
        return resolveStepProviderModel.call(this, candidate, runtime);
      });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return reviewerResponse(String(persona), 'authoritative report', 'review-session');
    });

    const state = await engine.run().finally(() => providerResolution.mockRestore());

    expect(state.status).toBe('completed');
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as ReportPhaseRunnerContext;
    expect(phase2.reviewCompletionDiagnostic).toContain('judge provider resolution failed');
    expect(phase2.reviewCompletionDiagnostic).not.toContain('has no resolved provider');
  });

  it('stops before the mandatory retry when min_retry is one and the judge stays unavailable', async () => {
    const step = reviewStep('reviewer', {
      reviewCompletion: { ...completion, minRetry: 1, maxRetry: 2 },
    });
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    let reviewerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') throw new Error('judge unavailable');
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      reviewerCalls++;
      return reviewerResponse(String(persona), `review-${reviewerCalls}`, `session-${reviewerCalls}`);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(reviewerCalls).toBe(1);
    expect(state.stepOutputs.get(step.name)?.content).toBe('review-1');
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as ReportPhaseRunnerContext;
    expect(phase2.reviewCompletionDiagnostic).toContain('judge_unavailable');
    expect(phase2.reviewCompletionDiagnostic).toContain('attempts: 1');
    expect(phase2.reviewCompletionDiagnostic).toContain('retries_used: 0');
  });

  it('fails soft at the engine boundary when the reviewer retry throws', async () => {
    const step = reviewStep('reviewer');
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', { projectCwd: cwd, provider: 'mock' });
    let reviewerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') return judgeResponse(false);
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      reviewerCalls++;
      if (reviewerCalls > 1) throw new Error('retry failed');
      return reviewerResponse(String(persona), 'latest valid report', 'review-session');
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get(step.name)?.content).toBe('latest valid report');
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as ReportPhaseRunnerContext;
    expect(phase2.reviewCompletionDiagnostic).toContain('reviewer_retry_failed');
  });

  it('propagates a parent abort raised during the reviewer retry', async () => {
    const controller = new AbortController();
    const step = reviewStep('reviewer');
    engine = new WorkflowEngine(normalConfig(step), cwd, 'task', {
      projectCwd: cwd,
      provider: 'mock',
      abortSignal: controller.signal,
    });
    let reviewerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') return judgeResponse(false);
      options.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      reviewerCalls++;
      if (reviewerCalls > 1) {
        controller.abort(new Error('parent stopped'));
        const error = new Error('parent stopped');
        error.name = 'AbortError';
        throw error;
      }
      return reviewerResponse(String(persona), 'latest valid report', 'review-session');
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(runReportPhase).not.toHaveBeenCalled();
  });
});
