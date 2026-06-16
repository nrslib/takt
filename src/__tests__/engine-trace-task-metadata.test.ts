import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowConfig } from '../core/models/index.js';
import type {
  StepSpanParams,
  WorkflowSpanParams,
} from '../core/workflow/observability/workflowSpans.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/index.js')>('../shared/utils/index.js');
  return {
    ...actual,
    generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  };
});

const {
  workflowSpanParams,
  stepSpanParams,
  mockRunWithWorkflowSpan,
  mockRunWithStepSpan,
} = vi.hoisted(() => ({
  workflowSpanParams: [] as WorkflowSpanParams[],
  stepSpanParams: [] as StepSpanParams[],
  mockRunWithWorkflowSpan: vi.fn(async (
    params: WorkflowSpanParams,
    execute: () => Promise<unknown>,
  ) => {
    workflowSpanParams.push(params);
    return execute();
  }),
  mockRunWithStepSpan: vi.fn(async (
    params: StepSpanParams,
    execute: () => Promise<unknown>,
  ) => {
    stepSpanParams.push(params);
    return execute();
  }),
}));

vi.mock('../core/workflow/observability/workflowSpans.js', async () => {
  const actual = await vi.importActual<typeof import('../core/workflow/observability/workflowSpans.js')>(
    '../core/workflow/observability/workflowSpans.js',
  );
  return {
    ...actual,
    runWithWorkflowSpan: mockRunWithWorkflowSpan,
    runWithStepSpan: mockRunWithStepSpan,
  };
});

import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { createTestTmpDir } from './engine-test-helpers.js';

function createWorkflowConfig(): WorkflowConfig {
  return {
    name: 'trace-metadata-workflow',
    initialStep: 'implement',
    maxSteps: 3,
    steps: [{
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
  };
}

describe('WorkflowEngine trace task metadata', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workflowSpanParams.length = 0;
    stepSpanParams.length = 0;
    tmpDir = createTestTmpDir();
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'done',
      timestamp: new Date('2026-06-14T00:00:00.000Z'),
    });
    vi.mocked(detectMatchedRule).mockResolvedValue({ index: 0, method: 'tag' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes trace task metadata and resolved run directory to workflow and step spans', async () => {
    const traceTaskMetadata = {
      taskName: 'task-827',
      taskSlug: 'add-trace-task-metadata',
      taskSummary: 'Add trace task metadata',
      taskSource: 'issue',
      issueNumber: 827,
      gitBranch: 'takt/827/add-trace-task-metadata',
      gitBaseBranch: 'main',
      worktreePath: join(tmpDir, 'worktree'),
    };
    const options = {
      projectCwd: tmpDir,
      observability: {
        enabled: true,
        monitor: false,
        sessionLogExporter: false,
        usageEventsPhase: false,
      },
      observabilityRunId: 'test-report-dir',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => 0,
      traceTaskMetadata,
    } satisfies WorkflowEngineOptions & {
      traceTaskMetadata: typeof traceTaskMetadata;
    };

    const engine = new WorkflowEngine(createWorkflowConfig(), tmpDir, 'Task body', options);
    await engine.run();

    const expectedMetadata = {
      ...traceTaskMetadata,
      runDir: join(tmpDir, '.takt', 'runs', 'test-report-dir'),
    };
    expect(workflowSpanParams[0]).toMatchObject({
      enabled: true,
      runId: 'test-report-dir',
      traceTaskMetadata: expectedMetadata,
    });
    expect(stepSpanParams[0]).toMatchObject({
      enabled: true,
      runId: 'test-report-dir',
      traceTaskMetadata: expectedMetadata,
    });
  });
});
