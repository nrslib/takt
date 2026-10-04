import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/index.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

const terminalMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({ id: 'tmux-session', name: 'takt-claude-terminal' }),
  pasteText: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
  findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
  waitForAssistantResponse: vi.fn().mockResolvedValue({
    sessionId: 'claude-session-1',
    assistantText: 'done',
    events: [],
  }),
}));

vi.mock('../infra/claude/cli-capability.js', () => ({
  assertClaudeSkillsDisableSupported: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../infra/claude-terminal/tmux-backend.js', () => ({
  TmuxTerminalBackend: vi.fn().mockImplementation(() => ({
    start: terminalMocks.start,
    pasteText: terminalMocks.pasteText,
    stop: terminalMocks.stop,
  })),
}));

vi.mock('../infra/claude-terminal/transcript-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/claude-terminal/transcript-reader.js')>();
  return {
    ...actual,
    ProjectClaudeTranscriptReader: vi.fn().mockImplementation(() => ({
      readBaseline: terminalMocks.readBaseline,
      findSession: terminalMocks.findSession,
      waitForAssistantResponse: terminalMocks.waitForAssistantResponse,
    })),
  };
});

function makeConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        provider: 'claude-terminal',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      },
    ],
  };
}

function makeReportConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow-report',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        provider: 'claude-terminal',
        outputContracts: [{ name: 'report.md', format: '# Report' }],
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      },
    ],
  };
}

function makeMultiRuleConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow-phase3',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        provider: 'claude-terminal',
        rules: [
          normalizeRule({ condition: 'done', next: 'COMPLETE' }),
          normalizeRule({ condition: 'fix', next: 'implement' }),
        ],
      },
    ],
  };
}

function makeReviewFixConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow-review-fix',
    maxSteps: 3,
    initialStep: 'review',
    steps: [
      {
        name: 'review',
        personaDisplayName: 'review',
        instruction: 'Review {task}',
        provider: 'claude-terminal',
        outputContracts: [{ name: 'review.md', format: '# Review' }],
        rules: [normalizeRule({ condition: 'done', next: 'fix' })],
      },
      {
        name: 'fix',
        personaDisplayName: 'fix',
        instruction: 'Fix using {report:review.md}',
        provider: 'claude-terminal',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      },
    ],
  };
}

