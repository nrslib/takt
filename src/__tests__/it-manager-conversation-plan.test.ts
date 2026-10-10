import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import * as providers from '../infra/providers/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import { makeProvider } from './test-helpers.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { runCodexMcpList } from '../infra/codex/mcp-list.js';
import type { CodexOptions } from '@openai/codex-sdk';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';
import { parse } from 'yaml';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import { invalidateGlobalConfigCache, loadGlobalConfig, saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { resolveManagerConfig } from '../infra/config/managerConfig.js';

const codex = vi.hoisted(() => ({ constructor: vi.fn(), startThread: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: CodexOptions) { codex.constructor(options); }
  startThread = codex.startThread;
} }));
vi.mock('../infra/codex/mcp-list.js', () => ({ runCodexMcpList: vi.fn() }));

const toolNames = ['takt_create_goal', 'takt_list_goals', 'takt_get_goal', 'takt_list_tasks', 'takt_get_run', 'takt_enqueue_goal_task', 'takt_list_workflows', 'takt_merge_goal_task', 'takt_complete_goal', 'takt_check_goal_completion', 'takt_get_goal_diff', 'takt_get_goal_history', 'takt_get_goal_relation', 'takt_ask_goal_question', 'takt_list_goal_questions', 'takt_get_goal_question', 'takt_withdraw_goal_question', 'takt_notify_goal', 'takt_record_goal_decision', 'takt_list_goal_decisions', 'takt_list_goal_operations'];
const managerTools = ['Read', ...toolNames.map((name) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`)];

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

  it('preserves nonpermission runtime options while imposing manager restrictions', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: en\n');
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
      'version: 1', 'provider:', '  profiles:', '    assistant-profile:',
      '      provider: claude-sdk', '      model: runtime-manager',
      '      options:', '        effort: high',
      '  defaults:', '    profile: assistant-profile',
      '  targets:', '    internal_agents:', '      assistant:', '        profile: assistant-profile',
    ].join('\n'));
    const expected = resolveAssistantProviderModel(cwd);

    const plan = createManagerConversationPlan(cwd, { language: 'en' });

    expect(plan.ctx.providerType).toBe(expected.provider);
    expect(plan.ctx.model).toBe(expected.model);
    expect(expected.providerOptions?.claude?.effort).toBe('high');
    expect(plan.ctx.providerOptions?.claude?.effort).toBe(expected.providerOptions?.claude?.effort);
  });

  it.each([
    { language: 'ja', mainMerge: 'auto' }, { language: 'ja', mainMerge: 'approve' },
    { language: 'en', mainMerge: 'auto' }, { language: 'en', mainMerge: 'approve' },
  ] as const)('loads the $language manager assets and repository $mainMerge permission into the actual provider prompt', async ({ language, mainMerge }) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nmanager:\n  main_merge: ${mainMerge}\n  auto_run: false\n`);
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
    const session = createManagerConversationSession({ cwd, plan, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() } });

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
      const prompt = setup.mock.calls[0]?.[0].systemPrompt;
      for (const term of ['operationName', 'takt_record_goal_decision', 'takt_list_goal_decisions', 'takt_list_goal_operations',
        'supersedesDecisionId', 'acceptanceCriteriaVersion', 'evidenceRefs', '64 KiB']) expect(prompt).toContain(term);
      for (const tool of ['takt_merge_goal_task', 'takt_complete_goal', 'takt_check_goal_completion', 'takt_get_goal_diff', 'takt_get_goal_history', 'takt_get_goal_relation', 'takt_ask_goal_question', 'takt_list_goal_questions', 'takt_get_goal_question', 'takt_withdraw_goal_question', 'takt_notify_goal']) {
        expect(prompt).toContain(tool);
      }
      const settings = prompt?.split('\n').filter((line) => line.startsWith('Repository manager.main_merge: '));
      expect(settings).toEqual([`Repository manager.main_merge: ${JSON.stringify(mainMerge)}`]);
      expect(call).toHaveBeenCalledTimes(1);
      expect(plan.strategy.allowedTools).toContain(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_record_goal_decision`);
    } finally {
      await session.close();
    }
    expect(await session.handleUserMessage({ text: '終了後の呼び出し' })).toMatchObject({ kind: 'error' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('passes file reading and goal operations without process control tools to the mock provider', async () => {
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message: 'question', summary: null }), structuredOutput: { message: 'question', summary: null } });
    vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language: 'en' });
    const confirmation = createGoalConfirmation(cwd);
    const session = createManagerConversationSession({ cwd, plan, confirmation, mcpClient: { callTool: vi.fn() } });

    await session.handleUserMessage({ text: 'ソースを読み、既存のゴールを確認してください' });

    expect(call).toHaveBeenCalledTimes(1);
    const options = call.mock.calls[0]![1];
    expect([...(options.allowedTools ?? [])].sort()).toEqual([...managerTools].sort());
    expect(options.permissionMode).toBe('readonly');
    expect(options.mcpOnlySideEffects).toEqual(options.allowedTools);
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
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
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
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
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

  it('rejects a provider that cannot enforce the requested restrictions before setup or conversation', () => {
    const setup = vi.fn();
    const provider = makeProvider({
      supportsStructuredOutput: true, supportedMcpTransports: new Set(['stdio']),
      supportsMcpOnlySideEffects: false,
      supportsStrictToolAllowlist: true,
      supportsStrictMcpConfig: false, supportsPermissionControls: () => false, setup,
    });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);

    expect(() => createManagerConversationPlan(cwd, { language: 'en' })).toThrow();
    expect(setup).not.toHaveBeenCalled();
  });

  it.each([false, true])('starts Codex manager with ambient MCP isolation (extra server: %s)', async (hasAmbientServer) => {
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
    const provider = providers.getProvider('codex');
    vi.mocked(runCodexMcpList).mockResolvedValue(JSON.stringify(hasAmbientServer ? [{ name: 'unrelated', enabled: true }] : []));
    codex.startThread.mockReturnValue({ runStreamed: async () => ({ events: (async function* () {
      yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ message: 'question', summary: null }) } };
      yield { type: 'turn.completed' };
    })() }) });
    expect(provider.supportsMcpOnlySideEffects).toBe(true);
    const plan = createManagerConversationPlan(cwd, { provider: 'codex' });
    const session = createManagerConversationSession({
      cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: {
        [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node', args: ['unused-mcp.js'] },
      } } }, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    });
    try {
      expect(await session.handleUserMessage({ text: '相談' })).toMatchObject({ kind: 'reply' });
      expect(codex.constructor).toHaveBeenCalledTimes(1);
      const sdkOptions = codex.constructor.mock.calls[0]![0] as CodexOptions;
      expect(sdkOptions.configOverrides).toContain(`mcp_servers.${TAKT_MANAGER_MCP_SERVER_NAME}.command="node"`);
      expect(sdkOptions.configOverrides?.includes('mcp_servers.unrelated.enabled=false')).toBe(hasAmbientServer);
      expect(vi.mocked(runCodexMcpList).mock.calls[0]![0]).toMatchObject({ cwd, env: { CODEX_HOME: codexHome } });
    } finally { await session.close(); }
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(readFileSync(authPath, 'utf8')).toBe(auth);
  });

  it.each(['claude', 'codex', 'opencode'] as const)('accepts %s with verified MCP-only side effect capabilities', (provider) => {
    const plan = createManagerConversationPlan(cwd, { provider, model: 'probe/probe' });
    expect(plan.ctx.providerType).toBe(provider);
    expect(plan.ctx.model).toBe('probe/probe');
    expect([...plan.strategy.allowedTools].sort()).toEqual([...managerTools].sort());
  });

  it('rejects permission-widening provider options', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nprovider_options:\n  claude:\n    allowed_tools: [Read, Bash]\n');
    expect(() => createManagerConversationPlan(cwd, {})).toThrow('conflict');
  });

  it.each([
    'network_access: true',
    'permission_control: codex',
    'permission_control: codex\n    config_profile: unrestricted',
  ])('rejects Codex options that can bypass manager restrictions: %s', (options) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: codex\nprovider_options:\n  codex:\n    ${options}\n`);
    const setup = vi.spyOn(providers.getProvider('codex'), 'setup');
    expect(() => createManagerConversationPlan(cwd, {})).toThrow();
    expect(setup).not.toHaveBeenCalled();
    expect(codex.constructor).not.toHaveBeenCalled();
  });

  it('rejects a capability override that exposes shell commands', () => {
    mkdirSync(join(cwd, '.takt', 'provider-options'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'provider-options', 'manager.yaml'), 'claude:\n  allowed_tools: [Read, Bash]\n');
    expect(() => createManagerConversationPlan(cwd, {})).toThrow('do not preserve');
  });
});
