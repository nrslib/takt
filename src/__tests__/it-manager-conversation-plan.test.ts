import type { CodexOptions } from '@openai/codex-sdk';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { parse } from 'yaml';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { callClaudeCustom } from '../infra/claude/client.js';
import { resolveNonWorkflowProviderOptions } from '../infra/config/index.js';
import { runCodexMcpList } from '../infra/codex/mcp-list.js';
import { CODEX_TOOL_PERMISSION_ENDPOINT_ENV, CODEX_TOOL_PERMISSION_TOKEN_ENV } from '../infra/codex/tool-permission-hook-protocol.js';
import { invalidateGlobalConfigCache,loadGlobalConfig,saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { loadProjectConfig,saveProjectConfig } from '../infra/config/project/projectConfig.js';
import * as providers from '../infra/providers/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';

const codex = vi.hoisted(() => ({ constructor: vi.fn(), startThread: vi.fn(), trust: vi.fn() }));
vi.mock('../infra/codex/hook-trust.js', () => ({ resolveCodexHookTrust: codex.trust }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: CodexOptions) { codex.constructor(options); }
  startThread = codex.startThread;
} }));
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  loadManagedSdk: (await import('./helpers/managed-sdk.js')).loadManagedSdk,
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed/codex' })),
}));
vi.mock('../infra/codex/mcp-list.js', () => ({ runCodexMcpList: vi.fn() }));
vi.mock('../infra/claude/client.js', () => ({ callClaude: vi.fn(), callClaudeCustom: vi.fn() }));

