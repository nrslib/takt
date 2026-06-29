import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';

const tempDirectories: string[] = [];

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
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runWorkflowExecution({
      task: 'Task: missing workflow',
      cwd: projectCwd,
      projectCwd,
      workflowIdentifier: 'missing-workflow-for-silent-api',
      outputMode: 'silent',
    });

    expect(result).toEqual({
      success: false,
      reason: 'Workflow "missing-workflow-for-silent-api" not found.',
    });
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
