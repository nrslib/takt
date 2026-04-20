import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import type { WorkflowConfig } from '../core/models/index.js';
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
