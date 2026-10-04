import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';
import { cleanupChildProcess, waitFor } from '../helpers/wait.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalWorkflowFixture(repoPath: string, fixtureName: string): string {
  const workflowsDir = join(repoPath, '.takt', 'workflows');
  const agentsDir = join(repoPath, '.takt', 'agents');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const workflowFixturePath = resolve(__dirname, `../fixtures/workflows/${fixtureName}`);
  const agentFixturePath = resolve(__dirname, '../fixtures/agents/test-coder.md');

  const localWorkflowPath = join(workflowsDir, fixtureName);
  writeFileSync(localWorkflowPath, readFileSync(workflowFixturePath, 'utf-8'), 'utf-8');
  writeFileSync(join(agentsDir, 'test-coder.md'), readFileSync(agentFixturePath, 'utf-8'), 'utf-8');
  return localWorkflowPath;
}

/**
 * Writes a config.yaml free of any legacy provider signal (no provider/model/provider_options/
 * provider_routing/persona_providers/auto_routing) so an active runtime.yaml can drive
 * resolution without tripping the mixed-configuration fail-fast (issue #1136).
 */
function writeCleanConfig(taktDir: string): void {
  writeFileSync(
    join(taktDir, 'config.yaml'),
    stringifyYaml({
      language: 'en',
      logging: { level: 'info' },
      notification_sound: false,
    }),
  );
}

function writeActiveRuntimeProviderFile(taktDir: string): void {
  writeFileSync(
    join(taktDir, 'runtime.yaml'),
    stringifyYaml({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'mock', model: 'runtime-v1-model' },
        },
      },
    }),
  );
}

/**
 * Active runtime.yaml exercising explicit auto_routing target selection and `internal_agents`
 * compile paths (issue #1136). The single workflow step explicitly names its pool, while the
 * runtime defaults remain concrete for non-workflow provider resolution.
 */
