import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import type { AgentResponse } from '../core/models/types.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerToolPermissionHandler } from '../features/manager/toolPermissionDecision.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { invalidateGlobalConfigCache, loadGlobalConfig, saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import * as providers from '../infra/providers/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from '../infra/providers/types.js';
import { executeIsolatedStructuredInternalAgent } from '../agents/agent-usecases.js';
import { MANAGER_ASSIGNMENT_ENV, type ManagerAssignmentIdentity } from '../features/manager/assignment.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { removeWorkspaceRepository } from '../infra/config/global/workspaceRegistry.js';

const doubles = vi.hoisted(() => ({ home: vi.fn<() => string>() }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()), homedir: doubles.home,
}));
vi.mock('../agents/agent-usecases.js', () => ({ executeIsolatedStructuredInternalAgent: vi.fn() }));

const workspaceId = '650e8400-e29b-41d4-a716-446655440001';
const response: AgentResponse = { persona: 'manager', status: 'done', content: '', timestamp: new Date('2026-10-20T00:00:00Z') };

class PermissionProvider implements Provider {
  supportsStructuredOutput = true;
  supportsNativeImageInput = false;
  supportedMcpTransports = new Set(['stdio'] as const);
  call = vi.fn<ProviderAgent['call']>().mockResolvedValue(response);
  getRuntimeInstructions(): string { return this.supportsStructuredOutput ? 'fixture runtime' : ''; }
  keepsAllowedToolWithoutEdit(): boolean { return false; }
  setup(_input: AgentSetup): ProviderAgent { return { call: this.call }; }
}