describe('manager conversation configuration and provider boundary', () => {
  let cwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    codex.trust.mockReset().mockResolvedValue({ key: '/<session-flags>/config.toml:pre_tool_use:0:0', trustedHash: 'sha256:fixture-current' });
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

  it('uses the default concurrency and resolves project concurrency ahead of global configuration', () => {
    invalidateGlobalConfigCache();
    expect(createManagerConversationPlan(cwd, {}).strategy.systemPrompt.split('\n').at(-1)).toBe('Concurrency limit: 1');
    saveGlobalConfig({ ...loadGlobalConfig(), concurrency: 2 });
    invalidateGlobalConfigCache();
    expect(createManagerConversationPlan(cwd, {}).strategy.systemPrompt.split('\n').at(-1)).toBe('Concurrency limit: 2');
    saveProjectConfig(cwd, { ...loadProjectConfig(cwd), concurrency: 3 });
    expect(createManagerConversationPlan(cwd, {}).strategy.systemPrompt.split('\n').at(-1)).toBe('Concurrency limit: 3');
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
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message: 'question', summary: null }), structuredOutput: { message: 'question', summary: null } });
    const setup = vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language });
    const session = createManagerConversationSession({ cwd, plan,  });

    try {
      expect(await session.handleUserMessage({ text: 'ゴールを相談したい' })).toMatchObject({ kind: 'reply' });

      expect(persona.trim().length).toBeGreaterThan(0);
      expect(instruction.trim().length).toBeGreaterThan(0);
      expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(persona.trim());
      expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(instruction.trim());
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
    } finally {
      await session.close();
    }
    expect(await session.handleUserMessage({ text: '終了後の呼び出し' })).toMatchObject({ kind: 'error' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('passes full permissions without a fixed tool allowlist to the mock provider', async () => {
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message: 'question', summary: null }), structuredOutput: { message: 'question', summary: null } });
    vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language: 'en' });
    const session = createManagerConversationSession({ cwd, plan,  });

    await session.handleUserMessage({ text: 'ソースを読み、既存のゴールを確認してください' });

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
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, { language }),

    });
    try {
      await session.handleUserMessage({ text: '次の作業を判断してください' });
      const prompt = setup.mock.calls[0]![0].systemPrompt;
      expect(prompt).toContain(`fixture-${language}-policies`);
      expect(prompt).toContain(`fixture-${language}-knowledge`);
    } finally {
      await session.close();
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
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),

    });
    try {
      expect((await session.handleUserMessage({ text: 'workflowを選んでください' })).kind).toBe('reply');
      expect(`${setup.mock.calls[0]![0].systemPrompt}\n${call.mock.calls[0]![0]}`)
        .toContain('fixture-fallback-workflow');
    } finally {
      await session.close();
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

  it('preserves patrol intervals through project and global load/save and resolves project precedence', () => {
    const globalDirectory = join(cwd, 'patrol-global');
    mkdirSync(globalDirectory); vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    writeFileSync(join(globalDirectory, 'config.yaml'), 'provider: mock\nmanager:\n  patrol_interval: 900\n');
    invalidateGlobalConfigCache();
    saveGlobalConfig(loadGlobalConfig()); invalidateGlobalConfigCache();
    expect(loadGlobalConfig().manager?.patrolInterval).toBe(900);
    expect(parse(readFileSync(join(globalDirectory, 'config.yaml'), 'utf8'))).toMatchObject({ manager: { patrol_interval: 900 } });
    const projectPath = join(cwd, '.takt', 'config.yaml');
    writeFileSync(projectPath, 'provider: mock\nmanager:\n  patrol_interval: 60\n');
    saveProjectConfig(cwd, loadProjectConfig(cwd));
    expect(loadProjectConfig(cwd).manager?.patrolInterval).toBe(60);
    expect(parse(readFileSync(projectPath, 'utf8'))).toMatchObject({ manager: { patrol_interval: 60 } });
    expect(resolveManagerConfig(cwd).patrolInterval).toBe(60);
    saveProjectConfig(cwd, { ...loadProjectConfig(cwd), manager: undefined });
    expect(resolveManagerConfig(cwd).patrolInterval).toBe(900);
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

  it.each([false, true])('starts Codex manager with full permissions and user MCP (extra server: %s)', async (hasAmbientServer) => {
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
    const session = createManagerConversationSession({
      cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: {
        [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node', args: ['unused-mcp.js'] },
        browser: { command: '/browser-mcp' },
      } } },
    });
    try {
      expect(await session.handleUserMessage({ text: '相談' })).toMatchObject({ kind: 'reply' });
      expect(codex.constructor).toHaveBeenCalledTimes(1);
      const sdkOptions = codex.constructor.mock.calls[0]![0] as CodexOptions;
      expect(sdkOptions.config?.mcp_servers).toMatchObject({
        [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node' }, browser: { command: '/browser-mcp' },
      });
      expect(codex.trust).toHaveBeenCalledOnce();
      expect(sdkOptions.config?.features).toMatchObject({ hooks: true });
      const definitions = (sdkOptions.config!.hooks as { PreToolUse: { matcher?: string; hooks: { command: string; timeout: number }[] }[] }).PreToolUse;
      expect(definitions.length).toBe(1);
      expect(definitions[0]!.hooks.length).toBe(1);
      expect(definitions[0]!.hooks[0]!.command.trim().length).toBeGreaterThan(0);
      const trustInput = codex.trust.mock.calls[0]![0];
      expect(trustInput.definition.command === definitions[0]!.hooks[0]!.command).toBe(true);
      expect(trustInput.definition.timeout).toBe(definitions[0]!.hooks[0]!.timeout);
      expect(trustInput.definition.matcher).toBe(definitions[0]!.matcher);
      expect(trustInput.executablePath).toBe(sdkOptions.codexPathOverride);
      const stateOverrides = sdkOptions.configOverrides?.filter((override) => override.startsWith('hooks.state='));
      expect(stateOverrides).toHaveLength(1);
      expect(stateOverrides![0]).toContain('/<session-flags>/config.toml:pre_tool_use:0:0');
      expect(stateOverrides![0]).toMatch(/"\/<session-flags>\/config\.toml:pre_tool_use:0:0"\s*=\s*\{\s*"?trusted_hash"?\s*=\s*"sha256:fixture-current"/u);
      expect(sdkOptions.configOverrides?.some((override) => override.startsWith('hooks.state.'))).toBe(false);
      const manager = (sdkOptions.config!.mcp_servers as Record<string, Record<string, unknown>>)[TAKT_MANAGER_MCP_SERVER_NAME]!;
      expect(manager.tools).toEqual(Object.fromEntries(TAKT_MCP_MANAGER_TOOL_NAMES.map((name) => [name, { approval_mode: 'approve' }])));
      expect(manager.default_tools_approval_mode).toBeUndefined();
      const browser = (sdkOptions.config!.mcp_servers as Record<string, Record<string, unknown>>).browser!;
      expect(browser.tools).toBeUndefined();
      expect(browser.default_tools_approval_mode).toBeUndefined();
      expect(codex.startThread.mock.calls[0]![0]).toMatchObject({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
      expect(codex.startThread.mock.calls[0]![0].networkAccessEnabled).toBeUndefined();
      expect(codex.startThread.mock.calls[0]![0].webSearchMode).toBeUndefined();
      expect(runCodexMcpList).not.toHaveBeenCalled();
    } finally { await session.close(); }
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(readFileSync(authPath, 'utf8')).toBe(auth);
  });

  it('returns a manager error without credentials when SDK stderr echoes the hook command', async () => {
    const codexHome = join(cwd, 'codex-home');
    mkdirSync(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('TAKT_CODEX_CLI_PATH', process.execPath);
    let command = '';
    codex.constructor.mockImplementationOnce((options: CodexOptions) => {
      const hooks = options.config!.hooks as { PreToolUse: { hooks: { command: string }[] }[] };
      command = hooks.PreToolUse[0]!.hooks[0]!.command;
    });
    codex.startThread.mockReturnValue({ runStreamed: async () => {
      throw new Error(`Codex Exec exited with code 1: fixture diagnostic ${command}`);
    } });
    const plan = createManagerConversationPlan(cwd, { provider: 'codex' });
    const session = createManagerConversationSession({ cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: {} } } });
    const onNotification = vi.fn();
    try {
      const result = await session.handleUserMessage({ text: '相談', onNotification });
      expect(result.kind).toBe('error');
      expect('message' in result && result.message.includes('fixture diagnostic')).toBe(true);
      expect(onNotification).not.toHaveBeenCalled();
      for (const name of [CODEX_TOOL_PERMISSION_ENDPOINT_ENV, CODEX_TOOL_PERMISSION_TOKEN_ENV]) {
        const secret = new RegExp(`${name}='([^']+)'`, 'u').exec(command)?.[1];
        expect(secret !== undefined).toBe(true);
        expect(JSON.stringify(result).includes(secret!)).toBe(false);
      }
    } finally { await session.close(); }
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

  it('uses the existing Claude full-permission conversion and includes user MCP', async () => {
    vi.mocked(callClaudeCustom).mockResolvedValue({
      persona: 'manager', status: 'done', timestamp: new Date(), content: JSON.stringify({ message: '確認', summary: null }),
    });
    const plan = createManagerConversationPlan(cwd, { provider: 'claude' });
    const servers = { browser: { type: 'stdio' as const, command: '/browser-mcp' } };
    const session = createManagerConversationSession({ cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: servers } } });
    try {
      expect((await session.handleUserMessage({ text: '確認' })).kind).toBe('reply');
      const options = buildSdkOptions(vi.mocked(callClaudeCustom).mock.calls[0]![3]);
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.mcpServers).toEqual(servers);
      expect(options.allowedTools).toBeUndefined();
    } finally { await session.close(); }
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
    const session = createManagerConversationSession({ cwd, plan });
    try { expect((await session.handleUserMessage({ text: '相談' })).kind).toBe('reply'); }
    finally { await session.close(); }
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
