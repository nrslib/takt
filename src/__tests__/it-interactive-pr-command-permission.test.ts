import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import * as childProcess from 'node:child_process';
import { getGlobalConfigPath } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolutionCache.js';
import { getLabel } from '../shared/i18n/index.js';
import { getWorkflowDescription, listStandaloneWorkflowEntries } from '../infra/config/index.js';
import type { WorkflowSystemCommandsConfig } from '../core/models/config-types.js';

const harness = vi.hoisted(() => ({ cwd: '', checkout: () => {}, run: vi.fn() }));

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: () => ({ cwd: harness.cwd, pipelineMode: false }),
}));
vi.mock('../app/cli/program.js', () => ({ program: { opts: () => ({ pr: 1910 }) } }));
vi.mock('../app/cli/helpers.js', async (original) => ({
  ...(await original<typeof import('../app/cli/helpers.js')>()),
  resolveAgentOverrides: () => ({ provider: 'mock' }),
  resolveWorkflowCliOption: () => undefined,
}));
vi.mock('../app/cli/routing-inputs.js', () => ({
  resolvePrInput: async () => ({ initialInput: 'PR review', prBranch: 'feature/pr', baseBranch: 'main' }),
  resolveIssueInput: async () => null,
}));
vi.mock('../infra/task/index.js', async (original) => ({
  ...(await original<typeof import('../infra/task/index.js')>()),
  checkoutBranch: () => harness.checkout(),
  materializePullRequestBase: () => 'refs/takt/pr-base/main',
}));
vi.mock('../features/tui/index.js', () => ({ runTui: harness.run }));

import { executeDefaultAction } from '../app/cli/routing.js';

