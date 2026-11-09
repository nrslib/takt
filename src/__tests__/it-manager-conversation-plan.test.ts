import type { CodexOptions } from '@openai/codex-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expandFacetIncludes } from '#faceted-prompting/cli/facet-includes';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { parse } from 'yaml';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { renderTemplate } from '../shared/prompts/index.js';
import { loadFormalSpecVerifierConstraints } from '../features/interactive/formalSpecPrompts.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createConversationRuntime } from '../features/manager/conversationRuntime.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import type { ManagerAssignmentIdentity } from '../features/manager/assignment.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { MANAGER_ASSIGNMENT_HEADER } from '../features/manager/assignment.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { callClaudeCustom } from '../infra/claude/client.js';
import { resolveNonWorkflowProviderOptions } from '../infra/config/index.js';
import { runCodexMcpList } from '../infra/codex/mcp-list.js';
import { invalidateGlobalConfigCache,loadGlobalConfig,saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { loadProjectConfig,saveProjectConfig } from '../infra/config/project/projectConfig.js';
import * as providers from '../infra/providers/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';

const codex = vi.hoisted(() => ({ constructor: vi.fn(), startThread: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: CodexOptions) { codex.constructor(options); }
  startThread = codex.startThread;
} }));
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  loadManagedSdk: (await import('./helpers/managed-sdk.js')).loadManagedSdk,
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed/codex' })),
}));
vi.mock('../infra/codex/mcp-list.js', () => ({ runCodexMcpList: vi.fn(), hasCodexMcpServer: vi.fn() }));
vi.mock('../infra/claude/client.js', () => ({ callClaude: vi.fn(), callClaudeCustom: vi.fn() }));


async function executeTurn(executor: ReturnType<typeof createManagerTurnExecutor>, input: { text: string }, assignment?: ManagerAssignmentIdentity) {
  return executor.execute({ prompt: input.text, sessionId: undefined, assignment,
    abortSignal: new AbortController().signal });
}

