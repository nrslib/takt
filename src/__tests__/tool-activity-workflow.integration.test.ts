import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { runWorkflow } from '../features/pipeline/steps.js';
import { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { isQuietMode, setQuietMode } from '../shared/context.js';

describe('tool activity through workflow execution', () => {
  let project: string;
  let output: string[];
  let previousQuiet: boolean;
  let ttyDescriptor: PropertyDescriptor | undefined;
  let providerCalls: number;
  let completeTools: boolean;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'takt-tool-activity-'));
    mkdirSync(join(project, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    previousQuiet = isQuietMode();
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    output = [];
    providerCalls = 0;
    completeTools = true;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(`${args.map(String).join(' ')}\n`);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation((config) => {
      const agent: ProviderAgent = {
        call: async (_prompt, options) => {
          providerCalls += 1;
          options.onStream?.({ type: 'init', data: { model: 'mock-model', sessionId: 'test-session' } });
          options.onStream?.({
            type: 'tool_use',
            data: { id: 'shell', tool: 'Bash', input: { command: 'printf workflow-ready', api_key: 'test-only-secret' } },
          });
          options.onStream?.(completeTools ? {
            type: 'tool_result',
            data: { id: 'shell', content: 'workflow-tool-result\ntest-only-secret', isError: false },
          } : {
            type: 'tool_output',
            data: { id: 'shell', tool: 'Bash', output: 'workflow-tool-result\ntest-only-secret' },
          });
          options.onStream?.({ type: 'thinking', data: { thinking: 'private-workflow-reasoning' } });
          options.onStream?.({ type: 'text', data: { text: 'workflow-response-body\n' } });
          return {
            persona: config.name, status: 'done', content: 'workflow-response-body',
            timestamp: new Date(), sessionId: 'test-session',
          };
        },
      };
      return agent;
    });
  });

  afterEach(() => {
    setQuietMode(previousQuiet);
    vi.restoreAllMocks();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(project, { recursive: true, force: true });
  });

  function writeWorkflow(parallel: boolean, abort: boolean): void {
    const worker = { name: 'worker', instruction: '{task}', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] };
    writeFileSync(join(project, '.takt', 'workflows', 'activity.yaml'), stringify({
      name: 'activity', initial_step: 'run', max_steps: 3,
      steps: [{
        ...(parallel ? { name: 'run', parallel: [worker] } : { ...worker, name: 'run' }),
        rules: [{ condition: 'when(true)', next: abort ? 'ABORT' : 'COMPLETE' }],
      }],
    }));
  }

  it.each([
    { entry: 'pipeline', tty: true, quiet: false, prefix: false, parallel: false, abort: false },
    { entry: 'task', tty: false, quiet: false, prefix: false, parallel: false, abort: false },
    { entry: 'pipeline', tty: true, quiet: true, prefix: true, parallel: false, abort: false },
    { entry: 'pipeline', tty: true, quiet: true, prefix: true, parallel: true, abort: false },
    { entry: 'pipeline', tty: false, quiet: false, prefix: false, parallel: false, abort: true },
  ])('should expand safe tool logs through $entry (TTY=$tty, quiet=$quiet, prefix=$prefix, parallel=$parallel, abort=$abort)', async ({ entry, tty, quiet, prefix, parallel, abort }) => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
    setQuietMode(quiet);
    writeWorkflow(parallel, abort);
    const display = { outputMode: 'terminal' as const, ...(prefix ? { taskPrefix: 'task', taskColorIndex: 0 } : {}) };

    const result = entry === 'pipeline'
      ? await runWorkflow(project, 'activity', 'Observe tool activity', project, display, {
        execCwd: project, isWorktree: false,
      })
      : await executeTaskWithResult({
        cwd: project, projectCwd: project, workflowIdentifier: 'activity', task: 'Observe tool activity', ...display,
      });

    expect(providerCalls).toBeGreaterThan(0);
    expect(result.success).toBe(!abort);
    const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rendered).toContain('printf workflow-ready');
    expect(rendered).toContain('workflow-tool-result');
    if (prefix) expect(rendered).toContain('[task]');
    if (!quiet) expect(rendered).toContain('workflow-response-body');
    for (const line of rendered.split('\n')) {
      expect(line).not.toContain('test-only-secret');
      expect(line).not.toContain('private-workflow-reasoning');
      if (quiet) expect(line).not.toContain('workflow-response-body');
    }
    expect(output.join('')).not.toMatch(/\r|\x1b\[K/);
  });

  it('should keep parallel tool execution silent when the parent output mode is silent', async () => {
    setQuietMode(false);
    writeWorkflow(true, false);

    const result = await runWorkflow(project, 'activity', 'Observe silent tools', project, { outputMode: 'silent' }, {
      execCwd: project, isWorktree: false,
    });

    expect(providerCalls).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(output.join('')).toBe('');
  });

  it.each([false, true])('should flush unfinished tool output at workflow end with parallel=%s', async (parallel) => {
    setQuietMode(false);
    completeTools = false;
    writeWorkflow(parallel, false);
    const result = await runWorkflow(project, 'activity', 'Observe running output', project, {
      outputMode: 'terminal', taskPrefix: 'task', taskColorIndex: 0,
    }, { execCwd: project, isWorktree: false });
    expect(providerCalls).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    const rendered = output.join('');
    expect(rendered).toContain('workflow-tool-result');
    expect(rendered).toContain('[running]');
    expect(rendered).not.toContain('test-only-secret');
    expect(rendered).not.toContain('[success]');
  });
});