function writeAutoRoutingRuntimeProviderFile(taktDir: string): void {
  writeFileSync(
    join(taktDir, 'runtime.yaml'),
    stringifyYaml({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'mock', model: 'mock-default' },
          high: { provider: 'mock', model: 'mock-high' },
          low: { provider: 'mock', model: 'mock-low' },
          router: { provider: 'mock', model: 'mock-router' },
        },
        targets: {
          steps: {
            'e2e-mock-single/execute': { pool: 'main-pool' },
          },
          internal_agents: {
            selector: { profile: 'router' },
          },
        },
        auto_routing: {
          strategy: 'balanced',
          router_profile: 'router',
          pools: {
            'main-pool': {
              candidates: [
                { profile: 'high', tier: 'high' },
                { profile: 'low', tier: 'low' },
              ],
              fallback_profile: 'low',
            },
          },
        },
      },
    }),
  );
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: runtime.yaml provider section (runtime-v1, mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let watcher: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(async () => {
    await cleanupChildProcess(watcher);
    watcher = undefined;
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  function prepareAssignmentRun(): { workflowPath: string; env: NodeJS.ProcessEnv; callLog: string } {
    writeCleanConfig(isolatedEnv.taktDir);
    writeFileSync(join(isolatedEnv.taktDir, 'runtime.yaml'), stringifyYaml({
      version: 1, companion: { enabled: false }, loop_analysis: { enabled: false },
    }));
    const projectDir = join(repo.path, '.takt');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'config.yaml'), stringifyYaml({ language: 'en' }));
    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as Record<string, unknown>;
    workflow.personas = { 'test-coder': join(projectDir, 'agents', 'test-coder.md') };
    writeFileSync(workflowPath, stringifyYaml(workflow));
    writeFileSync(join(projectDir, 'runtime.yaml'), stringifyYaml({
      version: 1,
      companion: { enabled: false },
      provider: {
        defaults: { profile: 'base' },
        profiles: {
          base: { provider: 'mock', model: 'assignment-base' },
          cost: { provider: 'mock', model: 'assignment-cost' },
          quality: { provider: 'mock', model: 'assignment-quality' },
        },
        assignments: {
          cost: { defaults: { profile: 'cost' } },
          quality: { defaults: { profile: 'quality' } },
        },
        directories: { [repo.path]: 'quality' },
      },
    }));
    const callLog = join(repo.path, 'mock-calls.jsonl');
    const scenarioPath = join(repo.path, 'assignment-scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(Array.from({ length: 2 }, () => [
      { persona: 'agents/test-coder', status: 'done', content: '[EXECUTE:1]\n\nTask completed.' },
      { persona: 'conductor', status: 'done', content: '[EXECUTE:1]' },
    ]).flat()));
    return { workflowPath, callLog, env: {
      ...isolatedEnv.env,
      TAKT_MOCK_SCENARIO: scenarioPath,
      TAKT_MOCK_CALL_LOG: callLog,
      TAKT_PROVIDER: undefined, TAKT_MODEL: undefined, TAKT_PROVIDER_OPTIONS: undefined,
    } };
  }

  function readCalls(callLog: string): Array<Record<string, unknown>> {
    if (!existsSync(callLog)) return [];
    return readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function pendingTask(name: string, workflow: string) {
    return { name, status: 'pending', content: `Execute ${name}`, workflow, worktree: false,
      created_at: new Date().toISOString(), started_at: null, completed_at: null };
  }

  it('runs two pending tasks using the directory assignment when no CLI selection is supplied', () => {
    const fixture = prepareAssignmentRun();
    const tasksPath = join(repo.path, '.takt', 'tasks.yaml');
    writeFileSync(tasksPath, stringifyYaml({ tasks: ['first-task', 'second-task']
      .map((name) => pendingTask(name, fixture.workflowPath)) }));

    const result = runTakt({ injectProvider: false, args: ['run'], cwd: repo.path, env: fixture.env, timeout: 240_000 });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const calls = readCalls(fixture.callLog).filter((call) => call.event === 'start' && call.personaName === 'agents/test-coder');
    expect(calls.map((call) => call.model), result.stdout + result.stderr + readFileSync(tasksPath, 'utf8'))
      .toEqual(['assignment-quality', 'assignment-quality']);
    const stored = parseYaml(readFileSync(tasksPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
    expect(stored.tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
  }, 240_000);

  it.each([false, true])('executes the selected assignment through the public CLI with pipeline=%s', (pipeline) => {
    const fixture = prepareAssignmentRun();
    const configPaths = [join(isolatedEnv.taktDir, 'config.yaml'), join(isolatedEnv.taktDir, 'runtime.yaml'),
      join(repo.path, '.takt', 'config.yaml'), join(repo.path, '.takt', 'runtime.yaml')];
    const original = configPaths.map((file) => readFileSync(file, 'utf8'));

    const result = runTakt({ injectProvider: false, cwd: repo.path, env: fixture.env,
      args: [...(pipeline ? ['--pipeline', '--skip-git'] : []), '--runtime-assignment', 'cost',
        '--task', 'Execute selected runtime assignment', '--workflow', fixture.workflowPath], timeout: 240_000 });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const calls = readCalls(fixture.callLog).filter((call) => call.event === 'start' && call.personaName === 'agents/test-coder');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'mock', model: 'assignment-cost' });
    expect(configPaths.map((file) => readFileSync(file, 'utf8'))).toEqual(original);
  }, 240_000);

  it('applies one invocation assignment to two pending tasks without saving it or restoring it in a later run', () => {
    const fixture = prepareAssignmentRun();
    const tasksPath = join(repo.path, '.takt', 'tasks.yaml');
    const tasks = ['first-task', 'second-task'].map((name) => pendingTask(name, fixture.workflowPath));
    writeFileSync(tasksPath, stringifyYaml({ tasks }));

    const selected = runTakt({ injectProvider: false, args: ['run', '--runtime-assignment', 'cost'],
      cwd: repo.path, env: fixture.env, timeout: 240_000 });

    expect(selected.exitCode, selected.stdout + selected.stderr).toBe(0);
    const calls = readCalls(fixture.callLog).filter((call) => call.event === 'start' && call.personaName === 'agents/test-coder');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.model)).toEqual(['assignment-cost', 'assignment-cost']);
    const stored = parseYaml(readFileSync(tasksPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
    expect(stored.tasks).toHaveLength(2);
    for (const task of stored.tasks) {
      expect(task.status).toBe('completed');
      expect(task).not.toHaveProperty('runtime_assignment');
      expect(task).not.toHaveProperty('runtimeAssignment');
      expect(Object.values(task)).not.toContain('cost');
    }

    writeFileSync(tasksPath, stringifyYaml({ tasks: [pendingTask('later-task', fixture.workflowPath)] }));
    const later = runTakt({ injectProvider: false, args: ['run'], cwd: repo.path, env: fixture.env, timeout: 240_000 });

    expect(later.exitCode, later.stdout + later.stderr).toBe(0);
    const laterCalls = readCalls(fixture.callLog).filter((call) => call.event === 'start' && call.personaName === 'agents/test-coder');
    expect(laterCalls.map((call) => call.model)).toEqual(['assignment-cost', 'assignment-cost', 'assignment-quality']);
  }, 240_000);

  it('keeps the assignment for a task added after watch has started', async () => {
    const fixture = prepareAssignmentRun();
    const tasksPath = join(repo.path, '.takt', 'tasks.yaml');
    writeFileSync(tasksPath, 'tasks: []\n');
    let output = '';
    watcher = spawn('node', [resolve(__dirname, '../../bin/takt'), 'watch', '--runtime-assignment', 'cost'], {
      cwd: repo.path, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcher.stdout?.on('data', (chunk) => { output += String(chunk); });
    watcher.stderr?.on('data', (chunk) => { output += String(chunk); });

    const ready = await waitFor(() => output.includes('Watching:') || watcher?.exitCode !== null, 30_000);
    expect(ready, output).toBe(true);
    expect(watcher.exitCode, output).toBeNull();
    writeFileSync(tasksPath, stringifyYaml({ tasks: [pendingTask('watched-task', fixture.workflowPath)] }));
    const completed = await waitFor(() => {
      const stored = parseYaml(readFileSync(tasksPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
      return stored.tasks.some((task) => task.name === 'watched-task' && task.status === 'completed');
    }, 120_000);

    expect(completed, output).toBe(true);
    const calls = readCalls(fixture.callLog).filter((call) => call.event === 'start' && call.personaName === 'agents/test-coder');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'mock', model: 'assignment-cost' });
  }, 240_000);

  it('rejects an unknown assignment before an agent starts and leaves settings and pending tasks unchanged', () => {
    const fixture = prepareAssignmentRun();
    const tasksPath = join(repo.path, '.takt', 'tasks.yaml');
    writeFileSync(tasksPath, stringifyYaml({ tasks: [pendingTask('untouched-task', fixture.workflowPath)] }));
    const files = [tasksPath, join(repo.path, '.takt', 'runtime.yaml'), join(repo.path, '.takt', 'config.yaml'),
      join(isolatedEnv.taktDir, 'config.yaml'), join(isolatedEnv.taktDir, 'runtime.yaml')];
    const original = files.map((file) => readFileSync(file, 'utf8'));

    const result = runTakt({ injectProvider: false, args: ['run', '--runtime-assignment', 'typo'],
      cwd: repo.path, env: fixture.env, timeout: 240_000 });

    expect(result.exitCode).not.toBe(0);
    for (const name of ['typo', 'cost', 'quality']) expect(result.stdout + result.stderr).toContain(name);
    expect(readCalls(fixture.callLog).filter((call) => call.event === 'start')).toEqual([]);
    expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(original);
  }, 240_000);

  it('resolves the provider from an active runtime.yaml and completes the workflow', () => {
    writeCleanConfig(isolatedEnv.taktDir);
    writeActiveRuntimeProviderFile(isolatedEnv.taktDir);

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // No --provider flag: the provider must come from runtime.yaml. The harness would
    // otherwise inject `--provider mock` from TAKT_E2E_PROVIDER, turning the resolution
    // into a CLI override and masking the runtime-v1 sources under test.
    const result = runTakt({
      injectProvider: false,
      args: [
        '--task', 'Test runtime-v1 provider resolution',
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        // An inherited TAKT_PROVIDER_OPTIONS would surface as a config.yaml provider_options
        // legacy signal and trip the (correct) mixed-config fail-fast; keep the run clean.
        TAKT_PROVIDER_OPTIONS: undefined,
      },
      timeout: 240_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);

    const records = readSessionRecords(repo.path);
    const stepStart = records.find((record) => record.type === 'step_start');
    expect(stepStart).toEqual(expect.objectContaining({
      provider: 'mock',
      providerSource: 'runtime-v1',
      model: 'runtime-v1-model',
      modelSource: 'runtime-v1',
    }));
  }, 240_000);

  it('resolves the provider through runtime.yaml auto_routing and completes the workflow', () => {
    writeCleanConfig(isolatedEnv.taktDir);
    writeAutoRoutingRuntimeProviderFile(isolatedEnv.taktDir);

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // No --provider flag: the step provider must come from the runtime.yaml auto-routing pool
    // (injectProvider: false keeps the harness from injecting a CLI override).
    const result = runTakt({
      injectProvider: false,
      args: [
        '--task', 'Test runtime-v1 auto_routing resolution',
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_PROVIDER_OPTIONS: undefined,
      },
      timeout: 240_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);

    const records = readSessionRecords(repo.path);
    const stepStart = records.find((record) => record.type === 'step_start');
    // Deterministic (no estimator) auto routing selects the pool fallback candidate `low`.
    expect(stepStart).toEqual(expect.objectContaining({
      provider: 'mock',
      model: 'mock-low',
    }));
  }, 240_000);

  it('fails fast from the CLI when an active runtime.yaml omits defaults', () => {
    writeCleanConfig(isolatedEnv.taktDir);
    // Active section with no defaults is invalid even without auto_routing, so the CLI must exit
    // non-zero before any agent runs.
    writeFileSync(
      join(isolatedEnv.taktDir, 'runtime.yaml'),
      stringifyYaml({
        version: 1,
        provider: {
          profiles: { alt: { provider: 'mock', model: 'alt-model' } },
          targets: { personas: { reviewer: { profile: 'alt' } } },
        },
      }),
    );

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');

    // No --provider flag and no TAKT_MOCK_SCENARIO: the run must stop at the bootstrap
    // fail-fast boundary, never reaching a provider call.
    const result = runTakt({
      injectProvider: false,
      args: [
        '--task', 'Test runtime-v1 missing default provider',
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_PROVIDER_OPTIONS: undefined,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('provider.defaults');
  }, 240_000);
});
