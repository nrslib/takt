import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type { AgentResponse } from '../core/models/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowLoader.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

function agentResponse(content: string, sessionId?: string): AgentResponse {
  return {
    persona: 'loop-analysis-test',
    status: 'done',
    content,
    timestamp: new Date('2026-08-20T00:00:00.000Z'),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function requireLoopAnalysisWorkflow(projectCwd: string): WorkflowConfig {
  const workflow = loadWorkflowByIdentifier('loop-analysis', projectCwd);
  if (workflow === null) {
    throw new Error('loop-analysis builtin workflow was not loaded');
  }
  return workflow;
}

function transitionIndex(
  workflow: WorkflowConfig,
  stepName: string,
  next: string,
): number {
  const step = workflow.steps.find((candidate) => candidate.name === stepName);
  const index = step?.rules?.findIndex((rule) => rule.next === next) ?? -1;
  if (index < 0) {
    throw new Error(`Missing ${stepName} transition to ${next}`);
  }
  return index;
}

describe('loop analysis builtin workflow integration', () => {
  let projectCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-it-'));
    const configDir = process.env.TAKT_CONFIG_DIR;
    if (configDir === undefined) {
      throw new Error('TAKT_CONFIG_DIR must be configured by the test environment');
    }
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      'language: en\nenable_builtin_workflows: true\n',
      'utf-8',
    );
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it('Given every review rejects, When the bounded loop reaches its third review, Then it aborts at the iteration limit and preserves the last report', async () => {
    const workflow = requireLoopAnalysisWorkflow(projectCwd);
    const analyzerName = workflow.initialStep;
    const reviewerName = workflow.steps.find((step) => step.name !== analyzerName)?.name;
    if (reviewerName === undefined) {
      throw new Error('loop-analysis reviewer step is missing');
    }
    const analyzeTransition = transitionIndex(workflow, analyzerName, reviewerName);
    const rejectTransition = transitionIndex(workflow, reviewerName, analyzerName);
    const finalReport = '# Loop analysis\n\nThird rejection remains available.';
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'loop analysis judge',
          userInstruction: 'select transition',
        });
        return {
          candidateIndex: options.stepName === analyzerName
            ? analyzeTransition
            : rejectTransition,
          method: 'structured_output',
        };
      }),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    };
    let reportCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      const isReportPhase = options?.allowedTools?.length === 0;
      if (isReportPhase) {
        reportCount += 1;
      }
      return agentResponse(
        isReportPhase && reportCount === 3
          ? finalReport
          : isReportPhase
            ? `# Loop analysis\n\nReport ${reportCount}`
            : 'Analysis step result',
        isReportPhase ? undefined : `session-${vi.mocked(runAgent).mock.calls.length}`,
      );
    });
    const visitedSteps: string[] = [];
    const iterationLimits: Array<[number, number]> = [];
    const engine = new WorkflowEngine(workflow, projectCwd, 'Inspect the source run', {
      projectCwd,
      provider: 'mock',
      reportDirName: 'loop-analysis-limit-it',
      structuredCaller,
    });
    engine.on('step:start', (step) => visitedSteps.push(step.name));
    engine.on('iteration:limit', (iteration, maxSteps) => {
      iterationLimits.push([iteration, maxSteps]);
    });

    const state = await engine.run();

    expect(state.status, JSON.stringify(state)).toBe('aborted');
    expect(state.iteration).toBe(6);
    expect(iterationLimits).toEqual([[6, 6]]);
    expect(visitedSteps).toEqual([
      analyzerName,
      reviewerName,
      analyzerName,
      reviewerName,
      analyzerName,
      reviewerName,
    ]);
    expect(reportCount).toBe(3);
    expect(readFileSync(join(
      projectCwd,
      '.takt',
      'runs',
      'loop-analysis-limit-it',
      'reports',
      'loop-analysis.md',
    ), 'utf-8')).toBe(finalReport);
  });

  it('Given two reviewer rejections, When the builtin runs, Then it executes three analyzer-reviewer pairs and completes on the third approval', async () => {
    const workflow = requireLoopAnalysisWorkflow(projectCwd);
    const analyzerName = workflow.initialStep;
    const reviewerName = workflow.steps.find((step) => step.name !== analyzerName)?.name;
    if (reviewerName === undefined) {
      throw new Error('loop-analysis reviewer step is missing');
    }
    const analyzeTransition = transitionIndex(workflow, analyzerName, reviewerName);
    const rejectTransition = transitionIndex(workflow, reviewerName, analyzerName);
    const approveTransition = transitionIndex(workflow, reviewerName, 'COMPLETE');
    let reviewerDecisions = 0;
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'loop analysis judge',
          userInstruction: 'select transition',
        });
        if (options.stepName === analyzerName) {
          return { candidateIndex: analyzeTransition, method: 'structured_output' };
        }
        reviewerDecisions += 1;
        return {
          candidateIndex: reviewerDecisions <= 2 ? rejectTransition : approveTransition,
          method: 'structured_output',
        };
      }),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      const isReportPhase = options?.allowedTools?.length === 0;
      return agentResponse(
        isReportPhase ? '# Loop analysis\n\nReview report' : 'Analysis step result',
        isReportPhase ? undefined : `session-${vi.mocked(runAgent).mock.calls.length}`,
      );
    });
    const visitedSteps: string[] = [];
    const engine = new WorkflowEngine(workflow, projectCwd, 'Inspect the source run', {
      projectCwd,
      provider: 'mock',
      reportDirName: 'loop-analysis-feedback-it',
      structuredCaller,
    });
    engine.on('step:start', (step) => visitedSteps.push(step.name));

    const state = await engine.run();

    expect(state.status, JSON.stringify(state)).toBe('completed');
    expect(state.iteration).toBe(6);
    expect(visitedSteps).toEqual([
      analyzerName,
      reviewerName,
      analyzerName,
      reviewerName,
      analyzerName,
      reviewerName,
    ]);
  });

  it('Given the reviewer approves, When its output contract runs, Then the exact final report is saved under the analysis run reports directory', async () => {
    const workflow = requireLoopAnalysisWorkflow(projectCwd);
    const analyzerName = workflow.initialStep;
    const reviewerName = workflow.steps.find((step) => step.name !== analyzerName)?.name;
    if (reviewerName === undefined) {
      throw new Error('loop-analysis reviewer step is missing');
    }
    const analyzeTransition = transitionIndex(workflow, analyzerName, reviewerName);
    const approveTransition = transitionIndex(workflow, reviewerName, 'COMPLETE');
    const finalReport = '# Loop analysis\n\nAccepted and rejected proposals with reasons.';
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'loop analysis judge',
          userInstruction: 'select transition',
        });
        return {
          candidateIndex: options.stepName === analyzerName
            ? analyzeTransition
            : approveTransition,
          method: 'structured_output',
        };
      }),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      const isReportPhase = options?.allowedTools?.length === 0;
      return agentResponse(
        isReportPhase ? finalReport : 'Analysis step result',
        isReportPhase ? undefined : `session-${vi.mocked(runAgent).mock.calls.length}`,
      );
    });
    const engine = new WorkflowEngine(workflow, projectCwd, 'Inspect the source run', {
      projectCwd,
      provider: 'mock',
      reportDirName: 'loop-analysis-report-it',
      structuredCaller,
    });

    const state = await engine.run();

    expect(state.status, JSON.stringify(state)).toBe('completed');
    expect(readFileSync(join(
      projectCwd,
      '.takt',
      'runs',
      'loop-analysis-report-it',
      'reports',
      'loop-analysis.md',
    ), 'utf-8')).toBe(finalReport);
  });
});