describe('interactive PR command permission', () => {
  let cwd: string;
  const stdinTty = process.stdin.isTTY;
  const stdoutTty = process.stdout.isTTY;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-interactive-pr-'));
    harness.cwd = cwd;
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(getGlobalConfigPath(), stringify({ workflow_system_commands: { custom_scripts: false } }));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.mocked(childProcess.spawn).mockClear();
  });

  afterEach(() => {
    process.stdin.isTTY = stdinTty;
    process.stdout.isTTY = stdoutTty;
    vi.restoreAllMocks();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    { before: true, after: false, child: false, named: false },
    { before: false, after: false, child: false, named: false },
    { before: true, after: false, child: false, named: true },
    { before: false, after: false, child: false, named: true },
    { before: true, after: false, child: true, named: true },
    { before: true, after: false, child: true, named: false },
    { before: false, after: false, child: true, named: true },
    { before: true, after: true, child: false, named: false },
    { before: undefined, after: true, child: false, named: false },
    { before: undefined, after: true, child: true, named: true },
  ])('uses pre-checkout permission $before after=$after child=$child named=$named on repeated execution', async ({ before, after, child, named }) => {
    const configPath = join(cwd, '.takt', 'config.yaml');
    const workflowPath = join(cwd, '.takt', 'workflows', 'approval.yaml');
    writeFileSync(configPath, stringify({ provider: 'mock', ...(before === undefined ? {} : { workflow_system_commands: { custom_scripts: before } }) }));
    harness.checkout = () => {
      writeFileSync(configPath, stringify({ provider: 'mock', workflow_system_commands: { custom_scripts: after } }));
      const command = { name: 'approval', steps: [{ name: 'check', mode: 'system',
        system_inputs: [{ type: 'command', as: 'approval', command: 'printf approved > command-ran', timeout_ms: 1000 }],
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] };
      writeFileSync(workflowPath, stringify(child ? { name: 'approval', steps: [{ name: 'delegate', kind: 'workflow_call', call: './child.yaml', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }] } : command));
      if (child) writeFileSync(join(cwd, '.takt', 'workflows', 'child.yaml'), stringify({ ...command, subworkflow: { callable: true } }));
      invalidateAllResolvedConfigCache();
    };
    const observations: boolean[] = [];
    const notices: string[] = [];
    harness.run.mockImplementationOnce(async (options: { dispatch: (workflow: string, result: unknown) => Promise<{ notice: string }>; getWorkflowSystemCommandsPolicy: () => WorkflowSystemCommandsConfig | undefined }) => {
      for (let iteration = 0; iteration < 2; iteration++) {
        notices.push((await options.dispatch(named ? 'approval' : workflowPath, { action: 'execute', task: 'Review PR' })).notice);
        observations.push(existsSync(join(cwd, 'command-ran')));
        rmSync(join(cwd, 'command-ran'), { force: true });
        const policy = options.getWorkflowSystemCommandsPolicy();
        expect(listStandaloneWorkflowEntries(cwd, { workflowSystemCommandsPolicy: policy }).some((entry) => entry.path === workflowPath)).toBe(before === true);
        if (before === true) {
          expect(getWorkflowDescription('approval', cwd, 1, cwd, undefined, undefined, policy).name).toBe('approval');
        } else {
          expect(() => getWorkflowDescription('approval', cwd, 1, cwd, undefined, undefined, policy)).toThrow();
        }
      }
      return { kind: 'cancelled' };
    });
    await executeDefaultAction();
    expect(observations).toEqual([before === true, before === true]);
    if (before === true) expect(notices).toEqual([getLabel('interactive.operation.executionFinished', 'en'), getLabel('interactive.operation.executionFinished', 'en')]);
    else for (const notice of notices) expect(notice).not.toBe(getLabel('interactive.operation.executionFinished', 'en'));
    if (before === true) expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    else expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, 'command-ran'))).toBe(false);
  });

  it.each([
    { before: true, after: true, child: false },
    { before: undefined, after: true, child: false },
    { before: true, after: false, child: false },
    { before: false, after: false, child: false },
    { before: true, after: false, child: true },
    { before: undefined, after: true, child: true },
  ])('keeps pre-checkout permission $before after switching to an Issue with project permission $after and child=$child', async ({ before, after, child }) => {
    const configPath = join(cwd, '.takt', 'config.yaml');
    const workflowPath = join(cwd, '.takt', 'workflows', 'approval.yaml');
    writeFileSync(configPath, stringify({ provider: 'mock', ...(before === undefined ? {} : { workflow_system_commands: { custom_scripts: before } }) }));
    harness.checkout = () => {
      writeFileSync(configPath, stringify({ provider: 'mock', workflow_system_commands: { custom_scripts: after } }));
      const command = { name: 'approval', steps: [{ name: 'check', mode: 'system',
        system_inputs: [{ type: 'command', as: 'approval', command: 'printf approved > command-ran', timeout_ms: 1000 }],
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] };
      writeFileSync(workflowPath, stringify(child ? { name: 'approval', steps: [{ name: 'delegate', kind: 'workflow_call', call: './child.yaml', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }] } : command));
      if (child) writeFileSync(join(cwd, '.takt', 'workflows', 'child.yaml'), stringify({ ...command, subworkflow: { callable: true } }));
      invalidateAllResolvedConfigCache();
    };
    harness.run.mockImplementationOnce(async (options: { dispatch: (workflow: string, result: unknown) => Promise<{ notice: string }>; getWorkflowSystemCommandsPolicy: () => WorkflowSystemCommandsConfig | undefined }) => {
      await options.dispatch(workflowPath, { action: 'execute', task: 'Review PR' });
      expect(existsSync(join(cwd, 'command-ran'))).toBe(before === true);
      rmSync(join(cwd, 'command-ran'), { force: true });
      const issue = await options.dispatch(workflowPath, { action: 'execute', task: 'Issue task', issueContextReplacement: { issueNumber: 42 } });
      if (before === true) expect(issue.notice).toBe(getLabel('interactive.operation.executionFinished', 'en'));
      else expect(issue.notice).not.toBe(getLabel('interactive.operation.executionFinished', 'en'));
      const policy = options.getWorkflowSystemCommandsPolicy();
      expect(listStandaloneWorkflowEntries(cwd, { workflowSystemCommandsPolicy: policy }).some((entry) => entry.path === workflowPath)).toBe(before === true);
      if (before === true) expect(getWorkflowDescription('approval', cwd, 1, cwd, undefined, undefined, policy).name).toBe('approval');
      else expect(() => getWorkflowDescription('approval', cwd, 1, cwd, undefined, undefined, policy)).toThrow();
      return { kind: 'cancelled' };
    });
    await executeDefaultAction();
    expect(existsSync(join(cwd, 'command-ran'))).toBe(before === true);
    expect(childProcess.spawn).toHaveBeenCalledTimes(before === true ? 2 : 0);
  });

  it.each([true, false])('uses project permission %s when switching to an Issue before checkout', async (allowed) => {
    const configPath = join(cwd, '.takt', 'config.yaml');
    const workflowPath = join(cwd, '.takt', 'workflows', 'approval.yaml');
    writeFileSync(configPath, stringify({ provider: 'mock', workflow_system_commands: { custom_scripts: allowed } }));
    writeFileSync(workflowPath, stringify({ name: 'approval', steps: [{ name: 'check', mode: 'system',
      system_inputs: [{ type: 'command', as: 'approval', command: 'printf approved > command-ran', timeout_ms: 1000 }],
      rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] }));
    const checkout = vi.fn();
    harness.checkout = checkout;
    harness.run.mockImplementationOnce(async (options: { dispatch: (workflow: string, result: unknown) => Promise<{ notice: string }>; getWorkflowSystemCommandsPolicy: () => WorkflowSystemCommandsConfig | undefined }) => {
      expect(options.getWorkflowSystemCommandsPolicy()).toBeUndefined();
      const issue = await options.dispatch(workflowPath, { action: 'execute', task: 'Issue task', issueContextReplacement: { issueNumber: 42 } });
      if (allowed) expect(issue.notice).toBe(getLabel('interactive.operation.executionFinished', 'en'));
      else expect(issue.notice).not.toBe(getLabel('interactive.operation.executionFinished', 'en'));
      expect(options.getWorkflowSystemCommandsPolicy()).toBeUndefined();
      return { kind: 'cancelled' };
    });
    await executeDefaultAction();
    expect(checkout).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, 'command-ran'))).toBe(allowed);
    expect(childProcess.spawn).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});