describe('manager conversation configuration and provider boundary', () => {
  let cwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = mkdtempSync(join(root, 'manager-plan-'));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmodel: legacy-manager\nlanguage: en\n');
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); invalidateGlobalConfigCache(); rmSync(cwd, { recursive: true, force: true }); });

  it.each([
    ['legacy configuration', false, {}, 'mock'],
    ['runtime assistant profile', true, {}, 'mock'],
    ['CLI model override', true, { model: 'cli-model' }, 'mock'],
    ['CLI provider override', true, { provider: 'mock' as const }, 'claude-sdk'],
  ])('uses the assistant resolver for %s', (_description, runtime, overrides, profileProvider) => {
    if (runtime) {
      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: en\n');
      writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
        'version: 1', 'provider:', '  profiles:', '    assistant-profile:',
        `      provider: ${profileProvider}`, '      model: runtime-manager',
        '  defaults:', '    profile: assistant-profile',
        '  targets:', '    internal_agents:', '      assistant:', '        profile: assistant-profile',
      ].join('\n'));
    }
    const expected = resolveAssistantProviderModel(cwd, overrides);

    const plan = createManagerConversationPlan(cwd, { language: 'en', ...overrides });

    expect(plan.ctx.providerType).toBe(expected.provider);
    expect(plan.ctx.model).toBe(expected.model);
  });

  it('starts with retired manager settings present without constructing a judge', async () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: en\nmanager:\n  sensitive_paths: [private]\n');
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
      'version: 1', 'provider:', '  profiles:', '    manager: { provider: mock, model: legacy-compatible }',
      '  defaults: { profile: manager }', '  targets:', '    internal_agents:',
      '      manager-permission-judge: { profile: no-longer-installed }',
    ].join('\n'));
    const plan = createManagerConversationPlan(cwd, {});
    expect(plan.ctx.model).toBe('legacy-compatible');
    expect(plan).not.toHaveProperty('permissionJudge');
    expect(resolveManagerConfig(cwd)).not.toHaveProperty('sensitivePaths');
    expect((await executeTurn(createManagerTurnExecutor(cwd, plan), { text: 'Continue' })).summary).toBeNull();
  });

  it('uses the default concurrency and resolves project concurrency ahead of global configuration', () => {
    invalidateGlobalConfigCache();
    expect(createManagerConversationPlan(cwd, {}).strategy.systemPrompt.split('\n').at(-1)).toBe('Concurrency limit: 1');
    saveGlobalConfig({ ...loadGlobalConfig(), concurrency: 2 });
    invalidateGlobalConfigCache();
    expect(createManagerConversationPlan(cwd, {}).strategy.systemPrompt.split('\n').at(-1)).toBe('Concurrency limit: 2');
    saveProjectConfig(cwd, { ...loadProjectConfig(cwd), concurrency: 3 });
    expect(createManagerConversationPlan(cwd, {}).strategy.systemPrompt.split('\n').at(-1)).toBe('Concurrency limit: 3');
  });

  it.each(['auto', 'full'] as const)('rebuilds the conversation runtime after global manager permission changes from %s', async (permission) => {
    const globalConfigPath = join(getGlobalConfigDir(), 'config.yaml');
    writeFileSync(globalConfigPath, `manager:\n  permission: ${permission}\n`);
    const preflight = vi.fn();
    vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({
      supportsStructuredOutput: true, supportedMcpTransports: new Set(['stdio']), preflight,
    }));
    const dispose = vi.fn(async () => {});
    const client = new Client({ name: 'manager-runtime-test', version: '1.0.0' });
    const connect = vi.spyOn(managerMcp, 'connectManagerMcp').mockResolvedValue({ client, servers: {}, dispose });
    const runtime = createConversationRuntime(getGlobalConfigDir());
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    const signal = new AbortController().signal;
    try {
      const first = await runtime.resolve(assignment, signal);
      expect(preflight).toHaveBeenLastCalledWith(expect.objectContaining({ aiReviewPermissions: permission === 'auto' }));

      writeFileSync(globalConfigPath, `manager:\n  permission: ${permission === 'auto' ? 'full' : 'auto'}\n`);
      const second = await runtime.resolve(assignment, signal);

      expect(preflight).toHaveBeenLastCalledWith(expect.objectContaining({ aiReviewPermissions: permission !== 'auto' }));
      expect(second.contextKey).not.toBe(first.contextKey);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(dispose).toHaveBeenCalledOnce();
      expect(await runtime.resolve(assignment, signal)).toBe(second);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });

  it('reloads cached project configuration on the next conversation resolve', async () => {
    const dispose = vi.fn(async () => {});
    const client = new Client({ name: 'manager-runtime-test', version: '1.0.0' });
    vi.spyOn(managerMcp, 'connectManagerMcp').mockResolvedValue({ client, servers: {}, dispose });
    const runtime = createConversationRuntime(getGlobalConfigDir());
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    const signal = new AbortController().signal;
    try {
      const first = await runtime.resolve(assignment, signal);
      expect(first.language).toBe('en');

      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmodel: legacy-manager\nlanguage: ja\n');
      const second = await runtime.resolve(assignment, signal);

      expect(second.language).toBe('ja');
      expect(second.contextKey).not.toBe(first.contextKey);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  it.each([true, 'Y/n', false, 'y/N'] as const)('resolves manager formal_spec %s without prompting', (mode) => {
    const enabled = mode === true || mode === 'Y/n';
    saveGlobalConfig({ ...loadGlobalConfig(), assistant: { formalSpec: { mode: !enabled, comments: true, modelCheckTimeoutSeconds: 42 } } });
    invalidateGlobalConfigCache();
    saveProjectConfig(cwd, { ...loadProjectConfig(cwd), assistant: { formalSpec: { mode, comments: false } } });
    const prompt = createManagerConversationPlan(cwd, {}).strategy.systemPrompt;
    expect(prompt).toContain(`Formal specification configuration: ${JSON.stringify({ mode: enabled, comments: false, modelCheckTimeoutSeconds: 42 })}`);
    const notation = readFileSync(join(process.cwd(), 'builtins', 'en', 'facets', 'partials', 'instructions', 'manager-specification-notation.md'), 'utf8');
    const formalBody = notation.split('{{#if formalSpec}}')[1]!.split('{{/if}}')[0]!;
    const commentsBody = notation.split('{{#if formalSpecCommentsEnabled}}')[1]!.split('{{/if}}')[0]!;
    expect(prompt.includes(renderTemplate(formalBody.trim(), {
      formalSpecVerifierConstraints: loadFormalSpecVerifierConstraints('en'),
    }))).toBe(enabled);
    expect(prompt).not.toContain(commentsBody.trim());
    expect(prompt).not.toMatch(/\{\{(?:#if|\/if|else)/);
    expect(prompt).toContain('Gherkin');
  });

  it('passes repository formal specification overrides to workspace manager prompts', () => {
    const other = join(cwd, 'other'); mkdirSync(other); mkdirSync(join(other, '.takt'));
    writeFileSync(join(other, '.takt', 'config.yaml'), 'assistant:\n  formal_spec:\n    mode: true\n    comments: false\n');
    const prompt = createManagerConversationPlan(cwd, { repositoryDirectories: [cwd, other] }).strategy.systemPrompt;
    const line = prompt.split('\n').find((line) => line.startsWith('Formal specification configuration: '))!;
    expect(JSON.parse(line.slice('Formal specification configuration: '.length))).toEqual([
      { repositoryDirectory: cwd, mode: false, comments: true, modelCheckTimeoutSeconds: 900 },
      { repositoryDirectory: other, mode: true, comments: false, modelCheckTimeoutSeconds: 900 },
    ]);
  });

  it('passes resolved runtime provider options without manager overrides', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: en\n');
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
      'version: 1', 'provider:', '  profiles:', '    assistant-profile:',
      '      provider: claude-sdk', '      model: runtime-manager',
      '      options:', '        effort: high', '        allowed_tools: [Read, Bash]', '        skills:', '          enabled: true',
      '  defaults:', '    profile: assistant-profile',
      '  targets:', '    internal_agents:', '      assistant:', '        profile: assistant-profile',
    ].join('\n'));
    const expected = resolveAssistantProviderModel(cwd);

    const plan = createManagerConversationPlan(cwd, { language: 'en' });

    expect(plan.ctx.providerType).toBe(expected.provider);
    expect(plan.ctx.model).toBe(expected.model);
    expect(expected.providerOptions?.claude?.effort).toBe('high');
    expect(plan.ctx.providerOptions).toEqual(expected.providerOptions);
    expect(plan.ctx.providerOptions?.claude?.allowedTools).toEqual(['Read', 'Bash']);
  });

  it.each([
    { language: 'ja', mainMerge: 'auto' }, { language: 'ja', mainMerge: 'approve' },
    { language: 'en', mainMerge: 'auto' }, { language: 'en', mainMerge: 'approve' },
  ] as const)('loads the $language manager assets and repository $mainMerge permission into the actual provider prompt', async ({ language, mainMerge }) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nconcurrency: 3\nmanager:\n  main_merge: ${mainMerge}\n  auto_run: false\n`);
    const persona = readFileSync(join(process.cwd(), 'builtins', language, 'facets', 'personas', 'manager.md'), 'utf8');
    const facetsRoot = join(process.cwd(), 'builtins', language, 'facets');
    const { body: instruction } = expandFacetIncludes({
      body: readFileSync(join(facetsRoot, 'instructions', 'manager.md'), 'utf8'),
      facetsRoots: [facetsRoot], repertoireDirs: [], allowedRoots: [facetsRoot],
    });
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: 'question' });
    const setup = vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language });
    const session = createManagerTurnExecutor(cwd, plan);

    {
      expect(await executeTurn(session, { text: 'ゴールを相談したい' })).toMatchObject({ message: 'question', summary: null });

      expect(persona.trim().length).toBeGreaterThan(0);
      expect(instruction.trim().length).toBeGreaterThan(0);
      expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(persona.trim());
      expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(renderTemplate(instruction.trim(), { formalSpec: false, formalSpecCommentsEnabled: false, formalSpecVerifierConstraints: loadFormalSpecVerifierConstraints(language) }));
      for (const kind of ['policies', 'knowledge']) {
        const content = readFileSync(join(facetsRoot, kind, 'manager.md'), 'utf8').trim();
        expect(content.length).toBeGreaterThan(0);
        expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(content);
      }
      expect(setup.mock.calls[0]?.[0].systemPrompt).not.toContain('{{include:');
      const prompt = setup.mock.calls[0]![0].systemPrompt!;
      const settings = prompt.split('\n').filter((line) => line.startsWith('Repository manager.main_merge: '));
      expect(settings).toEqual([`Repository manager.main_merge: ${JSON.stringify(mainMerge)}`]);
      expect(prompt?.split('\n').filter((line) => line.startsWith('Concurrency limit: '))).toEqual(['Concurrency limit: 3']);
      expect(call).toHaveBeenCalledTimes(1);
    }
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each(['ja', 'en'] as const)('exposes task integration fields and status values in the %s manager guidance', (language) => {
    const knowledge = readFileSync(join(process.cwd(), 'builtins', language, 'facets', 'knowledge', 'manager.md'), 'utf8');
    const paragraph = knowledge.split('\n\n').find((body) => body.includes('goalIntegration'));
    expect(paragraph).toBeDefined();
    const terms = paragraph?.match(/[A-Za-z_]+/g);
    for (const field of ['takt_list_tasks', 'goalIntegration', 'goalIntegrationReason', 'integrated', 'not_integrated', 'unknown', 'direct_push']) {
      expect(terms).toContain(field);
    }
    const plan = createManagerConversationPlan(cwd, { language });
    expect(plan.strategy.systemPrompt).toContain(paragraph!);
  });

  it('passes full permissions without a fixed tool allowlist to the mock provider', async () => {
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message: 'question', summary: null }), structuredOutput: { message: 'question', summary: null } });
    vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language: 'en' });
    const session = createManagerTurnExecutor(cwd, plan);

    await executeTurn(session, { text: 'ソースを読み、既存のゴールを確認してください' });

    expect(call).toHaveBeenCalledTimes(1);
    const options = call.mock.calls[0]![1];
    expect(options.allowedTools).toBeUndefined();
    expect(options.permissionMode).toBe('full');
    expect(options.mcpOnlySideEffects).toBeUndefined();
    expect(options.outputSchema).toBeDefined();
    expect(options.sessionId).toBeUndefined();
    expect(JSON.stringify(call.mock.calls).includes('PRIVATE KEY')).toBe(false);
  });

  it.each(['ja', 'en'] as const)('passes resolved %s policy and knowledge to the actual provider', async (language) => {
    for (const kind of ['policies', 'knowledge']) {
      const directory = join(cwd, '.takt', 'facets', kind);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'manager.md'), `fixture-${language}-${kind}`);
    }
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({
      persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'),
      content: JSON.stringify({ message: '確認しました', summary: null }),
    });
    const setup = vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const session = createManagerTurnExecutor(cwd, createManagerConversationPlan(cwd, { language }));
    {
      await executeTurn(session, { text: '次の作業を判断してください' });
      const prompt = setup.mock.calls[0]![0].systemPrompt;
      expect(prompt).toContain(`fixture-${language}-policies`);
      expect(prompt).toContain(`fixture-${language}-knowledge`);
    }
  });

  it('provides the configured default workflow to the manager turn', async () => {
    const workflows = join(cwd, '.takt', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, 'fixture-fallback-workflow.yaml'), [
      'name: fixture-fallback-workflow', 'description: default workflow fixture',
      'max_steps: 2', 'initial_step: work', 'steps:',
      '  - name: work', '    persona: coder', '    instruction: Implement validation',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  default_workflow: fixture-fallback-workflow\n');
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({
      persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'),
      content: JSON.stringify({ message: '確認しました', summary: null }),
    });
    const setup = vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const session = createManagerTurnExecutor(cwd, createManagerConversationPlan(cwd, {}));
    {
      expect((await executeTurn(session, { text: 'workflowを選んでください' })).message).toBeTypeOf('string');
      expect(`${setup.mock.calls[0]![0].systemPrompt}\n${call.mock.calls[0]![0]}`)
        .toContain('fixture-fallback-workflow');
    }
  });

  it.each([false, true])('preserves manager settings through project configuration load and save (auto run: %s)', (autoRun) => {
    const path = join(cwd, '.takt', 'config.yaml');
    writeFileSync(path, [
      'provider: mock', 'manager:', `  auto_run: ${autoRun}`,
      '  default_workflow: fixture-fallback-workflow',
    ].join('\n'));

    const loaded = loadProjectConfig(cwd);
    saveProjectConfig(cwd, loaded);

    expect(parse(readFileSync(path, 'utf8'))).toMatchObject({
      manager: { auto_run: autoRun, default_workflow: 'fixture-fallback-workflow' },
    });
    expect(loadProjectConfig(cwd)).toEqual(loaded);
  });

  it.each([false, true])('preserves global manager settings and resolves project fields independently (auto run: %s)', (autoRun) => {
    const globalDirectory = join(cwd, 'global');
    mkdirSync(globalDirectory);
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    writeFileSync(join(globalDirectory, 'config.yaml'), `provider: mock\nmanager:\n  auto_run: ${autoRun}\n  default_workflow: global-fallback\n`);
    invalidateGlobalConfigCache();
    const loaded = loadGlobalConfig();
    saveGlobalConfig(loaded);
    invalidateGlobalConfigCache();
    expect(loadGlobalConfig().manager).toEqual({ autoRun, defaultWorkflow: 'global-fallback' });
    expect(parse(readFileSync(join(globalDirectory, 'config.yaml'), 'utf8'))).toMatchObject({ manager: { auto_run: autoRun, default_workflow: 'global-fallback' } });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nmanager:\n  auto_run: ${!autoRun}\n`);
    expect(resolveManagerConfig(cwd)).toMatchObject({ autoRun: !autoRun, defaultWorkflow: 'global-fallback', mainMerge: 'approve' });
  });

  it.each(['auto', 'approve'])('loads and saves repository main merge permission %s without losing other manager settings', (mainMerge) => {
    const path = join(cwd, '.takt', 'config.yaml');
    writeFileSync(path, `provider: mock\nmanager:\n  main_merge: ${mainMerge}\n  auto_run: false\n  default_workflow: default\n`);
    const loaded = loadProjectConfig(cwd);
    expect(loaded.manager).toMatchObject({ mainMerge, autoRun: false, defaultWorkflow: 'default' });
    saveProjectConfig(cwd, loaded);
    expect(parse(readFileSync(path, 'utf8'))).toMatchObject({ manager: { main_merge: mainMerge, auto_run: false, default_workflow: 'default' } });
    expect(resolveManagerConfig(cwd)).toMatchObject({ mainMerge, autoRun: false, defaultWorkflow: 'default' });
  });

  it.each(['project', 'global'] as const)('preserves notification switches through %s configuration load and save', (scope) => {
    const directory = scope === 'project' ? join(cwd, '.takt') : process.env.TAKT_CONFIG_DIR!;
    const path = join(directory, 'config.yaml');
    const notifications = { question: false, awaiting_merge: true, completed: false, progress: true, blocked: false, custom: true };
    writeFileSync(path, [
      'provider: mock', 'manager:', '  auto_run: false', '  notifications:',
      ...Object.entries(notifications).map(([kind, enabled]) => `    ${kind}: ${enabled}`),
    ].join('\n'));
    invalidateGlobalConfigCache();

    if (scope === 'project') saveProjectConfig(cwd, loadProjectConfig(cwd));
    else saveGlobalConfig(loadGlobalConfig());
    invalidateGlobalConfigCache();

    expect(parse(readFileSync(path, 'utf8'))).toMatchObject({ manager: { notifications, auto_run: false } });
    expect(resolveManagerConfig(cwd)).toMatchObject({ notifications, autoRun: false, mainMerge: 'approve' });
  });

  it('rejects an unknown repository main merge permission', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  main_merge: always\n');
    expect(() => loadProjectConfig(cwd)).toThrow();
  });

  it.each(['project', 'global'] as const)('loads and saves manager permissions at the %s scope', (scope) => {
    const directory = scope === 'project' ? join(cwd, '.takt') : getGlobalConfigDir();
    const path = join(directory, 'config.yaml');
    writeFileSync(path, 'provider: mock\nmanager:\n  permission: full\n  provider_permissions:\n    claude: auto\n    codex: full\n');
    invalidateGlobalConfigCache();
    const loaded = scope === 'project' ? loadProjectConfig(cwd) : loadGlobalConfig();
    expect(loaded.manager).toMatchObject({ permission: 'full', providerPermissions: { claude: 'auto', codex: 'full' } });
    if (scope === 'project') saveProjectConfig(cwd, loaded);
    else saveGlobalConfig({ ...loadGlobalConfig(), manager: loaded.manager });
    invalidateGlobalConfigCache();
    expect(parse(readFileSync(path, 'utf8'))).toMatchObject({ manager: { permission: 'full', provider_permissions: { claude: 'auto', codex: 'full' } } });
    expect(createManagerConversationPlan(cwd, { provider: 'claude-sdk' }).ctx.aiReviewPermissions).toBe(true);
    expect(createManagerConversationPlan(cwd, { provider: 'codex' }).ctx.aiReviewPermissions).toBe(false);
    expect(createManagerConversationPlan(cwd, { provider: 'opencode', model: 'test/model' }).ctx.aiReviewPermissions).toBe(false);
  });

  it.each(['project', 'global'] as const)('rejects invalid manager permissions when loading %s config', (scope) => {
    const directory = scope === 'project' ? join(cwd, '.takt') : getGlobalConfigDir();
    for (const setting of ['permission: edit', 'provider_permissions: { codex: never }']) {
      writeFileSync(join(directory, 'config.yaml'), `provider: mock\nmanager:\n  ${setting}\n`);
      invalidateGlobalConfigCache();
      expect(() => scope === 'project' ? loadProjectConfig(cwd) : loadGlobalConfig()).toThrow();
    }
  });

  it('defaults manager permission to AI review after resolving the actual provider override', () => {
    saveProjectConfig(cwd, { provider: 'mock', manager: { permission: 'full', providerPermissions: { 'claude-sdk': 'auto' } } });
    expect(createManagerConversationPlan(cwd, { provider: 'claude' }).ctx.aiReviewPermissions).toBe(true);
    expect(createManagerConversationPlan(cwd, {}).ctx.aiReviewPermissions).toBe(false);
    saveProjectConfig(cwd, { provider: 'codex' });
    expect(createManagerConversationPlan(cwd, {}).ctx.aiReviewPermissions).toBe(true);
  });

  it.each([
    { supportsStructuredOutput: false, supportedMcpTransports: new Set(['stdio'] as const) },
    { supportsStructuredOutput: true, supportedMcpTransports: new Set(['http'] as const) },
  ])('rejects an unsupported manager conversation capability before setup: %s', (capabilities) => {
    const setup = vi.fn();
    vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ ...capabilities, setup }));
    expect(() => createManagerConversationPlan(cwd, {})).toThrow();
    expect(setup).not.toHaveBeenCalled();
  });

  it('accepts structured output and stdio without MCP-only side effect support', () => {
    const provider = makeProvider({
      supportsStructuredOutput: true, supportedMcpTransports: new Set(['stdio']),
      supportsMcpOnlySideEffects: false,
    });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    expect(createManagerConversationPlan(cwd, {}).ctx.providerType).toBe('mock');
  });

  it.each([
    { hasAmbientServer: false, permission: 'auto' }, { hasAmbientServer: true, permission: 'auto' },
    { hasAmbientServer: false, permission: 'full' }, { hasAmbientServer: true, permission: 'full' },
  ] as const)('starts Codex manager with $permission permissions and user MCP (extra server: $hasAmbientServer)', async ({ hasAmbientServer, permission }) => {
    saveProjectConfig(cwd, { ...loadProjectConfig(cwd), manager: { permission } });
    const codexHome = join(cwd, 'codex-home');
    mkdirSync(codexHome);
    const configPath = join(codexHome, 'config.toml');
    const authPath = join(codexHome, 'auth.json');
    const config = hasAmbientServer
      ? '[mcp_servers.unrelated]\ncommand = "node"\nargs = ["unrelated-mcp.js"]\n'
      : '';
    const auth = '{}\n';
    writeFileSync(configPath, config);
    writeFileSync(authPath, auth);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('TAKT_CODEX_CLI_PATH', process.execPath);
    codex.startThread.mockReturnValue({ runStreamed: async () => ({ events: (async function* () {
      yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ message: 'question', summary: null }) } };
      yield { type: 'turn.completed' };
    })() }) });
    const plan = createManagerConversationPlan(cwd, { provider: 'codex' });
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd };
    const managerHeaders = { authorization: 'Bearer manager-fixture', [MANAGER_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(assignment)).toString('base64url') };
    const session = createManagerTurnExecutor(cwd, { ...plan, ctx: { ...plan.ctx, mcpServers: {
        [TAKT_MANAGER_MCP_SERVER_NAME]: { type: 'http', url: 'http://127.0.0.1:12345/', headers: managerHeaders },
        browser: { command: '/browser-mcp' },
      } } });
    {
      expect(await executeTurn(session, { text: '相談' }, assignment)).toMatchObject({ summary: null });
      expect(codex.constructor).toHaveBeenCalledTimes(1);
      const sdkOptions = codex.constructor.mock.calls[0]![0] as CodexOptions;
      expect(sdkOptions.config?.mcp_servers).toMatchObject({
        [TAKT_MANAGER_MCP_SERVER_NAME]: { url: 'http://127.0.0.1:12345/', http_headers: managerHeaders }, browser: { command: '/browser-mcp' },
      });
      expect(sdkOptions.config?.hooks).toBeUndefined();
      const manager = (sdkOptions.config!.mcp_servers as Record<string, Record<string, unknown>>)[TAKT_MANAGER_MCP_SERVER_NAME]!;
      expect(manager.tools).toEqual(Object.fromEntries([...TAKT_MCP_MANAGER_TOOL_NAMES, 'takt_pause_goal', 'takt_resume_goal', 'takt_abort_goal'].map((name) => [name, { approval_mode: 'approve' }])));
      expect(manager.tools).toHaveProperty('takt_ask_standalone_question', { approval_mode: 'approve' });
      expect(manager.default_tools_approval_mode).toBeUndefined();
      const browser = (sdkOptions.config!.mcp_servers as Record<string, Record<string, unknown>>).browser!;
      expect(browser.tools).toBeUndefined();
      expect(browser.default_tools_approval_mode).toBeUndefined();
      expect(codex.startThread.mock.calls[0]![0]).toMatchObject(permission === 'auto'
        ? { sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: true }
        : { sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
      if (permission === 'full') expect(codex.startThread.mock.calls[0]![0].networkAccessEnabled).toBeUndefined();
      expect(sdkOptions.config?.approvals_reviewer).toBe(permission === 'auto' ? 'auto_review' : undefined);
      expect(codex.startThread.mock.calls[0]![0].webSearchMode).toBeUndefined();
      expect(runCodexMcpList).not.toHaveBeenCalled();
    }
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(readFileSync(authPath, 'utf8')).toBe(auth);
  });

  it.each(['claude', 'codex', 'opencode'] as const)('accepts %s manager conversations', (provider) => {
    const plan = createManagerConversationPlan(cwd, { provider, model: 'probe/probe' });
    expect(plan.ctx.providerType).toBe(provider);
    expect(plan.ctx.model).toBe('probe/probe');
  });

  it('passes non-workflow provider options without restricting tools or network access', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: claude\nprovider_options:\n  claude:\n    allowed_tools: [Read, Bash]\n    skills:\n      enabled: true\n    sandbox:\n      allow_unsandboxed_commands: true\n      excluded_commands: [git]\n');
    expect(createManagerConversationPlan(cwd, {}).ctx.providerOptions?.claude).toEqual({
      allowedTools: ['Read', 'Bash'], skills: { enabled: true },
      sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['git'] },
    });
  });

  it.each([
    ['network_access: true', { networkAccess: true }],
    ['permission_control: codex', { permissionControl: 'codex' }],
    ['permission_control: codex\n    config_profile: unrestricted', { permissionControl: 'codex', configProfile: 'unrestricted' }],
  ])('passes configured Codex options: %s', (options, expected) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: codex\nprovider_options:\n  codex:\n    ${options}\n`);
    const optionsResolved = createManagerConversationPlan(cwd, {}).ctx.providerOptions;
    expect(optionsResolved).toEqual(resolveNonWorkflowProviderOptions(cwd, undefined, undefined, 'codex'));
    expect(optionsResolved?.codex).toMatchObject(expected);
  });

  it.each((['claude', 'claude-sdk'] as const).flatMap((provider) =>
    (['auto', 'full'] as const).map((permission) => ({ provider, permission }))))(
    'passes $permission permission and owned HTTP headers through the $provider SDK adapter', async ({ provider, permission }) => {
    saveProjectConfig(cwd, { ...loadProjectConfig(cwd), manager: { permission } });
    vi.mocked(callClaudeCustom).mockResolvedValue({
      persona: 'manager', status: 'done', timestamp: new Date(), content: JSON.stringify({ message: '確認', summary: null }),
    });
    const plan = createManagerConversationPlan(cwd, { provider });
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd };
    const headers = { authorization: 'Bearer manager-fixture', [MANAGER_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(assignment)).toString('base64url') };
    const servers = {
      [TAKT_MANAGER_MCP_SERVER_NAME]: { type: 'http' as const, url: 'http://127.0.0.1:12345/', headers },
      browser: { type: 'http' as const, url: 'https://example.test/mcp' },
    };
    const session = createManagerTurnExecutor(cwd, { ...plan, ctx: { ...plan.ctx, mcpServers: servers } });
    {
      expect((await executeTurn(session, { text: '確認' }, assignment)).message).toBeTypeOf('string');
      const options = buildSdkOptions(vi.mocked(callClaudeCustom).mock.calls[0]![3]);
      expect(options.permissionMode).toBe(permission === 'auto' ? 'auto' : 'bypassPermissions');
      if (permission === 'auto') expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
      else expect(options.allowDangerouslySkipPermissions).toBe(true);
      expect(options.mcpServers).toEqual(servers);
      expect(options.hooks?.PreToolUse?.filter(({ matcher }) => matcher === undefined)).toHaveLength(0);
      expect(options.allowedTools).toEqual([
        ...TAKT_MCP_MANAGER_TOOL_NAMES, 'takt_pause_goal', 'takt_resume_goal', 'takt_abort_goal',
      ].map((name) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`));
      expect(options.tools).toBeUndefined();
    }
  });

  it.each([undefined, 'mcp: {}', 'mcp:\n  servers: {}\n  defaults:\n    servers: []'])('starts a manager turn without assigned user MCP: %s', async (section) => {
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), `version: 1\n${section ?? ''}\n`);
    const provider = new MockProvider();
    vi.spyOn(provider, 'setup').mockReturnValue({ call: vi.fn<ProviderAgent['call']>().mockResolvedValue({
      persona: 'manager', status: 'done', timestamp: new Date(), content: JSON.stringify({ message: '確認', summary: null }),
    }) });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, {});
    expect(plan.ctx.mcpServers).toEqual({});
    const session = createManagerTurnExecutor(cwd, plan);
    { expect((await executeTurn(session, { text: '相談' })).message).toBeTypeOf('string'); }
  });

  it('resolves defaults and manager persona additions with persona and internal exclusions', () => {
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
      'version: 1', 'mcp:', '  servers:',
      '    common:', '      command: /common', '    browser:', '      type: stdio', '      command: /absolute/path/to/browser-mcp-server',
      '    removed:', '      command: /removed', '    internal:', '      command: /internal',
      '  defaults:', '    servers: [common, removed, internal]',
      '  targets:', '    personas:', '      manager:', '        servers: [browser, internal]', '        exclude: [removed]',
      '    internal_agents:', '      selector:', '        exclude: [internal]',
    ].join('\n'));
    expect(createManagerConversationPlan(cwd, {}).ctx.mcpServers).toEqual({
      common: { type: 'stdio', command: '/common' }, browser: { type: 'stdio', command: '/absolute/path/to/browser-mcp-server' },
    });
  });

  it('rejects unknown manager MCP references before provider setup', () => {
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), 'version: 1\nmcp:\n  targets:\n    personas:\n      manager:\n        servers: [unknown]\n');
    const setup = vi.spyOn(providers.getProvider('mock'), 'setup');
    expect(() => createManagerConversationPlan(cwd, {})).toThrow(/unknown/);
    expect(setup).not.toHaveBeenCalled();
  });
});
