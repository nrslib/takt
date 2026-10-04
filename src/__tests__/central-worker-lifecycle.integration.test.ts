import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { runCentralTask } from '../features/web-ui/central-worker.js';

const roots: string[] = [];

const SYSTEM_WORKFLOW = `name: central
initial_step: finish
max_steps: 1
steps:
  - name: finish
    mode: system
    system_inputs: []
    effects: []
    rules:
      - condition: done
        next: COMPLETE
`;

const SAFE_MCP_WORKFLOW = `name: central-mcp
initial_step: finish
max_steps: 1
steps:
  - name: finish
    mode: system
    system_inputs: []
    effects: []
    rules:
      - condition: done
        next: COMPLETE
  - name: unreachable-agent
    persona: prompt
    instruction: '{task}'
    mcp_servers:
      safe:
        type: http
        url: https://example.test/mcp
        headers:
          Authorization: '\${MCP_TOKEN}'
`;

async function createFixture(workflowSource = SYSTEM_WORKFLOW) {
  const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-central-lifecycle-global-'));
  const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-central-lifecycle-project-'));
  roots.push(globalConfigDirectory, projectDirectory);
  await mkdir(join(projectDirectory, '.takt', 'workflows'), { recursive: true });
  await writeFile(
    join(projectDirectory, '.takt', 'config.yaml'),
    workflowSource === SAFE_MCP_WORKFLOW
      ? 'provider: codex\nworkflow_mcp_servers:\n  http: true\n'
      : 'provider: codex\n',
  );
  const workflowPath = join(projectDirectory, '.takt', 'workflows', 'central.yaml');
  await writeFile(workflowPath, workflowSource);

  const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
  const repository = await CentralTaskRepository.open({
    globalConfigDirectory,
    stateId: project.stateId,
    locationId: project.locationId,
    canonicalDirectory: project.canonicalDirectory,
    displayName: project.displayName,
    fingerprint: project.fingerprint,
  });
  return { globalConfigDirectory, projectDirectory, project, repository, workflowPath };
}

async function readAllFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return readAllFiles(path);
    if (entry.isFile()) return [await readFile(path, 'utf8')];
    return [];
  }));
  return contents.flat();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('central worker and workflow lifecycle', () => {
  it('lets the real workflow lifecycle publish central run metadata', async () => {
    const { globalConfigDirectory, projectDirectory, project, repository, workflowPath } = await createFixture();
    const reserved = await repository.enqueueAndClaim({
      task: 'central lifecycle task',
      workflow: workflowPath,
      worktree: false,
    });

    await runCentralTask({
      globalConfigDirectory,
      stateId: project.stateId,
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
    });

    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({
      status: 'completed',
      worktreePath: projectDirectory,
    });
    const metaPath = join(repository.paths.runsDirectory, reserved.runId, 'meta.json');
    await expect(stat(metaPath)).resolves.toBeDefined();
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({
      runSlug: reserved.runId,
      runRoot: `runs/${reserved.runId}`,
      reportDirectory: `runs/${reserved.runId}/reports`,
      contextDirectory: `runs/${reserved.runId}/context`,
      logsDirectory: `runs/${reserved.runId}/logs`,
      status: 'completed',
    });
    await expect(stat(join(projectDirectory, '.takt', 'runs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails the task and preserves a pre-existing run collision canary', async () => {
    const { globalConfigDirectory, project, repository, workflowPath } = await createFixture();
    const reserved = await repository.enqueueAndClaim({
      task: 'central collision task',
      workflow: workflowPath,
      worktree: false,
    });
    const runRoot = join(repository.paths.runsDirectory, reserved.runId);
    const canary = JSON.stringify({ status: 'collision-canary', secret: 'must-remain' });
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, 'meta.json'), canary);

    await expect(runCentralTask({
      globalConfigDirectory,
      stateId: project.stateId,
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
    })).rejects.toThrow(/run directory already exists/i);

    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'worker_failed' },
    });
    await expect(readFile(join(runRoot, 'meta.json'), 'utf8')).resolves.toBe(canary);
  });

  it('keeps MCP secret canaries out of central run artifacts during the real lifecycle', async () => {
    const { globalConfigDirectory, project, repository, workflowPath } = await createFixture(SAFE_MCP_WORKFLOW);
    const reserved = await repository.enqueueAndClaim({
      task: 'central MCP artifact task',
      workflow: workflowPath,
      worktree: false,
    });
    const previousToken = process.env.MCP_TOKEN;
    const secretCanary = 'central-secret-canary';
    process.env.MCP_TOKEN = secretCanary;
    try {
      await runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: reserved.task.taskId,
        generation: reserved.task.generation,
        executionId: reserved.executionId,
        ownerToken: reserved.ownerToken,
      });
    } finally {
      if (previousToken === undefined) delete process.env.MCP_TOKEN;
      else process.env.MCP_TOKEN = previousToken;
    }

    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({ status: 'completed' });
    const contents = await readAllFiles(repository.paths.stateDirectory);
    expect(contents.every((content) => !content.includes(secretCanary))).toBe(true);
    expect(contents.some((content) => content.includes('${MCP_TOKEN}'))).toBe(true);
  });

  it('terminalizes the central run artifact before force-failing its task ledger entry', async () => {
    const { repository, workflowPath } = await createFixture();
    const reserved = await repository.enqueueAndClaim({
      task: 'force fail artifact task',
      workflow: workflowPath,
      worktree: false,
    });
    const runRoot = join(repository.paths.runsDirectory, reserved.runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, 'meta.json'), JSON.stringify({
      runSlug: reserved.runId,
      task: reserved.task.task,
      workflow: reserved.task.workflow,
      status: 'running',
    }));

    const failed = await repository.forceFailTask(reserved.task.taskId, 'stopped from the viewer');
    expect(failed.drainingExecution).toMatchObject({
      executionId: reserved.executionId,
      generation: reserved.task.generation,
    });

    // A worker can finish its own lifecycle and overwrite the metadata before
    // it sends the force-fail acknowledgement. The acknowledgement must put
    // the central artifact back into the force-failed state.
    await writeFile(join(runRoot, 'meta.json'), JSON.stringify({
      runSlug: reserved.runId,
      status: 'completed',
    }));
    await repository.terminal({
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
      status: 'completed',
    });

    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'force_failed', message: 'stopped from the viewer' },
    });
    const meta = JSON.parse(await readFile(join(runRoot, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({
      status: 'failed',
      reason: 'stopped from the viewer',
    });
  });
});
