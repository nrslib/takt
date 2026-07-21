import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const { mockWorkflowLogger } = vi.hoisted(() => ({
  mockWorkflowLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => mockWorkflowLogger),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { resolveInheritedReviewReportNamesWithDiagnostics } from '../core/workflow/review-report-discovery.js';
import type { WorkflowConfig, WorkflowResumePointEntry } from '../core/models/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  makeResponse,
  makeRule,
  makeStep,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

function writeReport(reportDir: string, fileName: string, content: string): void {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, fileName), content);
}

function createWorktreeDirs(): { baseDir: string; projectCwd: string; cloneCwd: string; reportDir: string } {
  const baseDir = join(tmpdir(), `takt-report-handles-${randomUUID()}`);
  const projectCwd = join(baseDir, 'project');
  const cloneCwd = join(baseDir, 'clone');
  const reportDir = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports');

  mkdirSync(join(projectCwd, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  return { baseDir, projectCwd, cloneCwd, reportDir };
}

function buildParallelReviewerConfig(): WorkflowConfig {
  return {
    name: 'reviewer-peer-reports',
    description: 'Peer report handle test',
    maxSteps: 5,
    initialStep: 'reviewers',
    steps: [
      makeStep('reviewers', {
        parallel: [
          makeStep('arch-review', {
            instruction: 'Peer reports:\n{peer_reports}',
            passPreviousResponse: false,
            outputContracts: [{ name: '05-arch-review.md', format: '# Arch Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
          makeStep('security-review', {
            instruction: 'Peer reports:\n{peer_reports}',
            passPreviousResponse: false,
            outputContracts: [{ name: '06-security-review.md', format: '# Security Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
        ],
        rules: [
          makeRule('all("approved")', 'COMPLETE', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'approved',
          }),
        ],
      }),
    ],
  };
}

function buildFixHandleConfig(): WorkflowConfig {
  return {
    name: 'fix-report-handles',
    description: 'Current and peer report handle test',
    maxSteps: 5,
    initialStep: 'fix',
    steps: [
      makeStep('reviewers', {
        parallel: [
          makeStep('arch-review', {
            instruction: 'arch review',
            passPreviousResponse: false,
            outputContracts: [{ name: '05-arch-review.md', format: '# Arch Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
          makeStep('security-review', {
            instruction: 'security review',
            passPreviousResponse: false,
            outputContracts: [{ name: '06-security-review.md', format: '# Security Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
        ],
        rules: [
          makeRule('all("approved")', 'fix', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'approved',
          }),
        ],
      }),
      makeStep('fix', {
        instruction: [
          'Current: {current_report}',
          'Previous: {previous_report}',
          'History: {report_history}',
          'Peers: {peer_reports}',
        ].join('\n'),
        passPreviousResponse: false,
        outputContracts: [{ name: '07-fix.md', format: '# Fix Report' }],
        rules: [makeRule('Fix complete', 'COMPLETE')],
      }),
    ],
  };
}

function buildSuperviseHandleConfig(): WorkflowConfig {
  return {
    name: 'supervise-peer-reports',
    description: 'Supervise peer report handle test',
    maxSteps: 5,
    initialStep: 'reviewers',
    steps: [
      makeStep('reviewers', {
        parallel: [
          makeStep('arch-review', {
            instruction: 'arch review',
            passPreviousResponse: false,
            outputContracts: [{ name: '05-arch-review.md', format: '# Arch Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
          makeStep('security-review', {
            instruction: 'security review',
            passPreviousResponse: false,
            outputContracts: [{ name: '06-security-review.md', format: '# Security Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
        ],
        rules: [
          makeRule('all("approved")', 'supervise', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'approved',
          }),
        ],
      }),
      makeStep('supervise', {
        instruction: 'Peers:\n{peer_reports}',
        passPreviousResponse: false,
        rules: [makeRule('All checks passed', 'COMPLETE')],
      }),
    ],
  };
}

function buildMergeReadinessReviewerConfig(): WorkflowConfig {
  return {
    name: 'merge-readiness-reviewers',
    description: 'Nested reviewer reports',
    subworkflow: { callable: true },
    maxSteps: 2,
    initialStep: 'merge-readiness-reviewers',
    steps: [
      makeStep('merge-readiness-reviewers', {
        parallel: [
          makeStep('arch-review', {
            instruction: 'merge readiness architecture review',
            passPreviousResponse: false,
            outputContracts: [{ name: 'merge-readiness-arch-review.md', format: '# Merge Readiness Architecture Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
          makeStep('security-review', {
            instruction: 'merge readiness security review',
            passPreviousResponse: false,
            outputContracts: [{ name: 'merge-readiness-security-review.md', format: '# Merge Readiness Security Review' }],
            rules: [makeRule('approved', 'COMPLETE')],
          }),
        ],
        rules: [makeRule('all("approved")', 'COMPLETE', {
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
        })],
      }),
    ],
  };
}

function buildFinalGateReportConfig(): WorkflowConfig {
  return {
    name: 'merge-readiness-final-gate',
    description: 'Final gate report inheritance test',
    subworkflow: { callable: true },
    maxSteps: 2,
    initialStep: 'merge-readiness-reviewers',
    steps: [
      makeStep('merge-readiness-reviewers', {
        kind: 'workflow_call',
        call: 'merge-readiness-reviewers',
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      }),
    ],
  };
}

function buildParallelFinalGateReportConfig(): WorkflowConfig {
  return {
    name: 'parallel-merge-readiness-final-gate',
    description: 'Parallel final gate report inheritance test',
    subworkflow: { callable: true },
    maxSteps: 2,
    initialStep: 'merge-readiness-reviewers',
    steps: [
      makeStep('merge-readiness-reviewers', {
        parallel: [makeStep('merge-readiness-review', {
          kind: 'workflow_call',
          call: 'merge-readiness-reviewers',
          rules: [makeRule('COMPLETE', 'COMPLETE')],
        })],
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      }),
    ],
  };
}

describe('WorkflowEngine report handle integration', () => {
  let baseDir: string;
  let projectCwd: string;
  let cloneCwd: string;
  let reportDir: string;
  const engines: WorkflowEngine[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();

    const dirs = createWorktreeDirs();
    baseDir = dirs.baseDir;
    projectCwd = dirs.projectCwd;
    cloneCwd = dirs.cloneCwd;
    reportDir = dirs.reportDir;
  });

  afterEach(() => {
    for (const engine of engines) {
      cleanupWorkflowEngine(engine);
    }
    engines.length = 0;

    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('should inject sibling peer report paths for parallel reviewer sub-steps', async () => {
    // Given
    const config = buildParallelReviewerConfig();
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', { projectCwd });
    engines.push(engine);

    writeReport(reportDir, '05-arch-review.md', 'latest arch review');
    writeReport(reportDir, '06-security-review.md', 'latest security review');

    mockRunAgentSequence([
      makeResponse({ persona: 'arch-review', content: 'approved' }),
      makeResponse({ persona: 'security-review', content: 'approved' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');

    const runAgentMock = vi.mocked(runAgent);
    const archCall = runAgentMock.mock.calls.find((call) => call[0] === '../personas/arch-review.md');
    const securityCall = runAgentMock.mock.calls.find((call) => call[0] === '../personas/security-review.md');
    const archInstruction = archCall?.[1] ?? '';
    const securityInstruction = securityCall?.[1] ?? '';
    const archPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '05-arch-review.md');
    const securityPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '06-security-review.md');
    const archPeerSection = archInstruction.split('Peer reports:\n')[1] ?? '';
    const securityPeerSection = securityInstruction.split('Peer reports:\n')[1] ?? '';

    expect(archInstruction).toContain(archPath);
    expect(archInstruction).toContain(securityPath);
    expect(archPeerSection).toContain(securityPath);
    expect(archPeerSection).not.toContain(archPath);
    expect(securityInstruction).toContain(archPath);
    expect(securityInstruction).toContain(securityPath);
    expect(securityPeerSection).toContain(archPath);
    expect(securityPeerSection).not.toContain(securityPath);
  });

  it('should inject current previous history and peer report handles for fix step with clone-based paths', async () => {
    // Given
    const config = buildFixHandleConfig();
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', { projectCwd });
    engines.push(engine);

    writeReport(reportDir, '05-arch-review.md', 'latest arch review');
    writeReport(reportDir, '06-security-review.md', 'latest security review');
    writeReport(reportDir, '07-fix.md', 'latest fix report');
    writeReport(reportDir, '07-fix.md.20260420T010000Z', 'previous fix report');
    writeReport(reportDir, '07-fix.md.20260419T230000Z', 'older fix report');

    mockRunAgentSequence([
      makeResponse({ persona: 'fix', content: 'Fix complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');

    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1];
    const latestFixPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '07-fix.md');
    const previousFixPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '07-fix.md.20260420T010000Z');
    const olderFixPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '07-fix.md.20260419T230000Z');
    const archPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '05-arch-review.md');
    const securityPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '06-security-review.md');

    expect(instruction).toContain(latestFixPath);
    expect(instruction).toContain(previousFixPath);
    expect(instruction).toContain(olderFixPath);
    expect(instruction).toContain(archPath);
    expect(instruction).toContain(securityPath);
    expect(instruction).not.toContain(join(projectCwd, '.takt', 'runs', 'test-report-dir', 'reports', '07-fix.md'));

    expect(instruction!.indexOf(previousFixPath)).toBeLessThan(instruction!.indexOf(olderFixPath));
  });

  it('should inherit previous worktree-run peer reports and persist their provenance before a resumed fix step builds its instruction', async () => {
    // Given
    const config = buildFixHandleConfig();
    const sourceReportDir = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
    );
    writeReport(sourceReportDir, '05-arch-review.md', 'previous arch review');
    writeReport(sourceReportDir, '06-security-review.md', 'previous security review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      resumeSource: {
        sourceRunSlug: '20260717-source-run',
        resumeMode: 'requeue',
      },
      resumePoint: {
        version: 1,
        stack: [{ workflow: 'fix-report-handles', step: 'fix', kind: 'agent' }],
        iteration: 1,
        elapsed_ms: 0,
      },
    });
    engines.push(engine);
    mockRunAgentSequence([
      makeResponse({ persona: 'fix', content: 'Fix complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    const inheritedArchPath = join(reportDir, '05-arch-review.md');
    const inheritedSecurityPath = join(reportDir, '06-security-review.md');
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';
    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedArchPath, 'utf-8')).toBe('previous arch review');
    expect(readFileSync(inheritedSecurityPath, 'utf-8')).toBe('previous security review');
    expect(readFileSync(join(sourceReportDir, '05-arch-review.md'), 'utf-8')).toBe('previous arch review');
    expect(instruction).toContain(inheritedArchPath);
    expect(instruction).toContain(inheritedSecurityPath);
    const diagnosticPath = join(reportDir, 'review-report-inheritance.json');
    expect(existsSync(diagnosticPath)).toBe(true);
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf-8'))).toEqual(expect.objectContaining({
      sourceRunSlug: '20260717-source-run',
      sourceReportDirectory: join(cloneCwd, '.takt', 'runs', '20260717-source-run', 'reports'),
      targetReportDirectory: reportDir,
      status: 'copied',
      fallbackUsed: false,
    }));
    expect(mockWorkflowLogger.info).toHaveBeenCalledWith(
      'Review report inheritance completed',
      expect.objectContaining({ status: 'copied', fallbackUsed: false }),
    );
    expect(mockWorkflowLogger.warn).not.toHaveBeenCalledWith(
      'Review report inheritance completed with fallback',
      expect.anything(),
    );
  });

  it('should inherit peer reports when direct resume starts at fix without a resume point', async () => {
    // Given
    const config = buildFixHandleConfig();
    const sourceReportDir = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
    );
    writeReport(sourceReportDir, '05-arch-review.md', 'previous arch review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: {
        sourceRunSlug: '20260717-source-run',
        resumeMode: 'requeue',
      },
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const inheritedPath = join(reportDir, '05-arch-review.md');
    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedPath, 'utf-8')).toBe('previous arch review');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(inheritedPath);
  });

  it('should provide inherited final-gate workflow-call reports to direct-resume fix instructions', async () => {
    // Given
    const finalGateConfig = buildFinalGateReportConfig();
    const reviewerConfig = buildMergeReadinessReviewerConfig();
    const config: WorkflowConfig = {
      name: 'peer-review-with-final-gate',
      description: 'Final gate report inheritance test',
      maxSteps: 3,
      initialStep: 'final-gate',
      steps: [
        makeStep('final-gate', {
          kind: 'workflow_call',
          call: 'merge-readiness-final-gate',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const sourceReportDir = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
      'subworkflows',
      'iteration-1--step-final-gate--workflow-merge-readiness-final-gate',
      'subworkflows',
      'iteration-1--step-merge-readiness-reviewers--workflow-merge-readiness-reviewers',
    );
    writeReport(sourceReportDir, 'merge-readiness-arch-review.md', 'previous final-gate architecture review');
    writeReport(sourceReportDir, 'merge-readiness-security-review.md', 'previous final-gate security review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: {
        sourceRunSlug: '20260717-source-run',
        resumeMode: 'retry',
      },
      workflowCallResolver: ({ step }) => step.call === 'merge-readiness-final-gate'
        ? finalGateConfig
        : step.call === 'merge-readiness-reviewers'
          ? reviewerConfig
        : null,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const inheritedPath = join(
      reportDir,
      'subworkflows',
      'iteration-1--step-final-gate--workflow-merge-readiness-final-gate',
      'subworkflows',
      'iteration-1--step-merge-readiness-reviewers--workflow-merge-readiness-reviewers',
      'merge-readiness-arch-review.md',
    );
    const inheritedSecurityPath = join(
      reportDir,
      'subworkflows',
      'iteration-1--step-final-gate--workflow-merge-readiness-final-gate',
      'subworkflows',
      'iteration-1--step-merge-readiness-reviewers--workflow-merge-readiness-reviewers',
      'merge-readiness-security-review.md',
    );
    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedPath, 'utf-8')).toBe('previous final-gate architecture review');
    expect(readFileSync(inheritedSecurityPath, 'utf-8')).toBe('previous final-gate security review');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(inheritedPath);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(inheritedSecurityPath);
  });

  it('should provide inherited reports from a workflow call nested in a parallel final gate', async () => {
    // Given
    const finalGateConfig = buildParallelFinalGateReportConfig();
    const reviewerConfig = buildMergeReadinessReviewerConfig();
    const config: WorkflowConfig = {
      name: 'peer-review-with-parallel-final-gate',
      description: 'Parallel final gate report inheritance test',
      maxSteps: 3,
      initialStep: 'final-gate',
      steps: [
        makeStep('final-gate', {
          kind: 'workflow_call',
          call: 'parallel-merge-readiness-final-gate',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const sourceReportDir = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
      'subworkflows',
      'iteration-1--step-final-gate--workflow-parallel-merge-readiness-final-gate',
      'subworkflows',
      'iteration-1--step-merge-readiness-review--workflow-merge-readiness-reviewers',
    );
    writeReport(sourceReportDir, 'merge-readiness-arch-review.md', 'previous parallel final-gate architecture review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug: '20260717-source-run', resumeMode: 'retry' },
      workflowCallResolver: ({ step }) => step.call === 'parallel-merge-readiness-final-gate'
        ? finalGateConfig
        : step.call === 'merge-readiness-reviewers'
          ? reviewerConfig
          : null,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const inheritedPath = join(
      reportDir,
      'subworkflows',
      'iteration-1--step-final-gate--workflow-parallel-merge-readiness-final-gate',
      'subworkflows',
      'iteration-1--step-merge-readiness-review--workflow-merge-readiness-reviewers',
      'merge-readiness-arch-review.md',
    );
    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedPath, 'utf-8')).toBe('previous parallel final-gate architecture review');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(inheritedPath);
  });

  it('should prefer current-run workflow-call reports over inherited reports with the same logical name', async () => {
    // Given
    const finalGateConfig = buildFinalGateReportConfig();
    const reviewerConfig = buildMergeReadinessReviewerConfig();
    const config: WorkflowConfig = {
      name: 'peer-review-with-final-gate',
      maxSteps: 3,
      initialStep: 'final-gate',
      steps: [
        makeStep('final-gate', {
          kind: 'workflow_call',
          call: 'merge-readiness-final-gate',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const nestedNamespace = [
      'subworkflows',
      'iteration-45--step-final-gate--workflow-merge-readiness-final-gate',
      'subworkflows',
      'iteration-45--step-merge-readiness-reviewers--workflow-merge-readiness-reviewers',
    ];
    const sourcePath = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
      ...nestedNamespace,
      'merge-readiness-arch-review.md',
    );
    writeReport(join(sourcePath, '..'), 'merge-readiness-arch-review.md', 'inherited final-gate review');
    const currentPath = join(
      reportDir,
      'subworkflows',
      'iteration-2--step-final-gate--workflow-merge-readiness-final-gate',
      'subworkflows',
      'iteration-2--step-merge-readiness-reviewers--workflow-merge-readiness-reviewers',
      'merge-readiness-arch-review.md',
    );
    writeReport(join(currentPath, '..'), 'merge-readiness-arch-review.md', 'current final-gate review');
    utimesSync(currentPath, new Date('2026-07-18T00:00:00.000Z'), new Date('2026-07-18T00:00:00.000Z'));
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug: '20260717-source-run', resumeMode: 'requeue' },
      workflowCallResolver: ({ step }) => step.call === 'merge-readiness-final-gate'
        ? finalGateConfig
        : step.call === 'merge-readiness-reviewers'
          ? reviewerConfig
          : null,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const inheritedPath = join(reportDir, ...nestedNamespace, 'merge-readiness-arch-review.md');
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';
    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedPath, 'utf-8')).toBe('inherited final-gate review');
    expect(instruction).toContain(currentPath);
    expect(instruction).not.toContain(inheritedPath);
  });

  it('should record a discovery failure when workflow calls form a cycle', () => {
    // Given
    const config: WorkflowConfig = {
      name: 'cyclic-report-workflow',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeStep('delegate', {
          kind: 'workflow_call',
          call: 'cyclic-report-workflow',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          outputContracts: [{ name: 'cycle-review.md', format: '# Cycle Review' }],
          rules: [makeRule('COMPLETE', 'COMPLETE')],
        }),
      ],
    };
    const workflowCallResolver = vi.fn(() => config);

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[1]!,
      workflow: config,
      workflowCallResolver,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix: [],
    });

    // Then
    expect(reportNames.reportNames).toEqual([]);
    expect(reportNames.failures).toEqual([
      'workflow_call_report_cycle:cyclic-report-workflow',
    ]);
    expect(workflowCallResolver).toHaveBeenCalledOnce();
  });

  it('should retain available report names when a nested workflow call cannot be resolved', () => {
    // Given
    const config: WorkflowConfig = {
      name: 'partial-report-discovery',
      maxSteps: 2,
      initialStep: 'reviewers',
      steps: [
        makeStep('reviewers', {
          kind: 'workflow_call',
          call: 'missing-reviewers',
          outputContracts: [{ name: 'available-review.md', format: '# Available Review' }],
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', { rules: [makeRule('COMPLETE', 'COMPLETE')] }),
      ],
    };

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[1]!,
      workflow: config,
      workflowCallResolver: () => null,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix: [],
    });

    // Then
    expect(reportNames).toEqual({
      reportNames: ['available-review.md'],
      failures: ['workflow_call_report_unknown:missing-reviewers'],
    });
  });

  it('should copy available reports and persist diagnostics for unresolved and cyclic workflow calls', async () => {
    // Given
    const config: WorkflowConfig = {
      name: 'partial-workflow-call-discovery',
      maxSteps: 2,
      initialStep: 'reviewers',
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('missing-review', {
              kind: 'workflow_call',
              call: 'missing-review-workflow',
              outputContracts: [{ name: 'available-review.md', format: '# Available Review' }],
              rules: [makeRule('COMPLETE', 'COMPLETE')],
            }),
            makeStep('cyclic-review', {
              kind: 'workflow_call',
              call: 'partial-workflow-call-discovery',
              outputContracts: [{ name: 'cycle-review.md', format: '# Cycle Review' }],
              rules: [makeRule('COMPLETE', 'COMPLETE')],
            }),
          ],
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const sourceReportDir = join(cloneCwd, '.takt', 'runs', '20260717-source-run', 'reports');
    writeReport(sourceReportDir, 'available-review.md', 'available review');
    writeReport(sourceReportDir, 'cycle-review.md', 'cycle review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug: '20260717-source-run', resumeMode: 'requeue' },
      workflowCallResolver: ({ step }) => step.call === 'partial-workflow-call-discovery' ? config : null,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const diagnostic = JSON.parse(readFileSync(join(reportDir, 'review-report-inheritance.json'), 'utf-8'));
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';
    expect(state.status).toBe('completed');
    expect(readFileSync(join(reportDir, 'available-review.md'), 'utf-8')).toBe('available review');
    expect(readFileSync(join(reportDir, 'cycle-review.md'), 'utf-8')).toBe('cycle review');
    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'partial',
      fallbackUsed: true,
      skipped: expect.arrayContaining([
        { reportName: '*', reason: 'workflow_call_report_unknown:missing-review-workflow' },
        { reportName: '*', reason: 'workflow_call_report_cycle:partial-workflow-call-discovery' },
      ]),
    }));
    expect(instruction).toContain(join(reportDir, 'available-review.md'));
    expect(instruction).toContain(join(reportDir, 'cycle-review.md'));
  });

  it('should discover output contracts from a sequential reviewer before fix', () => {
    // Given
    const config: WorkflowConfig = {
      name: 'sequential-review-fix',
      maxSteps: 2,
      initialStep: 'review',
      steps: [
        makeStep('review', {
          outputContracts: [{ name: 'sequential-review.md', format: '# Sequential Review' }],
          rules: [makeRule('approved', 'fix')],
        }),
        makeStep('fix', { rules: [makeRule('COMPLETE', 'COMPLETE')] }),
      ],
    };

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[1]!,
      workflow: config,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix: [],
    });

    // Then
    expect(reportNames.reportNames).toEqual(['sequential-review.md']);
  });

  it('should discover reports from reviewers separated from fix by multiple intermediate steps', () => {
    // Given
    const config: WorkflowConfig = {
      name: 'reviewers-with-intermediate-steps',
      maxSteps: 4,
      initialStep: 'reviewers',
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('arch-review', {
              outputContracts: [{ name: 'arch-review.md', format: '# Architecture Review' }],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
            makeStep('security-review', {
              outputContracts: [{ name: 'security-review.md', format: '# Security Review' }],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
          ],
          rules: [makeRule('all("approved")', 'gate')],
        }),
        makeStep('gate', { rules: [makeRule('passed', 'prepare-fix')] }),
        makeStep('prepare-fix', { rules: [makeRule('ready', 'fix')] }),
        makeStep('fix', { rules: [makeRule('complete', 'COMPLETE')] }),
      ],
    };

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[3]!,
      workflow: config,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix: [],
    });

    // Then
    expect(reportNames).toEqual({
      reportNames: ['arch-review.md', 'security-review.md'],
      failures: [],
    });
  });

  it('should use an earlier same-run reviewer when the nearest workflow call has no report outputs', async () => {
    // Given
    const emptyGateConfig: WorkflowConfig = {
      name: 'empty-report-gate',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'gate',
      steps: [makeStep('gate', { rules: [makeRule('COMPLETE', 'COMPLETE')] })],
    };
    const config: WorkflowConfig = {
      name: 'same-run-report-fallback',
      maxSteps: 3,
      initialStep: 'review',
      steps: [
        makeStep('review', {
          outputContracts: [{ name: 'earlier-review.md', format: '# Earlier Review' }],
          rules: [makeRule('approved', 'final-gate')],
        }),
        makeStep('final-gate', {
          kind: 'workflow_call',
          call: 'empty-report-gate',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Current reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const currentReportPath = join(reportDir, 'earlier-review.md');
    writeReport(reportDir, 'earlier-review.md', 'same-run earlier review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      workflowCallResolver: () => emptyGateConfig,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(currentReportPath);
  });

  it('should resolve report sources once while inheriting and injecting an earlier reviewer on requeue', async () => {
    // Given
    const emptyGateConfig: WorkflowConfig = {
      name: 'empty-requeue-gate',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'gate',
      steps: [makeStep('gate', { rules: [makeRule('COMPLETE', 'COMPLETE')] })],
    };
    const config: WorkflowConfig = {
      name: 'requeue-report-fallback',
      maxSteps: 3,
      initialStep: 'review',
      steps: [
        makeStep('review', {
          outputContracts: [{ name: 'earlier-review.md', format: '# Earlier Review' }],
          rules: [makeRule('approved', 'final-gate')],
        }),
        makeStep('final-gate', {
          kind: 'workflow_call',
          call: 'empty-requeue-gate',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const sourceReportDir = join(cloneCwd, '.takt', 'runs', '20260717-source-run', 'reports');
    writeReport(sourceReportDir, 'earlier-review.md', 'requeued earlier review');
    const workflowCallResolver = vi.fn(() => emptyGateConfig);
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug: '20260717-source-run', resumeMode: 'requeue' },
      workflowCallResolver,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const inheritedReportPath = join(reportDir, 'earlier-review.md');
    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedReportPath, 'utf-8')).toBe('requeued earlier review');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(inheritedReportPath);
    expect(workflowCallResolver).toHaveBeenCalledOnce();
  });

  it('should traverse same-name workflows from distinct sources while discovering reports', () => {
    // Given
    const secondWorkflow = attachWorkflowOpaqueRef({
      name: 'shared-review',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        outputContracts: [{ name: 'second-source-review.md', format: '# Second Source Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    }, 'project:sha256:shared-review-b');
    const firstWorkflow = attachWorkflowOpaqueRef({
      name: 'shared-review',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'delegate',
      steps: [makeStep('delegate', {
        kind: 'workflow_call',
        call: 'second-source-review',
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      })],
    }, 'project:sha256:shared-review-a');
    const config: WorkflowConfig = {
      name: 'same-name-workflow-parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeStep('delegate', {
          kind: 'workflow_call',
          call: 'first-source-review',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', { rules: [makeRule('COMPLETE', 'COMPLETE')] }),
      ],
    };

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[1]!,
      workflow: config,
      workflowCallResolver: ({ step }) => step.call === 'first-source-review'
        ? firstWorkflow
        : step.call === 'second-source-review'
          ? secondWorkflow
          : null,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix: [],
    });

    // Then
    expect(reportNames.reportNames).toEqual([
      'subworkflows/iteration-*--step-delegate--workflow-shared-review/subworkflows/iteration-*--step-delegate--workflow-shared-review/second-source-review.md',
    ]);
  });

  it('should discover reports through the maximum executable workflow-call depth', () => {
    // Given
    const workflows = Array.from({ length: 4 }, (_, index): WorkflowConfig => ({
      name: `nested-review-${index + 1}`,
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'delegate',
      steps: [makeStep('delegate', index === 3 ? {
        outputContracts: [{ name: 'deep-review.md', format: '# Deep Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      } : {
        kind: 'workflow_call',
        call: `nested-review-${index + 2}`,
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      })],
    }));
    const config: WorkflowConfig = {
      name: 'maximum-depth-review-parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeStep('delegate', {
          kind: 'workflow_call',
          call: 'nested-review-1',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', { rules: [makeRule('COMPLETE', 'COMPLETE')] }),
      ],
    };

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[1]!,
      workflow: config,
      workflowCallResolver: ({ step }) => workflows.find((workflow) => workflow.name === step.call) ?? null,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix: [],
    });

    // Then
    expect(reportNames.reportNames).toEqual([
      'subworkflows/iteration-*--step-delegate--workflow-nested-review-1/subworkflows/iteration-*--step-delegate--workflow-nested-review-2/subworkflows/iteration-*--step-delegate--workflow-nested-review-3/subworkflows/iteration-*--step-delegate--workflow-nested-review-4/deep-review.md',
    ]);
  });

  it('should limit report discovery to the remaining workflow-call depth after resume', () => {
    // Given
    const workflows = Array.from({ length: 2 }, (_, index): WorkflowConfig => ({
      name: `resumed-review-${index + 1}`,
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'delegate',
      steps: [makeStep('delegate', index === 1 ? {
        outputContracts: [{ name: 'resumed-review.md', format: '# Resumed Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      } : {
        kind: 'workflow_call',
        call: 'resumed-review-2',
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      })],
    }));
    const config: WorkflowConfig = {
      name: 'resumed-review-parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeStep('delegate', {
          kind: 'workflow_call',
          call: 'resumed-review-1',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', { rules: [makeRule('COMPLETE', 'COMPLETE')] }),
      ],
    };
    const resumeStackPrefix: WorkflowResumePointEntry[] = [
      { workflow: 'root', step: 'delegate', kind: 'workflow_call' },
      { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
    ];

    // When
    const reportNames = resolveInheritedReviewReportNamesWithDiagnostics({
      step: config.steps[1]!,
      workflow: config,
      workflowCallResolver: ({ step }) => workflows.find((workflow) => workflow.name === step.call) ?? null,
      projectCwd,
      lookupCwd: cloneCwd,
      resumeStackPrefix,
    });

    // Then
    expect(reportNames.reportNames).toEqual([
      'subworkflows/iteration-*--step-delegate--workflow-resumed-review-1/subworkflows/iteration-*--step-delegate--workflow-resumed-review-2/resumed-review.md',
    ]);
  });

  it('should continue a resumed fix and record report-discovery depth overflow', async () => {
    // Given
    const workflows = Array.from({ length: 5 }, (_, index): WorkflowConfig => ({
      name: `overflow-review-${index + 1}`,
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'delegate',
      steps: [makeStep('delegate', index === 4 ? {
        outputContracts: [{ name: 'unreachable-review.md', format: '# Unreachable Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      } : {
        kind: 'workflow_call',
        call: `overflow-review-${index + 2}`,
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      })],
    }));
    const config: WorkflowConfig = {
      name: 'overflow-review-parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeStep('delegate', {
          kind: 'workflow_call',
          call: 'overflow-review-1',
          outputContracts: [{ name: 'available-review.md', format: '# Available Review' }],
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    writeReport(
      join(cloneCwd, '.takt', 'runs', '20260717-source-run', 'reports'),
      'available-review.md',
      'available review',
    );
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug: '20260717-source-run', resumeMode: 'retry' },
      workflowCallResolver: ({ step }) => workflows.find((workflow) => workflow.name === step.call) ?? null,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const diagnostic = JSON.parse(readFileSync(join(reportDir, 'review-report-inheritance.json'), 'utf-8'));
    expect(state.status).toBe('completed');
    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'partial',
      fallbackUsed: true,
      skipped: [{ reportName: '*', reason: 'workflow_call_report_depth_exceeded:5' }],
    }));
    expect(readFileSync(join(reportDir, 'available-review.md'), 'utf-8')).toBe('available review');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(join(reportDir, 'available-review.md'));
  });

  it('should leave previous-run reports out of a new fix run without resume source metadata', async () => {
    // Given
    const config = buildFixHandleConfig();
    const sourceReportDir = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
    );
    writeReport(sourceReportDir, '05-arch-review.md', 'previous arch review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', { projectCwd });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const inheritedPath = join(reportDir, '05-arch-review.md');
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';
    expect(state.status).toBe('completed');
    expect(existsSync(inheritedPath)).toBe(false);
    expect(instruction).not.toContain(sourceReportDir);
    expect(readFileSync(join(sourceReportDir, '05-arch-review.md'), 'utf-8')).toBe('previous arch review');
  });

  it('should leave previous-run reports out when the resume point does not target fix', async () => {
    // Given
    const config = buildFixHandleConfig();
    const sourceReportDir = join(cloneCwd, '.takt', 'runs', '20260717-source-run', 'reports');
    writeReport(sourceReportDir, '05-arch-review.md', 'previous arch review');
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      resumeSource: { sourceRunSlug: '20260717-source-run', resumeMode: 'requeue' },
      resumePoint: {
        version: 1,
        stack: [{ workflow: 'fix-report-handles', step: 'reviewers', kind: 'agent' }],
        iteration: 1,
        elapsed_ms: 0,
      },
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';
    expect(state.status).toBe('completed');
    expect(existsSync(join(reportDir, '05-arch-review.md'))).toBe(false);
    expect(instruction).not.toContain(sourceReportDir);
    expect(existsSync(join(reportDir, 'review-report-inheritance.json'))).toBe(false);
  });

  it('should persist unavailable inheritance diagnostics when a resumed fix has no source run', async () => {
    // Given
    const config = buildFixHandleConfig();
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      resumeSource: { resumeMode: 'requeue' },
      resumePoint: {
        version: 1,
        stack: [{ workflow: 'fix-report-handles', step: 'fix', kind: 'agent' }],
        iteration: 1,
        elapsed_ms: 0,
      },
    });
    engines.push(engine);
    mockRunAgentSequence([
      makeResponse({ persona: 'fix', content: 'Fix complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    const diagnostic = JSON.parse(readFileSync(join(reportDir, 'review-report-inheritance.json'), 'utf-8'));
    expect(state.status).toBe('completed');
    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'unavailable',
      fallbackUsed: true,
      targetReportDirectory: reportDir,
    }));
    expect(diagnostic).not.toHaveProperty('sourceRunSlug');
    expect(diagnostic).not.toHaveProperty('sourceReportDirectory');
    expect(mockWorkflowLogger.warn).toHaveBeenCalledWith(
      'Review report inheritance completed with fallback',
      expect.objectContaining({ status: 'unavailable', fallbackUsed: true }),
    );
  });

  it('should continue a resumed fix and record the resolver failure when workflow-call report discovery throws', async () => {
    // Given
    const config: WorkflowConfig = {
      name: 'resolver-failure-fix',
      maxSteps: 2,
      initialStep: 'final-gate',
      steps: [
        makeStep('final-gate', {
          kind: 'workflow_call',
          call: 'missing-final-gate',
          rules: [makeRule('COMPLETE', 'fix')],
        }),
        makeStep('fix', {
          instruction: 'Inherited reports:\n{peer_reports}',
          passPreviousResponse: false,
          rules: [makeRule('Fix complete', 'COMPLETE')],
        }),
      ],
    };
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: {
        sourceRunSlug: '20260717-source-run',
        resumeMode: 'retry',
      },
      workflowCallResolver: () => {
        throw new Error('workflow resolver unavailable');
      },
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    const diagnostic = JSON.parse(readFileSync(join(reportDir, 'review-report-inheritance.json'), 'utf-8'));
    expect(state.status).toBe('completed');
    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'unavailable',
      fallbackUsed: true,
      skipped: [{ reportName: '*', reason: 'workflow_call_report_resolution_failed:workflow resolver unavailable' }],
    }));
    expect(mockWorkflowLogger.warn).toHaveBeenCalledWith(
      'Review report inheritance completed with fallback',
      expect.objectContaining({ fallbackUsed: true }),
    );
  });

  it('should inherit reports without changing the source finding ledger when a resumed fix uses Finding Contract', async () => {
    // Given
    const config: WorkflowConfig = {
      ...buildFixHandleConfig(),
      findingContract: {
        ledgerPath: '.takt/findings/review-ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'Manage findings.',
          outputContract: 'Record findings.',
        },
      },
    };
    const sourceReportDir = join(cloneCwd, '.takt', 'runs', '20260717-source-run', 'reports');
    const sourceLedgerPath = join(projectCwd, '.takt', 'findings', 'review-ledger.json');
    writeReport(sourceReportDir, '05-arch-review.md', 'previous arch review');
    const sourceLedger = JSON.stringify({
      version: 1,
      workflowName: 'fix-report-handles',
      nextId: 1,
      updatedAt: '2026-07-17T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
    });
    writeReport(join(projectCwd, '.takt', 'findings'), 'review-ledger.json', sourceLedger);
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', {
      projectCwd,
      resumeSource: {
        sourceRunSlug: '20260717-source-run',
        resumeMode: 'retry',
      },
      resumePoint: {
        version: 1,
        stack: [{ workflow: 'fix-report-handles', step: 'fix', kind: 'agent' }],
        iteration: 1,
        elapsed_ms: 0,
      },
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(readFileSync(join(reportDir, '05-arch-review.md'), 'utf-8')).toBe('previous arch review');
    expect(readFileSync(sourceLedgerPath, 'utf-8')).toBe(sourceLedger);
  });

  it('should provide inherited reports to a resumed nested fix step', async () => {
    // Given
    const childConfig: WorkflowConfig = {
      ...buildFixHandleConfig(),
      name: 'child-fix',
      subworkflow: { callable: true },
    };
    const parentConfig: WorkflowConfig = {
      name: 'parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'child-fix',
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      }],
    };
    const sourceReportDir = join(
      cloneCwd,
      '.takt',
      'runs',
      '20260717-source-run',
      'reports',
      'subworkflows',
      'iteration-1--step-delegate--workflow-child-fix',
    );
    writeReport(sourceReportDir, '05-arch-review.md', 'previous nested review');
    const engine = new WorkflowEngine(parentConfig, cloneCwd, 'test task', {
      projectCwd,
      resumeSource: {
        sourceRunSlug: '20260717-source-run',
        resumeMode: 'instruct',
      },
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'child-fix', step: 'fix', kind: 'agent' },
        ],
        iteration: 1,
        elapsed_ms: 0,
      },
      workflowCallResolver: ({ step }) => step.call === 'child-fix' ? childConfig : null,
    });
    engines.push(engine);
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'Fix complete' })]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    const nestedReportPath = join(
      reportDir,
      'subworkflows',
      'iteration-1--step-delegate--workflow-child-fix',
      '05-arch-review.md',
    );
    expect(state.status).toBe('completed');
    expect(readFileSync(nestedReportPath, 'utf-8')).toBe('previous nested review');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(nestedReportPath);
  });

  it('should inject clone-based reviewer peer report paths for supervise step', async () => {
    // Given
    const config = buildSuperviseHandleConfig();
    const engine = new WorkflowEngine(config, cloneCwd, 'test task', { projectCwd });
    engines.push(engine);

    writeReport(reportDir, '05-arch-review.md', 'latest arch review');
    writeReport(reportDir, '06-security-review.md', 'latest security review');

    mockRunAgentSequence([
      makeResponse({ persona: 'arch-review', content: 'approved' }),
      makeResponse({ persona: 'security-review', content: 'approved' }),
      makeResponse({ persona: 'supervise', content: 'All checks passed' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');

    const superviseCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === '../personas/supervise.md');
    const archPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '05-arch-review.md');
    const securityPath = join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports', '06-security-review.md');

    expect(superviseCall?.[1]).toContain(archPath);
    expect(superviseCall?.[1]).toContain(securityPath);
    expect(superviseCall?.[1]).not.toContain(join(projectCwd, '.takt', 'runs', 'test-report-dir', 'reports', '05-arch-review.md'));
  });
});