describe('manager read scope through the conversation provider and SDK permission hook', () => {
  let root: string;
  let repository: string;
  let secondRepository: string;
  let otherRepository: string;
  let configDirectory: string;
  let provider: PermissionProvider;

  function file(path: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture public text mentions .env\n');
    return path;
  }

  function workspace(repositoryDirectories: readonly string[]): void {
    const directory = join(configDirectory, 'workspaces', workspaceId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'workspace.json'), JSON.stringify({ id: workspaceId, name: 'fixture', repositoryDirectories }));
  }

  function createManager(options: { managerCwd?: string; toolCwd?: string; assignment?: ManagerAssignmentIdentity }) {
    const managerCwd = options.managerCwd ?? repository;
    const toolCwd = options.toolCwd ?? managerCwd;
    const plan = createManagerConversationPlan(managerCwd, { provider: 'claude-sdk', language: 'en' });
    if (plan.permissionJudge === undefined) throw new Error('Manager permission judge plan is missing');
    const onToolPermissionDecision = createManagerToolPermissionHandler({
      plan: plan.permissionJudge, provider: plan.ctx.providerType, cwd: managerCwd, configDirectory,
      owner: options.assignment ?? { kind: 'repository', repositoryDirectory: repository },
      instruction: 'Inspect repository files', abortSignal: new AbortController().signal, onDenial: vi.fn(),
    });
    const agent = plan.ctx.provider.setup({ name: 'manager' });
    return async (toolName: string, toolInput: unknown) => {
      let output: unknown;
      provider.call.mockImplementationOnce(async (_prompt: string, callOptions: ProviderCallOptions) => {
        const sdk = buildSdkOptions({ cwd: managerCwd, onToolPermissionDecision: callOptions.onToolPermissionDecision });
        const hook = sdk.hooks?.PreToolUse?.find(({ matcher }) => matcher === undefined)?.hooks[0];
        if (hook === undefined) throw new Error('SDK permission hook is missing');
        output = await hook({
          hook_event_name: 'PreToolUse', session_id: 'fixture-session', transcript_path: join(root, 'transcript'),
          cwd: toolCwd, tool_name: toolName, tool_input: toolInput, tool_use_id: 'fixture-tool',
        }, 'fixture-tool', { signal: new AbortController().signal });
        return response;
      });
      await agent.call('Inspect repository files', {
        cwd: managerCwd, onToolPermissionDecision, permissionMode: 'full',
        mcpServers: { [TAKT_MANAGER_MCP_SERVER_NAME]: {
          type: 'stdio', command: process.execPath,
          env: options.assignment === undefined ? {} : { [MANAGER_ASSIGNMENT_ENV]: JSON.stringify(options.assignment) },
        } },
      });
      return output;
    };
  }

  async function invoke(toolName: string, toolInput: unknown, options: { managerCwd?: string; toolCwd?: string } = {}) {
    return createManager(options)(toolName, toolInput);
  }

  function expectPassthrough(output: unknown): void {
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  }

  function expectJudged(output: unknown): void {
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
    expect(output).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fixture judged denial',
    } });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    invalidateGlobalConfigCache();
    const temporaryDirectory = join(process.cwd(), '.tmp');
    mkdirSync(temporaryDirectory, { recursive: true });
    root = mkdtempSync(join(temporaryDirectory, 'manager-read-scope-'));
    repository = join(root, 'repo');
    secondRepository = join(root, 'second');
    otherRepository = join(root, 'repo-other');
    configDirectory = process.env.TAKT_CONFIG_DIR!;
    doubles.home.mockReturnValue(join(root, 'home'));
    for (const directory of [repository, secondRepository, otherRepository]) {
      mkdirSync(join(directory, '.takt'), { recursive: true });
      writeFileSync(join(directory, '.takt', 'config.yaml'), 'provider: claude-sdk\nlanguage: en\n');
      file(join(directory, 'src', 'main.ts'));
    }
    provider = new PermissionProvider();
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue({
      ...response, persona: 'manager-permission-judge', structuredOutput: { decision: 'deny', reason: 'fixture judged denial' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('allows a normalized absolute file path in another assigned repository without a judge', async () => {
    workspace([repository, secondRepository]);
    expectPassthrough(await invoke('Read', { file_path: `${secondRepository}/src/../src/main.ts` }, { toolCwd: repository }));
  });

  it('allows a relative file path resolved from the actual tool cwd', async () => {
    workspace([repository, secondRepository]);
    expectPassthrough(await invoke('Read', { file_path: '../src/main.ts' }, { toolCwd: join(secondRepository, 'src') }));
  });

  it('allows normal reads when the repository has no workspace', async () => {
    expectPassthrough(await invoke('Read', { file_path: join(repository, 'src', 'main.ts') }));
  });

  it.each(['removed', 'remaining'] as const)('uses the current workspace on the next turn for the %s repository', async (target) => {
    workspace([repository, secondRepository]);
    const invokeManager = createManager({ assignment: { kind: 'workspace', workspaceId } });
    const toolInput = { file_path: join(target === 'removed' ? repository : secondRepository, 'src', 'main.ts') };
    expectPassthrough(await invokeManager('Read', toolInput));

    await removeWorkspaceRepository(configDirectory, workspaceId, repository);

    const output = await invokeManager('Read', toolInput);
    if (target === 'removed') expectJudged(output);
    else expectPassthrough(output);
  });

  it('judges a symlink that resolves outside the assigned repositories', async () => {
    workspace([repository]);
    symlinkSync(otherRepository, join(repository, 'link'), 'dir');
    expectJudged(await invoke('Read', { file_path: join(repository, 'link', 'src', 'main.ts') }));
  });

  it.each(['relative Read', 'absolute Read', 'home Read', 'Glob', 'Grep file', 'Grep directory'])(
    'checks the actual target of a symlink followed by a parent reference for %s', async (kind) => {
      workspace([repository]);
      doubles.home.mockReturnValue(repository);
      const assignedFile = file(join(repository, '.aws', 'credentials'));
      const outsideFile = file(join(otherRepository, '.aws', 'credentials'));
      writeFileSync(assignedFile, 'assigned fixture');
      writeFileSync(outsideFile, 'outside fixture');
      const relativeFile = 'link/../.aws/credentials';
      const toolName = kind.endsWith('Read') ? 'Read' : kind === 'Glob' ? 'Glob' : 'Grep';
      const toolInput = kind === 'relative Read' ? { file_path: relativeFile }
        : kind === 'absolute Read' ? { file_path: `${repository}/${relativeFile}` }
        : kind === 'home Read' ? { file_path: `~/${relativeFile}` }
        : { path: kind === 'Grep file' ? relativeFile : 'link/../.aws', pattern: kind === 'Glob' ? '*' : 'fixture' };
      const link = join(repository, 'link');

      symlinkSync(join(repository, '.aws'), link, 'dir');
      expect(readFileSync(`${repository}/${relativeFile}`, 'utf8')).toBe('assigned fixture');
      expectPassthrough(await invoke(toolName, toolInput));

      unlinkSync(link);
      symlinkSync(join(otherRepository, '.aws'), link, 'dir');
      expect(readFileSync(`${repository}/${relativeFile}`, 'utf8')).toBe('outside fixture');
      expectJudged(await invoke(toolName, toolInput));
    },
  );

  it('judges a sibling repository with the same path prefix', async () => {
    expectJudged(await invoke('Read', { file_path: join(otherRepository, 'src', 'main.ts') }));
  });

  it('does not enlarge assignment using tool cwd or tool arguments', async () => {
    workspace([repository]);
    expectJudged(await invoke('Read', {
      file_path: 'src/main.ts', repositoryDirectories: [otherRepository], readOnlyHint: true,
    }, { toolCwd: otherRepository }));
  });

  it.each(['.ssh/config', '.aws/credentials'])('judges home-expanded reads outside assignment: %s', async (name) => {
    file(join(root, 'home', name));
    expectJudged(await invoke('Read', { file_path: `~/${name}` }));
  });

  it('allows home expansion when the resolved file is assigned', async () => {
    doubles.home.mockReturnValue(repository);
    expectPassthrough(await invoke('Read', { file_path: '~/src/main.ts' }));
  });

  it.each([
    '.env', '.env.production', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    'server.key', 'server.pem', 'server.crt', 'server.cer', 'server.p12', 'server.pfx',
  ])('judges a default sensitive file inside assignment: %s', async (name) => {
    expectJudged(await invoke('Read', { file_path: file(join(repository, 'config', name)) }));
  });

  it('judges a public-looking symlink to a sensitive file', async () => {
    const sensitive = file(join(repository, 'config', '.env'));
    symlinkSync(sensitive, join(repository, 'src', 'public.txt'));
    expectJudged(await invoke('Read', { file_path: join(repository, 'src', 'public.txt') }));
  });

  it('judges a nonexistent file instead of allowing its lexical path', async () => {
    expectJudged(await invoke('Read', { file_path: join(repository, 'missing.txt') }));
  });

  it.each<[string, unknown]>([
    ['Read', null], ['Read', { file_path: '' }], ['Read', { file_path: 7 }],
    ['Glob', { pattern: 7 }], ['Glob', { pattern: '**/*', path: null }],
    ['Grep', { pattern: 'fixture', path: 7 }], ['Grep', {}],
  ])('judges malformed %s arguments with a resolved assignment: %j', async (toolName, toolInput) => {
    expectJudged(await invoke(toolName, toolInput));
  });

  it('judges an unreadable file instead of allowing its resolved path', async () => {
    const path = file(join(repository, 'unreadable.txt'));
    chmodSync(path, 0o000);
    try {
      expect(() => accessSync(path, constants.R_OK)).toThrow();
      expectJudged(await invoke('Read', { file_path: path }));
    } finally { chmodSync(path, 0o600); }
  });

  it('allows a content search for .env in an ordinary file', async () => {
    const path = file(join(repository, 'src', 'public.txt'));
    expectPassthrough(await invoke('Grep', { path, pattern: '.env' }));
  });

  it.each(['Glob', 'Grep'])('allows %s over a directory containing only ordinary files', async (toolName) => {
    expectPassthrough(await invoke(toolName, {
      path: join(repository, 'src'), pattern: toolName === 'Glob' ? '**/*.ts' : 'fixture',
    }));
  });

  it('judges Glob patterns that select sensitive files below an ordinary root', async () => {
    file(join(repository, 'config', '.env.production'));
    expectJudged(await invoke('Glob', { path: repository, pattern: '**/.env*' }));
  });

  it('judges Grep file filters that include sensitive files', async () => {
    file(join(repository, 'config', '.env.production'));
    expectJudged(await invoke('Grep', { path: repository, pattern: 'fixture', glob: '**/.env*' }));
  });

  it.each(['Glob', 'Grep'])('judges %s directory scans whose targets include a certificate', async (toolName) => {
    file(join(repository, 'config', 'server.pem'));
    expectJudged(await invoke(toolName, { path: repository, pattern: toolName === 'Glob' ? '**/*' : 'fixture' }));
  });

  it.each(['Glob', 'Grep'])('checks the actual cwd when %s omits its search path', async (toolName) => {
    expectJudged(await invoke(toolName, { pattern: toolName === 'Glob' ? '**/*' : 'fixture' }, { toolCwd: otherRepository }));
  });

  it.each(['Glob', 'Grep'])('allows %s with an omitted path in an ordinary assigned directory', async (toolName) => {
    expectPassthrough(await invoke(toolName, { pattern: toolName === 'Glob' ? '**/*.ts' : 'fixture' }, { toolCwd: join(repository, 'src') }));
  });

  it.each(['Glob', 'Grep'])('judges %s when its search range includes a symlink outside assignment', async (toolName) => {
    symlinkSync(otherRepository, join(repository, 'src', 'link'), 'dir');
    expectJudged(await invoke(toolName, { path: join(repository, 'src'), pattern: toolName === 'Glob' ? '**/*' : 'fixture' }));
  });

  it.each(['Glob', 'Grep'])('preserves %s filters using child symlink names while scanning their targets', async (toolName) => {
    const target = join(repository, 'target');
    file(join(target, 'nested', 'public.txt'));
    file(join(target, 'nested', 'server.pem'));
    symlinkSync(target, join(repository, 'src', 'link'), 'dir');
    for (const [filter, judged] of [['link/**/*.txt', false], ['link/**/*.pem', true], ['target/**/*.pem', false]] as const) {
      vi.mocked(executeIsolatedStructuredInternalAgent).mockClear();
      const output = await invoke(toolName, {
        path: join(repository, 'src'),
        ...(toolName === 'Glob' ? { pattern: filter } : { pattern: 'fixture', glob: filter }),
      });
      if (judged) expectJudged(output);
      else expectPassthrough(output);
    }
  });

  it.each(['Glob', 'Grep'])('preserves configured sensitive paths beneath child symlink names for %s', async (toolName) => {
    const target = join(repository, 'target');
    file(join(target, 'nested', 'credentials.json'));
    symlinkSync(target, join(repository, 'src', 'link'), 'dir');
    const toolInput = { path: join(repository, 'src'), pattern: toolName === 'Glob' ? '**/*' : 'fixture' };
    expectPassthrough(await invoke(toolName, toolInput));

    writeFileSync(join(repository, '.takt', 'config.yaml'), stringify({
      provider: 'claude-sdk', manager: { sensitive_paths: ['src/link/nested/credentials.json'] },
    }));
    expectJudged(await invoke(toolName, toolInput));
  });

  it('judges Glob patterns escaping the supplied search root', async () => {
    expectJudged(await invoke('Glob', { path: repository, pattern: '../repo-other/**/*.ts' }));
  });

  it('judges reads when workspace resolution fails', async () => {
    workspace([repository]);
    writeFileSync(join(configDirectory, 'workspaces', workspaceId, 'workspace.json'), '{');
    expectJudged(await invoke('Read', { file_path: join(repository, 'src', 'main.ts') }));
  });

  it('does not treat an empty workspace base as an assigned repository', async () => {
    workspace([]);
    const managerCwd = join(configDirectory, 'workspaces', workspaceId);
    expectJudged(await invoke('Read', { file_path: join(managerCwd, 'workspace.json') }, { managerCwd }));
  });

  it.each(['global', 'project'] as const)('preserves additional sensitive paths through %s YAML load and save into hook decisions', async (scope) => {
    const directory = scope === 'global' ? configDirectory : join(repository, '.takt');
    const path = join(directory, 'config.yaml');
    writeFileSync(path, stringify({ provider: 'claude-sdk', manager: { auto_run: false, sensitive_paths: ['private'] } }));
    invalidateGlobalConfigCache();
    if (scope === 'global') saveGlobalConfig(loadGlobalConfig());
    else saveProjectConfig(repository, loadProjectConfig(repository));
    invalidateGlobalConfigCache();

    expect(parse(readFileSync(path, 'utf8'))).toMatchObject({ manager: { auto_run: false, sensitive_paths: ['private'] } });
    expectJudged(await invoke('Read', { file_path: file(join(repository, 'private', 'credentials.json')) }));
  });

  it.each(['global', 'project'] as const)('applies a relative sensitive path from %s YAML to the second assigned repository', async (scope) => {
    workspace([repository, secondRepository]);
    const filePath = file(join(secondRepository, 'config', 'credentials.json'));
    const toolInput = { file_path: filePath };
    expectPassthrough(await invoke('Read', toolInput));

    const directory = scope === 'global' ? configDirectory : join(repository, '.takt');
    writeFileSync(join(directory, 'config.yaml'), stringify({
      provider: 'claude-sdk', manager: { sensitive_paths: ['config/credentials.json'] },
    }));
    invalidateGlobalConfigCache();

    expectJudged(await invoke('Read', toolInput));
  });

  it.each(['absolute', 'home'] as const)('applies a %s sensitive path from project YAML to an assigned file', async (format) => {
    doubles.home.mockReturnValue(repository);
    const filePath = file(join(repository, 'config', 'credentials.json'));
    const toolInput = { file_path: filePath };
    expectPassthrough(await invoke('Read', toolInput));

    writeFileSync(join(repository, '.takt', 'config.yaml'), stringify({
      provider: 'claude-sdk', manager: { sensitive_paths: [format === 'absolute' ? filePath : '~/config/credentials.json'] },
    }));

    expectJudged(await invoke('Read', toolInput));
  });

  it('keeps both configuration layers and defaults effective in hook decisions', async () => {
    writeFileSync(join(configDirectory, 'config.yaml'), stringify({ manager: { sensitive_paths: ['global-private'] } }));
    writeFileSync(join(repository, '.takt', 'config.yaml'), stringify({ provider: 'claude-sdk', manager: { sensitive_paths: ['project-private'] } }));
    invalidateGlobalConfigCache();
    for (const name of ['global-private', 'project-private', '.env']) {
      vi.mocked(executeIsolatedStructuredInternalAgent).mockClear();
      expectJudged(await invoke('Read', { file_path: file(join(repository, name)) }));
    }
  });

  it('keeps default sensitive files judged when both configured lists are empty', async () => {
    writeFileSync(join(configDirectory, 'config.yaml'), stringify({ manager: { sensitive_paths: [] } }));
    writeFileSync(join(repository, '.takt', 'config.yaml'), stringify({ provider: 'claude-sdk', manager: { sensitive_paths: [] } }));
    invalidateGlobalConfigCache();
    expectJudged(await invoke('Read', { file_path: file(join(repository, '.env')) }));
  });

  it('does not mistake a sibling of a configured sensitive directory for that directory', async () => {
    writeFileSync(join(repository, '.takt', 'config.yaml'), stringify({ provider: 'claude-sdk', manager: { sensitive_paths: ['private'] } }));
    expectPassthrough(await invoke('Read', { file_path: file(join(repository, 'private-public', 'readme.txt')) }));
  });

  it('preserves provider capabilities, prototype methods, call options and responses', async () => {
    const plan = createManagerConversationPlan(repository, { provider: 'claude-sdk', language: 'en' });
    expect(plan.ctx.provider.supportedMcpTransports?.has('stdio')).toBe(true);
    expect(plan.ctx.provider.getRuntimeInstructions()).toBe('fixture runtime');
    const options: ProviderCallOptions = { cwd: repository, sessionId: 'existing-session', model: 'fixture-model', permissionMode: 'full' };
    expect(await plan.ctx.provider.setup({ name: 'manager' }).call('fixture prompt', options)).toEqual(response);
    expect(provider.call).toHaveBeenCalledWith('fixture prompt', options);
  });
});
