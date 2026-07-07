import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';

const tempDirectories: string[] = [];

function spyOnCliOutput() {
  return {
    consoleLog: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    consoleError: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    consoleWarn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    stdoutWrite: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    stderrWrite: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  };
}

function expectNoCliOutput(spies: ReturnType<typeof spyOnCliOutput>): void {
  expect(spies.consoleLog).not.toHaveBeenCalled();
  expect(spies.consoleError).not.toHaveBeenCalled();
  expect(spies.consoleWarn).not.toHaveBeenCalled();
  expect(spies.stdoutWrite).not.toHaveBeenCalled();
  expect(spies.stderrWrite).not.toHaveBeenCalled();
}

async function createProjectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'takt-workflow-api-'));
  tempDirectories.push(directory);
  return directory;
}

describe('runWorkflowExecution silent output', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it('should not write CLI output when workflow lookup fails in silent mode', async () => {
    const projectCwd = await createProjectDirectory();
    const cliOutput = spyOnCliOutput();
    const eventSink = vi.fn();

    const result = await runWorkflowExecution({
      task: 'Task: missing workflow',
      cwd: projectCwd,
      projectCwd,
      workflowIdentifier: 'missing-workflow-for-silent-api',
      outputMode: 'silent',
      eventSink,
    });

    expect(result).toEqual({
      success: false,
      reason: 'Workflow "missing-workflow-for-silent-api" not found.',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: false,
      reason: 'Workflow "missing-workflow-for-silent-api" not found.',
    });
    expectNoCliOutput(cliOutput);
  });

  it('should dispatch terminal failure without CLI output when workflow file lookup fails in silent mode', async () => {
    const projectCwd = await createProjectDirectory();
    const cliOutput = spyOnCliOutput();
    const eventSink = vi.fn();

    const result = await runWorkflowExecution({
      task: 'Task: missing workflow file',
      cwd: projectCwd,
      projectCwd,
      workflowIdentifier: './custom-workflow.yaml',
      outputMode: 'silent',
      eventSink,
    });

    expect(result).toEqual({
      success: false,
      reason: 'Workflow file not found: ./custom-workflow.yaml',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: false,
      reason: 'Workflow file not found: ./custom-workflow.yaml',
    });
    expectNoCliOutput(cliOutput);
  });
});