describe('executeWorkflow claude-terminal integration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    terminalMocks.start.mockResolvedValue({ id: 'tmux-session', name: 'takt-claude-terminal' });
    terminalMocks.pasteText.mockResolvedValue(undefined);
    terminalMocks.stop.mockResolvedValue(undefined);
    terminalMocks.readBaseline.mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 });
    terminalMocks.findSession.mockResolvedValue({ sessionId: 'claude-session-1' });
    terminalMocks.waitForAssistantResponse.mockResolvedValue({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    projectDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-workflow-'));
    globalConfigDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
  });

  afterEach(async () => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(globalConfigDir, { recursive: true, force: true });
  });

  it('Given workflow root deny ask handler, When claude-terminal runs through executeWorkflow, Then terminal startup is not blocked', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledOnce();
    expect(terminalMocks.pasteText).toHaveBeenCalledOnce();
    expect(terminalMocks.waitForAssistantResponse).toHaveBeenCalledOnce();
    expect(terminalMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      cwd: projectDir,
      backend: 'tmux',
    }));
  });

  it('Given global claude sandbox option, When claude-terminal runs, Then sandbox option does not abort the workflow', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      providerOptions: {
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledOnce();
  });

  it('Given claude-terminal step with outputContracts, When report phase runs, Then internal maxTurns does not fail the provider', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    terminalMocks.waitForAssistantResponse
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: 'done',
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: '# report',
        events: [],
      });

    const result = await executeWorkflow(makeReportConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledTimes(2);
    expect(terminalMocks.waitForAssistantResponse).toHaveBeenCalledTimes(2);
  });

  it('Given claude-terminal step with multiple rules, When phase 3 judgment runs, Then internal maxTurns does not fail the provider', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    terminalMocks.waitForAssistantResponse
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: 'work complete',
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: '{"step":1,"reason":"done"}',
        events: [],
      });

    const result = await executeWorkflow(makeMultiRuleConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledTimes(2);
    expect(terminalMocks.waitForAssistantResponse).toHaveBeenCalledTimes(2);
  });

  it('bootstrap失敗後も解決済みoperation lineageを次のdistinct resumeへ引き継ぐ', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const sourceRunSlug = '20260801-bootstrap-source';
    const failedRunSlug = '20260801-bootstrap-failed';
    const resumedRunSlug = '20260801-bootstrap-resumed';

    await executeWorkflow(makeConfig(), 'source task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: sourceRunSlug,
    });
    const sourceMetaPath = join(projectDir, '.takt', 'runs', sourceRunSlug, 'meta.json');
    const sourceMeta = JSON.parse(await readFile(sourceMetaPath, 'utf-8')) as {
      status: string;
      operation_journal_run_slug?: string;
    };
    sourceMeta.status = 'failed';
    await writeFile(sourceMetaPath, JSON.stringify(sourceMeta), 'utf-8');
    await expect(executeWorkflow(makeConfig(), 'failed target task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: failedRunSlug,
      resumeSource: { sourceRunSlug, resumeMode: 'requeue' },
      taskSpec: {
        runSlug: failedRunSlug,
        sourceTaskDir: join(projectDir, 'missing-task-source'),
        attachmentManifest: [{
          relativePath: 'attachments/missing.png',
          kind: 'file',
          contentSha256: 'a'.repeat(64),
        }],
        taskPrompt: 'missing task prompt',
        orderContent: 'missing task',
        stagedOrderContent: 'missing task',
      },
    })).rejects.toThrow();
    const failedMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', failedRunSlug, 'meta.json'),
      'utf-8',
    )) as {
      status: string;
      source_run_slug?: string;
      operation_journal_run_slug?: string;
      operation_claim_token?: string;
    };
    expect(failedMeta).toMatchObject({
      status: 'failed',
      source_run_slug: sourceRunSlug,
      operation_journal_run_slug: sourceMeta.operation_journal_run_slug,
      operation_claim_token: expect.any(String),
    });
    terminalMocks.waitForAssistantResponse
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: 'work complete',
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: '{"step":1,"reason":"done"}',
        events: [],
      });
    const resumed = await executeWorkflow(makeMultiRuleConfig(), 'resumed target task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: resumedRunSlug,
      resumeSource: { sourceRunSlug: failedRunSlug, resumeMode: 'requeue' },
    });
    expect(resumed.success).toBe(true);
    const resumedMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', resumedRunSlug, 'meta.json'),
      'utf-8',
    )) as { workflow: string };
    expect(resumedMeta.workflow).toBe('claude-terminal-workflow-phase3');
  });

  it.each([
    {
      label: 'missing source',
      sourceRunSlug: '20260801-lineage-source-missing',
      fallbackRunSlug: '20260801-lineage-missing-fallback',
      resumedRunSlug: '20260801-lineage-missing-resumed',
      seedIncompleteSource: false,
    },
    {
      label: 'incomplete source',
      sourceRunSlug: '20260801-lineage-source-incomplete',
      fallbackRunSlug: '20260801-lineage-incomplete-fallback',
      resumedRunSlug: '20260801-lineage-incomplete-resumed',
      seedIncompleteSource: true,
    },
  ])('operation lineage unavailable時もartifact sourceを公開せず後続requeueを同一journalで実行する ($label)', async ({
    sourceRunSlug,
    fallbackRunSlug,
    resumedRunSlug,
    seedIncompleteSource,
  }) => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    if (seedIncompleteSource) {
      await executeWorkflow(makeConfig(), 'incomplete source task', projectDir, {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: sourceRunSlug,
      });
      const sourceMetaPath = join(projectDir, '.takt', 'runs', sourceRunSlug, 'meta.json');
      const sourceMeta = JSON.parse(await readFile(sourceMetaPath, 'utf-8')) as Record<string, unknown>;
      delete sourceMeta.operation_claim_token;
      await writeFile(sourceMetaPath, JSON.stringify(sourceMeta), 'utf-8');
    }

    const fallback = await executeWorkflow(makeConfig(), 'fallback source task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: fallbackRunSlug,
      resumeSource: {
        sourceRunSlug,
        resumeMode: 'requeue',
      },
    });
    expect(fallback.success).toBe(true);

    const fallbackMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', fallbackRunSlug, 'meta.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect(fallbackMeta).toMatchObject({
      operation_journal_run_slug: fallbackRunSlug,
      operation_claim_token: expect.any(String),
    });
    expect(fallbackMeta).not.toHaveProperty('source_run_slug');
    expect(fallbackMeta).not.toHaveProperty('resume_mode');

    const resumed = await executeWorkflow(makeConfig(), 'resumed fallback task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: resumedRunSlug,
      resumeSource: {
        sourceRunSlug: fallbackRunSlug,
        resumeMode: 'requeue',
      },
    });
    expect(resumed.success).toBe(true);

    const resumedMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', resumedRunSlug, 'meta.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect(resumedMeta).toMatchObject({
      source_run_slug: fallbackRunSlug,
      operation_journal_run_slug: fallbackRunSlug,
      operation_claim_token: expect.any(String),
    });
  });

  it('fallback時のbootstrap失敗でもsourceを公開せず、後続requeueを同一journalで実行する', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const fallbackRunSlug = '20260801-lineage-terminal-fallback';
    const resumedRunSlug = '20260801-lineage-terminal-resumed';
    const missingAttachmentPath = join(
      projectDir,
      'missing-task-source',
      'attachments',
      'missing.png',
    );

    await expect(executeWorkflow(makeConfig(), 'fallback bootstrap failure', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: fallbackRunSlug,
      resumeSource: {
        sourceRunSlug: '20260801-lineage-terminal-source-missing',
        resumeMode: 'requeue',
      },
      taskSpec: {
        runSlug: fallbackRunSlug,
        sourceTaskDir: join(projectDir, 'missing-task-source'),
        attachmentManifest: [{
          relativePath: 'attachments/missing.png',
          kind: 'file',
          contentSha256: 'a'.repeat(64),
        }],
        taskPrompt: 'missing task prompt',
        orderContent: 'missing task',
        stagedOrderContent: 'missing task',
      },
    })).rejects.toThrow(`Task attachment is missing: ${missingAttachmentPath}`);

    const fallbackMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', fallbackRunSlug, 'meta.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect(fallbackMeta).toMatchObject({
      status: 'failed',
      operation_journal_run_slug: fallbackRunSlug,
      operation_claim_token: expect.any(String),
    });
    expect(fallbackMeta).not.toHaveProperty('source_run_slug');
    expect(fallbackMeta).not.toHaveProperty('resume_mode');

    const resumed = await executeWorkflow(makeConfig(), 'resumed terminal fallback', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: resumedRunSlug,
      resumeSource: {
        sourceRunSlug: fallbackRunSlug,
        resumeMode: 'requeue',
      },
    });
    expect(resumed.success).toBe(true);

    const resumedMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', resumedRunSlug, 'meta.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect(resumedMeta).toMatchObject({
      source_run_slug: fallbackRunSlug,
      operation_journal_run_slug: fallbackRunSlug,
      operation_claim_token: expect.any(String),
    });
  });

  it('snapshot失敗時もartifact専用sourceでEngineのreview report継承を継続する', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const workflow = makeReviewFixConfig();
    const sourceRunSlug = '20260801-engine-artifact-source';
    const targetRunSlug = '20260801-engine-artifact-target';
    const sourceRunRoot = join(projectDir, '.takt', 'runs', sourceRunSlug);
    const sourceReports = join(sourceRunRoot, 'reports');
    await mkdir(sourceReports, { recursive: true });
    await writeFile(join(sourceReports, 'review.md'), '# valid review\n', 'utf-8');
    const outsideReport = join(projectDir, 'outside-review.md');
    await writeFile(outsideReport, 'outside', 'utf-8');
    await symlink(outsideReport, join(sourceReports, 'invalid-link.md'));
    await writeFile(join(sourceRunRoot, 'meta.json'), JSON.stringify({
      task: 'source task',
      workflow: workflow.name,
      runSlug: sourceRunSlug,
      runRoot: `.takt/runs/${sourceRunSlug}`,
      reportDirectory: `.takt/runs/${sourceRunSlug}/reports`,
      contextDirectory: `.takt/runs/${sourceRunSlug}/context`,
      logsDirectory: `.takt/runs/${sourceRunSlug}/logs`,
      status: 'failed',
      startTime: '2026-08-01T00:00:00.000Z',
      operation_journal_run_slug: sourceRunSlug,
    }), 'utf-8');

    const resumePoint: WorkflowResumePoint = {
      version: 2,
      stack: [{
        workflow: workflow.name,
        workflow_ref: workflow.name,
        step: 'fix',
        kind: 'agent',
        occurrence: 1,
        step_iterations: { review: 1 },
      }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {
        [buildWorkflowStepParticipationIdentity(workflow.name, 'review', [])]: {
          report_names: ['review.md'],
        },
      },
    };
    const result = await executeWorkflow(workflow, 'resume artifact task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: targetRunSlug,
      startStep: 'fix',
      resumePoint,
      resumeSource: { sourceRunSlug, resumeMode: 'requeue' },
    });

    expect(result.success).toBe(true);
    expect(await readFile(
      join(projectDir, '.takt', 'runs', targetRunSlug, 'reports', 'review.md'),
      'utf-8',
    )).toBe('# valid review\n');
    expect(existsSync(
      join(projectDir, '.takt', 'runs', targetRunSlug, 'reports', 'invalid-link.md'),
    )).toBe(false);
    expect(existsSync(
      join(projectDir, '.takt', 'runs', targetRunSlug, 'reports', 'resume-artifacts.json'),
    )).toBe(false);
    const targetMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', targetRunSlug, 'meta.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect(targetMeta).not.toHaveProperty('source_run_slug');
    expect(targetMeta).toMatchObject({
      operation_journal_run_slug: targetRunSlug,
      operation_claim_token: expect.any(String),
    });
  });

});
