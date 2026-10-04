import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

const doubles = vi.hoisted(() => ({
  initGlobalDirs: vi.fn(),
  initProjectDirs: vi.fn(),
  initGitProvider: vi.fn(),
  spawn: vi.fn(),
  runAnalysis: vi.fn(),
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../infra/config/global/initialization.js', () => ({
  initGlobalDirs: doubles.initGlobalDirs,
  initProjectDirs: doubles.initProjectDirs,
}));
vi.mock('../infra/git/index.js', () => ({ initGitProvider: doubles.initGitProvider }));
vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: doubles.selectOption,
  promptInput: doubles.promptInput,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: doubles.spawn,
}));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({
  runLoopAnalysisWorkflowExecution: doubles.runAnalysis,
}));

describe('runtime assignment invocation', () => {
  let projectCwd: string;
  let globalDir: string;
  let projectDir: string;
  let stdinIsTTY: PropertyDescriptor | undefined;

  function writeRuntime(dir: string, content: unknown): void {
    writeFileSync(join(dir, 'runtime.yaml'), stringifyYaml(content));
  }

  function runtimeFixture() {
    return {
      version: 1,
      companion: { enabled: false },
      loop_analysis: { enabled: true, output: 'file' },
      provider: {
        defaults: { profile: 'base' },
        profiles: {
          base: { provider: 'mock', model: 'base-model' },
          directory: { provider: 'mock', model: 'directory-model' },
          cost: { provider: 'codex', model: 'cost-model', options: { reasoning_effort: 'low' } },
        },
        targets: { internal_agents: { selector: { profile: 'base' } } },
        assignments: {
          directory: { defaults: { profile: 'directory' } },
          cost: { defaults: { profile: 'cost' }, targets: {
            internal_agents: { selector: { profile: 'cost' }, assistant: { profile: 'cost' } },
          } },
        },
        directories: { [projectCwd]: 'directory' },
      },
    };
  }

  async function initialize(runtimeAssignment?: string, runtimeFilePath?: string): Promise<void> {
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');
    const command = new Command()
      .option('--runtime-assignment <name>')
      .option('--runtime-file <path>');
    const args = [
      ...(runtimeAssignment === undefined ? [] : ['--runtime-assignment', runtimeAssignment]),
      ...(runtimeFilePath === undefined ? [] : ['--runtime-file', runtimeFilePath]),
    ];
    command.parseOptions(args);
    await initializeCliExecutionContext(command, '1.0.0');
  }

  async function workflowEnvironment() {
    const { resolveRuntimeEnvironment } = await import('../infra/config/runtime-provider/provider-environment.js');
    return resolveRuntimeEnvironment({
      projectCwd,
      legacySignals: [],
      legacy: {
        provider: undefined, providerSource: 'default', model: undefined, modelSource: 'default',
        personaProviders: undefined, providerRouting: undefined, autoRouting: undefined, providerOptions: undefined,
      },
    }).providerEnvironment;
  }

  beforeEach(async () => {
    stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    vi.resetModules();
    vi.resetAllMocks();
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-assignment-invocation-'));
    const paths = await import('../infra/config/paths.js');
    globalDir = paths.getGlobalConfigDir();
    projectDir = paths.getProjectConfigDir(projectCwd);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(globalDir, 'config.yaml'), 'language: en\n');
    writeFileSync(join(projectDir, 'config.yaml'), 'language: en\n');
    writeRuntime(projectDir, runtimeFixture());
    vi.spyOn(process, 'cwd').mockReturnValue(projectCwd);
    doubles.initGlobalDirs.mockResolvedValue(undefined);
    doubles.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
  });

  afterEach(() => {
    if (stdinIsTTY === undefined) {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    } else {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    }
    vi.restoreAllMocks();
    rmSync(projectCwd, { recursive: true, force: true });
  });

  async function prepareFirstRun(): Promise<void> {
    rmSync(join(globalDir, 'config.yaml'));
    expect(existsSync(join(globalDir, 'runtime.yaml'))).toBe(false);
    writeRuntime(projectDir, { version: 1, provider: {
      defaults: { profile: 'base' },
      profiles: { base: { provider: 'mock', model: 'base-model' } },
      assignments: { cost: { defaults: { profile: 'default' } } },
    } });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    doubles.selectOption.mockResolvedValueOnce('en').mockResolvedValueOnce('codex').mockResolvedValueOnce('gpt-5');
    const actual = await vi.importActual<typeof import('../infra/config/global/initialization.js')>(
      '../infra/config/global/initialization.js',
    );
    doubles.initGlobalDirs.mockImplementation(actual.initGlobalDirs);
  }

  it('resolves the selected assignment from the profiles generated by first-run setup', async () => {
    await prepareFirstRun();
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');
    const action = vi.fn(async () => {
      expect(await workflowEnvironment()).toMatchObject({ provider: 'codex', model: 'gpt-5' });
    });
    const command = new Command().option('--runtime-assignment <name>')
      .hook('preAction', (root) => initializeCliExecutionContext(root, '1.0.0')).action(action);

    await command.parseAsync(['--runtime-assignment', 'cost'], { from: 'user' });

    expect(action).toHaveBeenCalledOnce();
    expect(existsSync(join(globalDir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(globalDir, 'runtime.yaml'))).toBe(true);
    expect(doubles.selectOption).toHaveBeenCalledTimes(3);
    const { resolveSelectorProviderForProject } = await import('../infra/config/selectorProviderResolution.js');
    const { resolveAssistantProviderModel } = await import('../features/interactive/assistantConfig.js');
    const { resolveNonWorkflowProviderModel } = await import('../infra/config/nonWorkflowProvider.js');
    const { resolveAuxiliaryProviderEnvironment } = await import('../infra/config/runtime-provider/provider-environment.js');
    const results = [
      await workflowEnvironment(),
      resolveSelectorProviderForProject(projectCwd),
      resolveAssistantProviderModel(projectCwd),
      resolveNonWorkflowProviderModel(projectCwd),
      resolveAuxiliaryProviderEnvironment(projectCwd, { name: 'test-workflow' }),
    ];
    for (const result of results) expect(result).toMatchObject({ provider: 'codex', model: 'gpt-5' });

    await initialize();

    expect(await workflowEnvironment()).toMatchObject({ provider: 'mock', model: 'base-model' });
    expect(resolveAssistantProviderModel(projectCwd)).toMatchObject({ provider: 'mock', model: 'base-model' });
    expect(resolveSelectorProviderForProject(projectCwd)).toMatchObject({ provider: 'mock', model: 'base-model' });
    expect(resolveNonWorkflowProviderModel(projectCwd)).toMatchObject({ provider: 'mock', model: 'base-model' });
    expect(resolveAuxiliaryProviderEnvironment(projectCwd, { name: 'test-workflow' }))
      .toMatchObject({ provider: 'mock', model: 'base-model' });
  });

  it('stops first-run setup failure without publishing a selection or running the action', async () => {
    await initialize('cost');
    await prepareFirstRun();
    doubles.selectOption.mockReset().mockRejectedValueOnce(new Error('setup input failed'));
    doubles.initProjectDirs.mockClear();
    doubles.initGitProvider.mockClear();
    const { initializeCliExecutionContext, getCliExecutionContext } = await import('../app/cli/initialization.js');
    const { getInvocationRuntimeAssignment } = await import('../infra/config/runtime-provider/invocation.js');
    const action = vi.fn();
    const command = new Command().option('--runtime-assignment <name>')
      .hook('preAction', (root) => initializeCliExecutionContext(root, '1.0.0')).action(action);

    await expect(command.parseAsync(['--runtime-assignment', 'cost'], { from: 'user' }))
      .rejects.toThrow('setup input failed');

    expect(action).not.toHaveBeenCalled();
    expect(doubles.initProjectDirs).not.toHaveBeenCalled();
    expect(doubles.initGitProvider).not.toHaveBeenCalled();
    expect(getInvocationRuntimeAssignment()).toBeUndefined();
    expect(() => getCliExecutionContext()).toThrow();
    expect(existsSync(join(globalDir, 'config.yaml'))).toBe(false);
    expect(existsSync(join(globalDir, 'runtime.yaml'))).toBe(false);

    doubles.selectOption.mockResolvedValueOnce('en').mockResolvedValueOnce('codex').mockResolvedValueOnce('gpt-5');
    await initialize();
    expect(await workflowEnvironment()).toMatchObject({ provider: 'mock', model: 'base-model' });
  });

  it('uses one CLI selection for workflow, selector, assistant and non-workflow resolution', async () => {
    await initialize('cost');
    const { resolveSelectorProviderForProject } = await import('../infra/config/selectorProviderResolution.js');
    const { resolveAssistantProviderModel } = await import('../features/interactive/assistantConfig.js');
    const { resolveNonWorkflowProviderModel } = await import('../infra/config/nonWorkflowProvider.js');
    const { resolveAuxiliaryProviderEnvironment } = await import('../infra/config/runtime-provider/provider-environment.js');

    const results = [
      await workflowEnvironment(),
      resolveSelectorProviderForProject(projectCwd),
      resolveAssistantProviderModel(projectCwd),
      resolveNonWorkflowProviderModel(projectCwd),
      resolveAuxiliaryProviderEnvironment(projectCwd, { name: 'test-workflow' }),
    ];

    for (const result of results) expect(result).toMatchObject({
      provider: 'codex', model: 'cost-model', providerOptions: { codex: { reasoningEffort: 'low' } },
    });
  });

  it('uses --runtime-file instead of project runtime.yaml across runtime resolvers and the analysis worker', async () => {
    const runtimeFilePath = 'runtime.cost.yaml';
    const selectedRuntimeYaml = stringifyYaml({
      version: 1,
      companion: { enabled: false },
      loop_analysis: { enabled: true, output: 'file' },
      provider: {
        defaults: { profile: 'selected' },
        profiles: { selected: { provider: 'mock', model: 'selected-model' } },
        targets: { internal_agents: {
          selector: { profile: 'selected' },
          assistant: { profile: 'selected' },
        } },
      },
    });
    writeFileSync(join(projectCwd, runtimeFilePath), selectedRuntimeYaml);

    await initialize(undefined, runtimeFilePath);

    const { getInvocationRuntimeFilePath } = await import('../infra/config/runtime-provider/invocation.js');
    expect(getInvocationRuntimeFilePath()).toBe(join(projectCwd, runtimeFilePath));
    const { resolveSelectorProviderForProject } = await import('../infra/config/selectorProviderResolution.js');
    const { resolveAssistantProviderModel } = await import('../features/interactive/assistantConfig.js');
    const { resolveNonWorkflowProviderModel } = await import('../infra/config/nonWorkflowProvider.js');
    const { resolveAuxiliaryProviderEnvironment } = await import('../infra/config/runtime-provider/provider-environment.js');
    const results = [
      await workflowEnvironment(),
      resolveSelectorProviderForProject(projectCwd),
      resolveAssistantProviderModel(projectCwd),
      resolveNonWorkflowProviderModel(projectCwd),
      resolveAuxiliaryProviderEnvironment(projectCwd, { name: 'test-workflow' }),
    ];
    for (const result of results) expect(result).toMatchObject({ provider: 'mock', model: 'selected-model' });

    const { createLoopAnalysisScheduler } = await import('../features/tasks/execute/loopAnalysis.js');
    const { readLoopAnalysisJob } = await import('../features/tasks/execute/loopAnalysisJob.js');
    const sourceRunDirectory = join(projectDir, 'runs', 'selected-runtime');
    mkdirSync(sourceRunDirectory, { recursive: true });
    createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);
    const jobDirectory = join(sourceRunDirectory, '.takt-report-internal', 'loop-analysis');
    const jobs = readdirSync(jobDirectory).filter((file) => file.endsWith('.job.json'));
    expect(jobs).toHaveLength(1);
    expect(readLoopAnalysisJob(join(jobDirectory, jobs[0]!)).runtimeFilePath)
      .toBe(join(projectCwd, runtimeFilePath));
    expect(readFileSync(join(projectCwd, runtimeFilePath), 'utf8')).toBe(selectedRuntimeYaml);

    await initialize();
    expect(getInvocationRuntimeFilePath()).toBeUndefined();
    expect(await workflowEnvironment()).toMatchObject({ provider: 'mock', model: 'directory-model' });
  });

  it('rejects a missing --runtime-file before setup instead of falling back to project runtime.yaml', async () => {
    const selectedFile = join(projectCwd, 'missing-runtime.yaml');
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');
    const action = vi.fn();
    const command = new Command().option('--runtime-file <path>')
      .hook('preAction', (root) => initializeCliExecutionContext(root, '1.0.0')).action(action);

    await expect(command.parseAsync(['--runtime-file', selectedFile], { from: 'user' }))
      .rejects.toThrow(new RegExp(`${selectedFile}.*(?:ENOENT|no such file)`, 'i'));

    expect(action).not.toHaveBeenCalled();
    expect(doubles.initGlobalDirs).not.toHaveBeenCalled();
    expect(doubles.initProjectDirs).not.toHaveBeenCalled();
    expect(doubles.initGitProvider).not.toHaveBeenCalled();
  });

  it('hands the invocation selection to the detached analysis job', async () => {
    await initialize('cost');
    const { createLoopAnalysisScheduler } = await import('../features/tasks/execute/loopAnalysis.js');
    const { readLoopAnalysisJob } = await import('../features/tasks/execute/loopAnalysisJob.js');
    const sourceRunDirectory = join(projectDir, 'runs', 'source-run');
    mkdirSync(sourceRunDirectory, { recursive: true });

    const scheduler = createLoopAnalysisScheduler({ projectCwd });
    expect(scheduler).toBeTypeOf('function');
    scheduler?.(sourceRunDirectory);

    const directory = join(sourceRunDirectory, '.takt-report-internal', 'loop-analysis');
    const jobs = readdirSync(directory).filter((file) => file.endsWith('.job.json'));
    expect(jobs).toHaveLength(1);
    expect(readLoopAnalysisJob(join(directory, jobs[0]!))).toMatchObject({ runtimeAssignment: 'cost' });
    expect(doubles.spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps provider and model overrides above the selected assignment', async () => {
    await initialize('cost');
    const { resolveRuntimeEnvironment } = await import('../infra/config/runtime-provider/provider-environment.js');
    const { resolveAssistantProviderModel } = await import('../features/interactive/assistantConfig.js');
    const overridden = resolveRuntimeEnvironment({ projectCwd, legacySignals: [], legacy: {
      provider: 'mock', providerSource: 'cli', model: 'override-model', modelSource: 'cli',
      personaProviders: undefined, providerRouting: undefined, autoRouting: undefined, providerOptions: undefined,
    } }).providerEnvironment;

    expect(overridden).toMatchObject({ provider: 'mock', model: 'override-model' });
    expect(overridden.providerOptions).toBeUndefined();
    expect(resolveAssistantProviderModel(projectCwd, { model: 'model-only' })).toMatchObject({
      provider: 'codex', model: 'model-only', providerOptions: { codex: { reasoningEffort: 'low' } },
    });
  });

  it('rejects the invocation name at another project boundary instead of using that project directory assignment', async () => {
    await initialize('cost');
    const otherCwd = join(projectCwd, 'other-project');
    const otherConfigDir = join(otherCwd, '.takt');
    mkdirSync(otherConfigDir, { recursive: true });
    writeRuntime(otherConfigDir, { version: 1, provider: {
      defaults: { profile: 'base' }, profiles: { base: { provider: 'mock', model: 'other-model' } },
      assignments: { directory: { defaults: { profile: 'base' } } },
      directories: { [otherCwd]: 'directory' },
    } });
    const { resolveNonWorkflowProviderModel } = await import('../infra/config/nonWorkflowProvider.js');

    expect(() => resolveNonWorkflowProviderModel(otherCwd)).toThrow('cost');
  });

  it('restores the job selection before resolving the analysis workflow provider', async () => {
    const jobPath = join(projectCwd, 'analysis.job.json');
    const reportDirectory = join(projectDir, 'runs', 'analysis', 'reports');
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(join(reportDirectory, 'loop-analysis.md'), '# Analysis\n');
    writeFileSync(jobPath, JSON.stringify({
      version: 1, projectCwd, sourceRunDirectory: join(projectDir, 'runs', 'source'),
      output: 'file', parentPid: process.pid, runtimeAssignment: 'cost',
    }), { mode: 0o600 });
    const observedProvider = vi.fn();
    doubles.runAnalysis.mockImplementation(async () => {
      observedProvider(await workflowEnvironment());
      return { success: true, reportDirectory };
    });
    const { executeLoopAnalysisJob } = await import('../features/tasks/execute/loopAnalysisWorker.js');

    await executeLoopAnalysisJob(jobPath);

    expect(observedProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex', model: 'cost-model', providerOptions: { codex: { reasoningEffort: 'low' } },
    }));
  });

  it('persists an unavailable worker assignment failure before analysis starts', async () => {
    const jobPath = join(projectCwd, 'analysis.job.json');
    writeFileSync(jobPath, JSON.stringify({
      version: 1, projectCwd, sourceRunDirectory: join(projectDir, 'runs', 'source'),
      output: 'file', parentPid: process.pid, runtimeAssignment: 'typo',
    }), { mode: 0o600 });
    const { runLoopAnalysisWorker } = await import('../features/tasks/execute/loopAnalysisWorker.js');

    await expect(runLoopAnalysisWorker(jobPath)).rejects.toThrow('typo');

    expect(doubles.runAnalysis).not.toHaveBeenCalled();
    const failures = readFileSync(join(projectCwd, 'worker-errors.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { error: string });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain('typo');
  });

  it.each([
    ['unknown name', 'typo', 'defined'],
    ['assignments omitted', 'cost', 'no-assignments'],
    ['legacy provider', 'cost', 'legacy'],
    ['inactive provider', 'cost', 'inactive'],
    ['MCP without provider', 'cost', 'mcp-only'],
  ])('rejects %s before initialization writes or the command action starts', async (_label, name, mode) => {
    await prepareFirstRun();
    if (mode === 'no-assignments') writeRuntime(projectDir, { version: 1, provider: {
      defaults: { profile: 'base' }, profiles: { base: { provider: 'mock' } },
    } });
    if (mode === 'legacy') {
      writeRuntime(projectDir, { version: 1 });
    }
    if (mode === 'inactive') writeRuntime(projectDir, { version: 1, provider: {} });
    if (mode === 'mcp-only') writeRuntime(projectDir, { version: 1, mcp: {
      servers: { tools: { command: 'test-tools' } },
    } });
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');
    const action = vi.fn();
    const command = new Command().option('--runtime-assignment <name>')
      .hook('preAction', (root) => initializeCliExecutionContext(root, '1.0.0')).action(action);

    const startup = command.parseAsync(['--runtime-assignment', name], { from: 'user' });
    await expect(startup).rejects.toThrow(name);
    await expect(startup).rejects.toThrow(mode === 'defined' ? 'cost' : /no assignments/i);

    expect(doubles.selectOption).not.toHaveBeenCalled();
    expect(doubles.promptInput).not.toHaveBeenCalled();
    expect(existsSync(join(globalDir, 'config.yaml'))).toBe(false);
    expect(existsSync(join(globalDir, 'runtime.yaml'))).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(doubles.initGlobalDirs).not.toHaveBeenCalled();
    expect(doubles.initProjectDirs).not.toHaveBeenCalled();
  });

  it('keeps runtime and config files unchanged and does not carry selection into an unspecified invocation', async () => {
    const files = [join(globalDir, 'config.yaml'), join(projectDir, 'config.yaml'), join(projectDir, 'runtime.yaml')];
    const original = files.map((file) => readFileSync(file, 'utf8'));
    await initialize('cost');
    expect(await workflowEnvironment()).toMatchObject({ provider: 'codex', model: 'cost-model' });

    await initialize();

    expect(await workflowEnvironment()).toMatchObject({ provider: 'mock', model: 'directory-model' });
    expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(original);
  });
});
