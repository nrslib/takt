import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/types.js';
import type { ProviderCallOptions, ProviderType } from '../infra/providers/types.js';
import type { ToolPermissionDecision, ToolPermissionDecisionHandler } from '../infra/claude/types.js';
import type { Goal, GoalQuestionInput } from '../infra/goals/schema.js';
import { answerInquiry, createInquiry, isGoalApprovalUsable } from '../infra/goals/inquiry.js';
import type { CompiledProviderEnvironment } from '../infra/config/runtime-provider/environment.js';
import { executeIsolatedStructuredInternalAgent } from '../agents/agent-usecases.js';
import { runAgent } from '../agents/runner.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import * as permissionInquiry from '../features/manager/toolPermissionInquiry.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { parseCodexToolPermissionInput, toCodexToolPermissionOutput } from '../infra/codex/tool-permission-hook-protocol.js';
import { validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
const doubles = vi.hoisted(() => ({
  call: vi.fn(), provider: vi.fn(), assistant: vi.fn(), facet: vi.fn(), compile: vi.fn(),
  store: vi.fn(), update: vi.fn(), notificationOptions: vi.fn(), savedNotification: vi.fn(), slack: vi.fn(),
  inquiryApproval: vi.fn(),
}));
vi.mock('../agents/agent-usecases.js', () => ({ executeIsolatedStructuredInternalAgent: vi.fn() }));
vi.mock('../features/manager/scopedPermissionStorage.js', () => ({ readScopedPermissions: async () => ({ ok: true, files: [] }) }));
vi.mock('../infra/goals/git-command.js', () => ({ resolveGoalBranchSha: async () => 'a'.repeat(40) }));
vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../infra/providers/index.js', () => ({ getProvider: doubles.provider }));
vi.mock('../features/interactive/assistantConfig.js', () => ({ resolveAssistantProviderModel: doubles.assistant }));
vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (_cwd: string, key: string) => key === 'language' ? 'ja' : 1,
  resolveNonWorkflowProviderOptions: () => ({}),
}));
vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (_cwd: string, key: string) => key === 'language' ? 'ja' : 1,
}));
vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/fixture/global', getProjectConfigDir: (cwd: string) => `${cwd}/.takt`,
}));
vi.mock('../infra/config/runtime-provider/invocation.js', () => ({
  resolveInvocationRuntimeProviderFileWithOrigins: () => ({ runtimeFile: {
    version: 1, provider: { profiles: { fallback: { provider: 'codex', model: 'runtime-default' } }, defaults: { profile: 'fallback' } },
    mcp: { servers: { external: { type: 'stdio', command: '/fixture/external-mcp' } }, defaults: { servers: ['external'] } },
  } }),
}));
vi.mock('../infra/config/runtime-provider/environment.js', () => ({ compileProviderEnvironment: doubles.compile }));
vi.mock('../infra/config/runtime-provider/legacy-signals.js', () => ({ collectProjectLegacyProviderSignals: () => [] }));
vi.mock('../infra/config/runtime-provider/resolution-context.js', () => ({ createRuntimeProviderResolutionContext: () => ({}) }));
vi.mock('../infra/config/runtime-provider/environment-options.js', () => ({
  applyDeepSeekEnvironmentOptions: (_cwd: string, env: CompiledProviderEnvironment) => env,
}));
vi.mock('../infra/config/loaders/resource-resolver.js', () => ({
  resolveFacetByName: doubles.facet,
  resolveFacetByNameWithSource: () => ({ path: '/fixture/instruction.md', content: 'instruction' }),
  resolveRefToContent: () => 'fixture instruction',
}));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: () => ({ mainMerge: 'approve', sensitivePaths: [] }) }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(directory: string) { doubles.store(directory); }
  update = doubles.update; get = async (id: string) => structuredClone(goal.id === id ? goal : { ...goalRecord(), id });
} }));
vi.mock('../infra/goals/standalone-inquiries.js', () => ({ StandaloneInquiryStore: class {
  getOrCreateApproval = doubles.inquiryApproval; list = async () => [];
} }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = () => []; } }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: doubles.notificationOptions, sendSavedGoalNotifications: doubles.savedNotification,
}));
vi.mock('../shared/utils/slackWebhook.js', () => ({ sendSlackNotification: doubles.slack }));
vi.mock('../infra/providers/mcp/index.js', () => ({ createMcpAdapter: () => ({
  validate: () => {}, prepare: async () => ({ dispose: async () => {} }),
}) }));

const cwd = '/fixture/manager';
const toolCwd = '/fixture/actual-tool';
const humanInstruction = '依存関係を調べて報告してください';
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const webhook = 'https://example.test/manager-notification';
const inquiryId = '650e8400-e29b-41d4-a716-446655440001';
type DecisionOptions = ProviderCallOptions & { onToolPermissionDecision?: ToolPermissionDecisionHandler };
type TurnOptions = Pick<ManagerTurnInput, 'goal' | 'onNotification' | 'onDenial'> & {
  text: string; abortSignal?: AbortSignal; sessionId?: string;
};
async function executeTurn(executor: ReturnType<typeof createManagerTurnExecutor>, options: TurnOptions) {
  return executor.execute({ prompt: options.text, instruction: options.text, sessionId: options.sessionId,
    abortSignal: options.abortSignal ?? new AbortController().signal, assignment: { kind: 'repository', repositoryDirectory: cwd },
    configDirectory: getGlobalConfigDir(), goal: options.goal, onNotification: options.onNotification, onDenial: options.onDenial });
}
let goal: Goal;
let environment: CompiledProviderEnvironment;

function reply(): AgentResponse {
  return { persona: 'manager', status: 'done', content: '', structuredOutput: { message: '調査を続けます', summary: null },
    timestamp: new Date('2026-10-17T00:00:00Z'), sessionId: 'manager-conversation-session' };
}
function judgment(output: unknown, content = ''): AgentResponse {
  return { persona: 'manager-permission-judge', status: 'done', content, structuredOutput: output as AgentResponse['structuredOutput'],
    timestamp: new Date('2026-10-17T00:00:00Z') };
}
function createExecutor(provider: ProviderType = 'claude-sdk', language: 'ja' | 'en' = 'ja') {
  doubles.assistant.mockReturnValue({ provider, model: 'manager-model', runtimeManaged: true, providerOptions: { claude: { effort: 'high' } } });
  const plan = createManagerConversationPlan(cwd, { language });
  return createManagerTurnExecutor(cwd, plan);
}
function request(toolName = 'Bash', toolInput: unknown = { command: 'pwd' }, abortSignal?: AbortSignal) {
  return { toolName, toolInput, cwd: toolCwd, abortSignal };
}
function handler(options: DecisionOptions): ToolPermissionDecisionHandler {
  expect(options.onToolPermissionDecision, 'manager は対応 provider の各ターンに判断 handler を渡す').toBeTypeOf('function');
  return options.onToolPermissionDecision!;
}
async function decide(toolName: string, toolInput: unknown = {}, language: 'ja' | 'en' = 'ja', provider: ProviderType = 'claude-sdk') {
  const session = createExecutor(provider, language);
  let decision: ToolPermissionDecision | undefined;
  doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
    decision = await handler(options)(request(toolName, toolInput));
    return reply();
  });
  {
    const result = await executeTurn(session, { text: humanInstruction });
    expect(result.summary, JSON.stringify(result)).toBeNull();
    expect(decision).toBeDefined();
    return decision!;
  }
}
function expectDenial(decision: ToolPermissionDecision): void {
  expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/\S/u) });
}

beforeEach(() => {
  vi.resetAllMocks();
  goal = { ...goalRecord(), constraints: ['外部への送信は禁止'] };
  environment = {
    provider: 'codex', providerSource: 'global', model: 'runtime-default', modelSource: 'global',
    providerOptions: { codex: { networkAccess: true } }, permissionMode: undefined,
    personaProviders: undefined, providerRouting: undefined, autoRouting: undefined,
    tagConflictPolicy: 'fail-fast', internalAgents: undefined, providerLadders: undefined,
  };
  doubles.compile.mockImplementation(() => environment);
  doubles.provider.mockReturnValue(makeProvider({ supportsStructuredOutput: true, supportsIsolatedStructuredExecution: true,
    supportedMcpTransports: new Set(['stdio']), setup: () => ({ call: doubles.call }) }));
  doubles.call.mockResolvedValue(reply());
  doubles.facet.mockImplementation((name: string, category: string, context: { lang: string }) => `${context.lang}:${category}:${name}:fixture-content`);
  doubles.inquiryApproval.mockImplementation(async (input: GoalQuestionInput) => ({ ...createInquiry(input), id: inquiryId }));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(goal); return goal;
  });
  doubles.notificationOptions.mockReturnValue({ policy, webhookUrl: webhook, mainMerge: 'approve' });
  vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({ decision: 'allow', reason: null }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('manager tool permission classification', () => {
  it.each(['ToolSearch'])('allows only the exact built-in %s without a judge', async (name) => {
    expect(await decide(name)).toEqual({ decision: 'allow' });
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it.each(TAKT_MCP_MANAGER_TOOL_NAMES)('allows the listed manager MCP full name for %s without a judge', async (name) => {
    expect(await decide(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`)).toEqual({ decision: 'allow' });
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it.each([
    'UnknownTool', 'ReadFile', 'read', 'ReadExtra', 'mcp__external__takt_get_goal',
    `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__get_unknown`,
    `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}_extra__takt_get_goal`,
    'mcp__external__get_records', 'mcp__external__list_records',
  ])('sends unknown or similar name %s to the judge even with a read-only hint', async (name) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({ decision: 'deny', reason: 'fixture rejection' }));
    expect(await decide(name, { readOnlyHint: true })).toEqual({ decision: 'deny', reason: 'fixture rejection' });
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  it('judges each Bash call even when both commands look read-only', async () => {
    const session = createExecutor();
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      for (let index = 0; index < 2; index++) expect(await handler(options)(request())).toEqual({ decision: 'allow' });
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction })).summary).toBeNull();
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledTimes(2);
    }
  });
  it.each(['Task', 'Agent'])('always denies %s with a reason without invoking the judge', async (name) => {
    expectDenial(await decide(name));
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it.each([
    'npm exec -- codex exec', 'npm exec --package=@openai/codex -- codex exec',
    'npm exec --package @openai/codex -- codex exec',
    'npm exec --yes --package=@openai/codex -- codex exec',
    'pnpm dlx --package @openai/codex codex', 'yarn dlx --package=@openai/codex codex',
    'npm exec -- codex exec; npm test', 'npm test; pnpm exec codex',
    'pnpm exec codex', 'pnpm dlx codex', 'yarn dlx codex', 'npx claude', 'bunx codex',
    "npm exec -- 'co'dex exec", 'pnpm exec co"de"x', 'yarn dlx co\\dex',
    "bash -c 'npm exec -- codex exec'",
  ])('denies an agent launched through a package runner without a judge: %s', async (command) => {
    expectDenial(await decide('Bash', { command }));
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it.each([
    "printf '%s' 'npm exec -- codex exec'", '# pnpm dlx codex',
    "cat <<'EOF'\nyarn dlx codex\nEOF", "printf 'npm exec -- codex exec",
    'npm exec --package=codex -- printf codex', 'npm exec --package codex -- printf codex',
    'pnpm exec printf codex', 'pnpm dlx eslint', 'yarn dlx eslint',
    'npm run inspect', 'npm test', 'npm install', 'npm exec', 'pnpm exec', 'yarn dlx',
    'npm exec --package', 'npm exec --package -- codex', 'npm exec --package=@openai/codex --',
    'npm exec --unknown codex', 'pnpm exec --unknown codex', 'yarn run codex',
  ])('returns the judge decision for package runner text or an unconfirmed agent launch: %s', async (command) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({ decision: 'deny', reason: 'judge examined command' }));
    expect(await decide('Bash', { command })).toEqual({ decision: 'deny', reason: 'judge examined command' });
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  it('denies a package runner agent launch even with a matching usable saved approval', async () => {
    const command = 'npm exec --package=@openai/codex -- codex exec';
    goal.questions = [answerInquiry(createInquiry({
      kind: 'approval', body: 'fixture approval', targetSha: 'a'.repeat(40),
      operation: { toolName: 'Bash', args: JSON.stringify({ command }), cwd: toolCwd },
    }), { text: '承認します', decision: 'allow', scope: 'goal' })];
    const session = createExecutor();
    let decision: ToolPermissionDecision | undefined;
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      decision = await handler(options)(request('Bash', { command }));
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction,
        goal: { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints },
      })).summary).toBeNull();
      expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
      expectDenial(decision!);
    }
  });
  describe.each([false, true])('package runner options with saved approval %s', (approved) => {
    const shellRunners = [
      'npm exec --package=@openai/codex --call', 'npm exec --package=@openai/codex -c',
      'pnpm dlx --package @openai/codex -c', 'pnpm dlx --package @openai/codex --shell-mode',
      'npx --package=@openai/codex -c', 'npx --package=@openai/codex --call',
      'npm exec --package=@openai/codex --call=', 'npx --package=@openai/codex --call=',
      'npm x --package=@openai/codex -c', 'npm x --package=@openai/codex --call',
      'npm x --package=@openai/codex --call=',
      'bash -c', 'sh -c', 'zsh -c',
    ];
    const longOptions = ['--par', '--parseable', '--porcelain'].flatMap((option) => [
      option, `${option}=true`, `${option}=false`, `${option} true`, `${option} false`,
      option.replace('--', '--no-'),
    ]);
    const workspaceOptions = [
      '--workspace=packages/a', '--workspace packages/a', '-w packages/a', '-w=packages/a',
      '-w packages/a -w packages/b', '--workspace=packages/a --workspace=packages/b',
      '--workspace=codex', '--workspace codex', '-w codex',
      ...['--workspaces', '--ws', '--include-workspace-root', '--iwr'].flatMap((option) => [
        option, `${option}=true`, `${option}=false`, `${option} true`, `${option} false`,
      ]),
      '--no-workspaces', '--no-include-workspace-root',
      '-w packages/a --include-workspace-root --', '-w packages/a --iwr --',
    ];
    const includeWorkspaceAbbreviations = [
      '--include-w', '--include-wo', '--include-wor', '--include-work', '--include-works',
      '--include-worksp', '--include-workspa', '--include-workspac', '--include-workspace',
      '--include-workspace-', '--include-workspace-r', '--include-workspace-ro', '--include-workspace-roo',
    ];
    const abbreviatedWorkspaceRunners = [
      ...includeWorkspaceAbbreviations.map((option) => `npm exec ${option} --`),
      ...[
        '--include-workspace=true', '--include-workspace=false',
        '--include-workspace true', '--include-workspace false',
        '--no-include-workspace', '--no-include-workspace=false',
      ].map((option) => `npm exec --workspace=packages/a ${option} --`),
      'npm x --workspace=packages/a --include-workspace --',
      'npx --workspace=packages/a --include-workspace --package=@openai/codex',
      'npm --workspace=packages/a --include-workspace exec --',
      'npm --workspace=packages/a --include-workspace x --',
      'npm --include-w false exec --', 'npm --no-include-workspace x --',
      'npm exec --include-workspace', 'npm exec --no-include-workspace',
    ];
    const runners = [
      ...abbreviatedWorkspaceRunners,
      ...workspaceOptions.map((option) => `npm exec ${option}`),
      'npm x --workspace=packages/a --package=@openai/codex --',
      'npx --workspace=packages/a --package=@openai/codex',
      'npm --workspace=packages/a exec --', 'npm -w packages/a exec --',
      'npm --workspace=packages/a x --', 'npm -w packages/a x --',
      'npm --ws exec --', 'npm --iwr x --',
      'npm --workspaces true exec --', 'npm --include-workspace-root=false x --',
      'npm -w packages/a exec -w packages/b --',
      ...['-p', '-p=true', '-p=false', '-p true', '-p false', ...longOptions]
        .map((option) => `npm exec ${option}`),
      'npm exec -p --package=@openai/codex --',
      'npm exec --parseable --package=@openai/codex --',
      'npm exec --porcelain --package=@openai/codex --',
      'npm exec -p --',
      ...longOptions.map((option) => `npx ${option} --package=@openai/codex`),
      'npx -p @openai/codex',
      'npm x --package=@openai/codex --', 'npm x --par --',
    ];
    const commands = [
      { command: 'npm exec --workspace=packages/a --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm exec --workspace=packages/a --package=@openai/codex -- printf codex exec', expected: 'allow' },
      { command: 'npm exec --workspace=packages/a --include-workspace-root --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm exec --workspace=packages/a --include-workspace-root --package=@openai/codex -- printf codex exec', expected: 'allow' },
      { command: 'npm exec --workspace=packages/a --include-workspace --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm exec --workspace=packages/a --include-workspace --package=@openai/codex -- printf codex exec', expected: 'allow' },
      { command: "npm exec --package=@openai/codex -c 'printf ${HOME}; codex exec'", expected: 'allow' },
      { command: "npm exec --package=@openai/codex -c 'printf `codex exec`'", expected: 'deny' },
      { command: 'npm exec --package=@openai/codex -c \'printf `printf "codex exec"`\'', expected: 'allow' },
      { command: "npm exec --package=@openai/codex -c 'printf $(printf $?; codex exec)'", expected: 'deny' },
      { command: 'npm exec --package=@openai/codex -c \'printf $(printf $?; printf "codex exec")\'', expected: 'allow' },
      { command: 'npm x --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm x --package=@openai/codex -- printf codex exec', expected: 'allow' },
      { command: "npm exec --package=@openai/codex -c 'printf $(codex exec)'", expected: 'deny' },
      { command: 'npm exec --par -- @openai/codex exec', expected: 'deny' },
      { command: 'npm exec --par -- printf @openai/codex exec', expected: 'allow' },
      ...[
        { body: 'printf $(codex exec)', expected: 'deny' },
        { body: 'printf $(printf "codex exec")', expected: 'allow' },
        { body: 'printf `codex exec`', expected: 'deny' },
        { body: 'printf `printf "codex exec"`', expected: 'allow' },
        { body: 'printf $(printf $?; codex exec)', expected: 'deny' },
        { body: 'printf $(printf $?; printf "codex exec")', expected: 'allow' },
      ].flatMap(({ body, expected }) => [
        { command: body, expected },
        ...shellRunners.map((runner) => ({ command: `${runner}${runner.endsWith('=') ? '' : ' '}'${body}'`, expected })),
      ]),
      ...[
        { body: 'codex exec', expected: 'deny' }, { body: 'printf codex', expected: 'allow' },
      ].flatMap(({ body, expected }) => [
        ...[
          'npm exec -w packages/a -c', 'npm exec -w packages/a --call',
          'npm exec -w packages/a --call=', 'npm x --ws --call',
          'npx --workspace=packages/a --call=', 'npm -w packages/a exec -c',
          'npm exec -w packages/a --include-workspace -c',
          'npm exec -w packages/a --include-workspace --call',
          'npm exec -w packages/a --include-workspace --call=',
          'npm x --include-workspace --call', 'npx --include-workspace --call=',
          'npm --include-workspace exec -c',
        ].map((runner) => ({ command: `${runner}${runner.endsWith('=') ? '' : ' '}'${body}'`, expected })),
        ...shellRunners.map((runner) => ({ command: `${runner}${runner.endsWith('=') ? '' : ' '}'${body}'`, expected })),
        ...runners.map((runner) => ({ command: `${runner} ${body}`, expected })),
      ]),
      { command: 'npm exec -p @openai/codex', expected: 'deny' },
      { command: 'npx -p @openai/codex', expected: 'allow' },
      { command: 'npm exec --workspace=codex -- printf done', expected: 'allow' },
      { command: 'npm exec --workspace=codex --include-workspace -- codex exec', expected: 'deny' },
      { command: 'npm exec --workspace=codex --include-workspace -- printf done', expected: 'allow' },
      { command: 'npm exec --workspace codex --include-workspace -- printf done', expected: 'allow' },
      { command: 'npm exec -- printf --include-workspace codex exec', expected: 'allow' },
      { command: "npm exec --call='printf --include-workspace codex exec'", expected: 'allow' },
      { command: 'npm exec -- printf --workspace=packages/a codex exec', expected: 'allow' },
    ];
    it.each(commands)('returns $expected before approval lookup or judgment: $command', async ({ command, expected }) => {
      const target = { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints };
      if (approved) {
        const approval = answerInquiry(createInquiry({
          kind: 'approval', body: 'fixture approval', targetSha: 'a'.repeat(40),
          operation: { toolName: 'Bash', args: JSON.stringify({ command }), cwd: toolCwd },
        }), { text: '承認します', decision: 'allow', scope: 'goal' });
        goal.questions = [approval];
        const context = await permissionInquiry.resolveManagerPermissionContext({
          request: request('Bash', { command }), configDirectory: '/fixture/global',
          owner: { kind: 'repository', repositoryDirectory: cwd }, goal: target,
          abortSignal: new AbortController().signal,
        });
        expect(context.readErrors).toEqual([]);
        expect(context.relatedInquiries).toEqual([approval]);
        expect(isGoalApprovalUsable(approval)).toBe(true);
      }
      const contextLookup = vi.spyOn(permissionInquiry, 'resolveManagerPermissionContext');
      const session = createExecutor();
      let decision: ToolPermissionDecision | undefined;
      doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
        decision = await handler(options)(request('Bash', { command }));
        return reply();
      });
      {
        expect((await executeTurn(session, { text: humanInstruction, goal: target })).summary).toBeNull();
        if (expected === 'deny') {
          expectDenial(decision!);
          expect(contextLookup).not.toHaveBeenCalled();
          expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
        } else {
          expect(decision).toEqual({ decision: 'allow' });
          expect(contextLookup).toHaveBeenCalledOnce();
          expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledTimes(approved ? 0 : 1);
        }
      }
    });
  });
  it.each([
    "npm exec --call='codex exec'", "npx --call='codex exec'",
    "npm exec -c 'codex exec' --package @openai/codex",
    "pnpm dlx -c --package @openai/codex 'codex exec'",
    "pnpm dlx --shell-mode --package=@openai/codex 'codex exec'",
    "npm exec -c 'printf done; codex exec'", "npx -c 'printf done && codex exec'",
    "pnpm dlx --package @openai/codex -c 'printf done; codex exec'",
    "npm exec -c 'co\"de\"x exec'", "npx -c 'co\\dex exec'",
    "pnpm dlx --package @openai/codex -c printf 'done; codex exec'",
  ])('parses shell option values, boolean options and compound commands: %s', async (command) => {
    expectDenial(await decide('Bash', { command }));
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it.each([
    'npm exec --include- -- codex exec', 'npm exec --include -- codex exec',
    'npm exec --include-unknown -- codex exec', 'npm exec --include-workspace-roots -- codex exec',
    'npm exec --include-workspace= -- codex exec', 'npm exec --include-workspace=unknown -- codex exec',
    'npm exec --include-workspace unknown -- codex exec', 'npm exec --include-workspace',
    'npm exec --include-workspace --', 'npm exec --include-workspace false --',
    'npm exec --no-include-workspace= -- codex exec', 'npm exec --no-include-workspace=unknown -- codex exec',
    'npm --include- exec -- codex exec', 'npm --include exec -- codex exec',
    'npm --include-workspace= exec -- codex exec', 'npm --include-workspace=unknown exec -- codex exec',
    'npm --include-workspace exec --',
    'npx --include- -- codex exec', 'npx --include-workspace= -- codex exec',
    'npx --include-workspace=unknown -- codex exec', 'npx --include-workspace',
    'npm exec -- --include-workspace codex exec', 'npx -- --include-workspace codex exec',
    'pnpm exec --include-workspace codex exec', 'yarn dlx --include-workspace codex exec',
    'bunx --include-workspace printf codex exec',
    'npm exec -w', 'npm exec --workspace', 'npm exec --workspace=', 'npm exec -w=',
    'npm exec -w -- codex exec', 'npm exec --workspace -- codex exec',
    'npm exec --workspace= -- codex exec', "npm exec -w '' -- codex exec",
    'npm -w -- exec -- codex exec', 'npm --workspace= exec -- codex exec',
    'npm --workspace=packages/a', 'npm exec -w packages/a --',
    'npx -w -- codex exec', 'npx --workspace=', 'npx -w packages/a',
    'npm exec --workspaces=unknown -- codex exec',
    'npm exec -w packages/a --unknown -- codex exec',
    'npm --unknown exec --workspace=packages/a -- codex exec',
    'npm exec -- --workspace=packages/a codex exec',
    'npx -- --workspace=packages/a codex exec',
    'pnpm exec --workspace=packages/a codex exec',
    'yarn dlx --workspaces codex exec', 'bunx --iwr printf codex exec',
    'npm exec -p', 'npm exec --par', 'npm exec --parseable', 'npm exec --porcelain',
    'npm exec -- --par codex exec', 'npx -- --par codex exec',
    'npm exec -- -p codex exec', 'npm exec -- --parseable codex exec',
    'npx -- --porcelain codex exec', 'npx -p',
    'pnpm exec --parseable codex', 'pnpm dlx --porcelain codex',
    'yarn dlx --parseable codex', 'bunx --parseable printf codex',
    'npm exec --call', 'npm exec -c', 'npx --call', 'npx -c',
    'pnpm dlx --package @openai/codex --shell-mode', 'pnpm dlx --package @openai/codex -c',
    "npm exec --call --package @openai/codex", "npx -c --package @openai/codex",
    "pnpm dlx -c --package 'codex exec'",
    "pnpm dlx -c --package @openai/codex 'printf codex'",
    "npm exec --unknown -c 'codex exec'", "npx --unknown -c 'codex exec'",
    "pnpm dlx --unknown -c 'codex exec'",
    "npm exec -- --call 'codex exec'", "npx -- -c 'codex exec'",
    "pnpm dlx -- --shell-mode 'codex exec'",
    "npm exec --call='printf codex'", "npx --call='printf codex'",
    "npm exec -c '# codex exec'", "npx -c 'printf \"codex exec\"'",
    "pnpm dlx --package @openai/codex -c 'cat <<EOF\ncodex exec\nEOF'",
    "npm exec -c 'printf \"codex'",
    "bunx -c 'codex exec'", "bunx --call 'codex exec'",
  ])('delegates missing, unknown or non-launch shell input to an allowing judge: %s', async (command) => {
    expect(await decide('Bash', { command })).toEqual({ decision: 'allow' });
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  describe.each((['claude', 'claude-sdk', 'codex'] as const).flatMap((provider) =>
    [false, true].map((approved) => ({ provider, approved })),
  ))('package runner permission output for $provider with saved approval $approved', ({ provider, approved }) => {
    it.each([
      ...[
        { body: 'codex exec', expected: 'deny' }, { body: 'printf codex', expected: 'allow' },
        { body: 'printf $(codex exec)', expected: 'deny' },
        { body: 'printf $(printf "codex exec")', expected: 'allow' },
        { body: 'printf `codex exec`', expected: 'deny' },
        { body: 'printf `printf "codex exec"`', expected: 'allow' },
        { body: 'printf $(printf $?; codex exec)', expected: 'deny' },
        { body: 'printf $(printf $?; printf "codex exec")', expected: 'allow' },
      ].flatMap(({ body, expected }) => [
        'npm exec --package=@openai/codex --call', 'pnpm dlx --package @openai/codex --shell-mode',
        'npm exec --parseable --package=@openai/codex --call', 'npm exec --package=@openai/codex -c',
      ].map((runner) => ({ command: `${runner} '${body}'`, expected }))),
      { command: 'npm exec --par -- @openai/codex exec', expected: 'deny' },
      { command: 'npm exec --par -- printf @openai/codex exec', expected: 'allow' },
      { command: 'npm x --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm x --package=@openai/codex -- printf codex exec', expected: 'allow' },
      { command: 'npm exec --workspace=packages/a --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm exec --workspace=packages/a --package=@openai/codex -- printf codex exec', expected: 'allow' },
      { command: 'npm exec --workspace=packages/a --include-workspace --package=@openai/codex -- codex exec', expected: 'deny' },
      { command: 'npm exec --workspace=packages/a --include-workspace --package=@openai/codex -- printf codex exec', expected: 'allow' },
    ])(
      'returns $expected in the provider permission output: $command', async ({ command, expected }) => {
        const target = { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints };
        if (approved) {
          const approval = answerInquiry(createInquiry({
            kind: 'approval', body: 'fixture approval', targetSha: 'a'.repeat(40),
            operation: { toolName: 'Bash', args: JSON.stringify({ command }), cwd: toolCwd },
          }), { text: '承認します', decision: 'allow', scope: 'goal' });
          goal.questions = [approval];
          const context = await permissionInquiry.resolveManagerPermissionContext({
            request: request('Bash', { command }), configDirectory: '/fixture/global',
            owner: { kind: 'repository', repositoryDirectory: cwd }, goal: target,
            abortSignal: new AbortController().signal,
          });
          expect(context.readErrors).toEqual([]);
          expect(context.relatedInquiries).toEqual([approval]);
          expect(isGoalApprovalUsable(approval)).toBe(true);
        }
        const contextLookup = vi.spyOn(permissionInquiry, 'resolveManagerPermissionContext');
        const session = createExecutor(provider);
        let output: unknown;
        doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
          const input = { hook_event_name: 'PreToolUse' as const, session_id: 'sdk-session',
            transcript_path: '/fixture/transcript', cwd: toolCwd, tool_name: 'Bash',
            tool_input: { command }, tool_use_id: 'fixture-tool-use' };
          if (provider === 'codex') {
            output = toCodexToolPermissionOutput(await handler(options)(parseCodexToolPermissionInput(input)));
          } else {
            const sdk = buildSdkOptions({ cwd, abortSignal: options.abortSignal, onToolPermissionDecision: handler(options) });
            const hook = sdk.hooks?.PreToolUse?.find(({ matcher }) => matcher === undefined)?.hooks[0];
            expect(hook).toBeTypeOf('function');
            output = await hook!(input, 'fixture-tool-use', { signal: new AbortController().signal });
          }
          return reply();
        });
        {
          expect((await executeTurn(session, { text: humanInstruction, goal: target })).summary).toBeNull();
          expect(output).toMatchObject({ hookSpecificOutput: {
            hookEventName: 'PreToolUse', permissionDecision: expected,
            ...(expected === 'deny' ? { permissionDecisionReason: expect.stringMatching(/\S/u) } : {}),
          } });
          expect(contextLookup).toHaveBeenCalledTimes(expected === 'deny' ? 0 : 1);
          expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledTimes(expected === 'deny' || approved ? 0 : 1);
        }
      },
    );
  });
  describe.each(['allow', 'deny'] as const)('command lookup with judge decision %s', (decision) => {
    it.each([
      'command -v codex', 'command -V codex',
      'command -pv codex', 'command -pV codex', 'command -p -v codex',
      "bash -c 'command -v codex'", "sh -c 'command -v codex'", "zsh -c 'command -v codex'",
    ])('returns the judge decision through PreToolUse: %s', async (command) => {
      vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({
        decision, reason: decision === 'deny' ? 'judge examined command' : null,
      }));
      const session = createExecutor();
      let output: unknown;
      doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
        const sdk = buildSdkOptions({ cwd, abortSignal: options.abortSignal, onToolPermissionDecision: handler(options) });
        const hook = sdk.hooks?.PreToolUse?.find(({ matcher }) => matcher === undefined)?.hooks[0];
        expect(hook).toBeTypeOf('function');
        output = await hook!({ hook_event_name: 'PreToolUse', session_id: 'sdk-session', transcript_path: '/fixture/transcript',
          cwd: toolCwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'fixture-tool-use',
        }, 'fixture-tool-use', { signal: new AbortController().signal });
        return reply();
      });
      {
        expect((await executeTurn(session, { text: humanInstruction })).summary).toBeNull();
        expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
        expect(output).toEqual({ hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: decision,
          ...(decision === 'deny' ? { permissionDecisionReason: 'judge examined command' } : {}),
        } });
      }
    });
  });
  it.each([
    'claude -p inspect', 'codex exec inspect', 'cursor-agent inspect', 'opencode run inspect',
    'gemini inspect', 'copilot inspect', 'aider inspect', 'takt run inspect',
    'takt --pipeline -w inspect -t inspect', 'npx codex exec inspect', 'bunx gemini inspect',
    "env MODE=test npx 'co'dex exec inspect", 'env MODE=test "claude" -p inspect',
    "'cursor-agent' inspect", 'co"de"x exec inspect', 'pwd && codex exec inspect',
    'co\\dex exec inspect', '/usr/local/bin/codex exec inspect', 'npx --yes @openai/codex exec inspect',
    'env -u SESSION MODE=test bunx --bun gemini inspect', 'takt manager',
    'timeout 60 codex exec inspect', 'timeout --signal TERM --kill-after 5 60 codex exec inspect',
    'nohup claude -p inspect', 'exec codex exec inspect', 'exec -a manager codex exec inspect',
    'command codex exec inspect', 'command -- codex exec inspect', 'time -p codex exec inspect',
    'command codex', 'command -p codex', 'command -- codex -v', 'command codex -v',
    "bash -c 'command codex'", "sh -c 'command codex'", "zsh -c 'command codex'",
    'command -v codex; codex exec inspect', 'codex exec inspect; command -v codex',
    'time -f elapsed codex exec inspect', 'nice -n 5 codex exec inspect', 'nice --adjustment=5 codex exec inspect',
    'sudo codex exec inspect', 'sudo -u root codex exec inspect', 'sudo --user root codex exec inspect',
    'sudo --user=root codex exec inspect', 'sudo -uroot codex exec inspect',
    'xargs codex', 'xargs -n 1 -P 2 codex exec inspect', 'xargs -I {} codex exec inspect {}',
    'stdbuf -o L codex exec inspect', 'stdbuf -oL codex exec inspect',
    'bash -c "codex exec inspect"', "sh -c 'claude -p inspect'", "zsh -c 'gemini inspect'",
    "bash -lc 'codex exec inspect'", "bash -c 'sh -c \"codex exec inspect\"'",
    "timeout 60 sudo -u root env MODE=test nohup bash -c 'codex exec inspect'",
    "codex exec inspect; bash -c 'printf $(pwd)'", "bash -c 'printf $(pwd)'; codex exec inspect",
    "bash -c 'codex exec inspect; sh -c \"printf $(pwd)\"'",
    "bash -c 'codex exec $(pwd)'", 'printf codex; codex exec $(pwd)',
    'printf $(pwd); codex exec inspect', "bash -c 'printf $(pwd); codex exec inspect'",
    'printf "$(pwd)"; codex exec inspect',
    "sh -c 'printf $(pwd); codex exec inspect'", "zsh -c 'printf $(pwd); codex exec inspect'",
    'printf "$(printf "%s" "$(pwd)")"; codex exec inspect',
    'printf $(printf \\)); codex exec inspect',
    'printf "$(codex exec)"', 'printf $(printf "$(codex exec)")',
    'printf $(codex exec); printf $unknown', 'npm test; printf $(codex exec)',
    'printf `codex exec`', 'printf "`codex exec`"',
    'printf $(printf `codex exec`)', 'printf `printf $(codex exec)`',
    'printf `printf \\`codex exec\\``', 'printf `co\\dex exec`',
    'printf `printf $?; codex exec`', 'printf `printf \\$?; codex exec`',
    'printf $?; codex exec', 'printf $unknown; codex exec',
    'printf "$unknown"; codex exec', 'printf $(printf $unknown; codex exec)',
    'codex exec; printf `unknown',
  ])('denies an AI CLI launch without a judge: %s', async (command) => {
    expectDenial(await decide('Bash', { command }));
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it.each([
    "printf '%s\\n' 'codex'", '# codex exec inspect', "cat <<'EOF'\ncodex exec inspect\nEOF",
    "printf 'codex", 'printf "%s" "$(unknown-wrapper inspect)"',
    'takt list run', 'printf codex # claude -p inspect',
    'timeout 5 git status', 'sudo -u root git status', 'sudo -u codex git status',
    'sudo --user codex git status', 'sudo --user=codex git status', 'sudo -ucodex git status',
    'exec -a codex git status', 'nice -n 5 git status', 'stdbuf -o L git status',
    "bash -c 'printf codex'",
    "bash -c 'printf $(pwd)'", 'printf codex; printf "$(pwd)"',
  ])('judges text or unsupported syntax instead of treating a name as a launch: %s', async (command) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({ decision: 'deny', reason: 'judge examined command' }));
    expect(await decide('Bash', { command })).toEqual({ decision: 'deny', reason: 'judge examined command' });
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  it.each([
    'printf codex; printf exec $(pwd)', "bash -c 'printf exec $(pwd)'",
    "bash -c 'printf $(pwd)'", "bash -c 'sh -c \"printf $(pwd)\"'",
    'printf $(pwd); printf exec inspect', "bash -c 'printf $(pwd); printf exec inspect'",
    'printf "$(pwd)"; printf exec inspect', 'printf "$(pwd); codex exec inspect"',
    "sh -c 'printf $(pwd); printf exec inspect'", "zsh -c 'printf $(pwd); printf exec inspect'",
    'printf $(printf "done; codex exec inspect")',
    'printf $(printf "$(pwd); codex exec inspect")',
    'printf $(pwd) "ignored; codex exec inspect"', 'printf $(pwd) \\; codex exec inspect',
    'printf $(pwd; codex exec inspect', 'printf "$(pwd); codex exec inspect',
    'env $(pwd) codex; printf done', 'printf $(pwd) # ; codex exec inspect',
    "printf '$(codex exec)'", 'printf \\$(codex exec)', '# printf $(codex exec)',
    'printf $(printf "codex exec")', 'printf $(printf "$(pwd)")',
    'printf $(pwd # codex exec\n)', 'printf $(pwd # ) codex exec\n)',
    'printf $(codex exec', 'printf $(printf "$(codex exec)"',
    "printf '`codex exec`'", 'printf \\`codex exec\\`', 'printf "\\`codex exec\\`"',
    '# printf `codex exec`', 'printf `printf "codex exec"`',
    'printf `printf "$(printf "codex exec")"`',
    'printf `printf \\`printf "codex exec"\\``',
    'printf `pwd # codex exec\n`', 'printf `pwd # ) codex exec\n`',
    'printf `codex exec', 'printf $(printf `codex exec`', 'printf `printf $(codex exec)',
    'printf "$unknown; codex exec"', 'printf $(printf "$unknown; codex exec")',
    'co${unknown}dex exec', 'co$unknown"dex" exec', 'co`printf de`x exec',
  ])('returns the judge allowance when unsupported syntax has no detected launch: %s', async (command) => {
    expect(await decide('Bash', { command })).toEqual({ decision: 'allow' });
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  describe.each(['ja', 'en'] as const)('fixed denial reasons in %s', (language) => {
    it.each(['Task', 'Agent', 'Bash'])('returns the localized %s denial through the session', async (toolName) => {
      const reason = toolName === 'Bash'
        ? language === 'ja' ? 'Bash: 別の AI コマンド行エージェントを起動する操作は許可されていません。'
          : 'Bash: Launching another AI command-line agent is not allowed.'
        : language === 'ja' ? `${toolName}: manager から別の AI エージェントを起動する操作は許可されていません。`
          : `${toolName}: The manager is not allowed to launch another AI agent.`;
      expect(await decide(toolName, { command: 'timeout 60 codex exec inspect' }, language)).toEqual({ decision: 'deny', reason });
      expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
    });
  });
});
describe('manager permission judge input and output', () => {
  it('passes the complete date command to the judge without redaction', async () => {
    const command = 'date -u +%Y-%m-%dT%H:%M:%SZ; d=/tmp/x; ls -la $d';

    await decide('Bash', { command });

    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
    const instruction = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![1];
    const { toolArguments } = JSON.parse(instruction) as { toolArguments: string };
    expect(toolArguments).toContain(command);
    expect(toolArguments).not.toContain('[REDACTED]');
  });

  it('redacts curl credentials in the tool arguments passed to the judge', async () => {
    await decide('Bash', { command: 'curl -u alice:s3cretvalue https://example.com' });

    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
    const instruction = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![1];
    const { toolArguments } = JSON.parse(instruction) as { toolArguments: string };
    expect(toolArguments).toBe(JSON.stringify({ command: 'curl -u [REDACTED] https://example.com' }));
    expect(toolArguments).not.toMatch(/alice|s3cretvalue/iu);
  });

  it.each([
    ['alice', 's3cretvalue'],
    ['al+ice', 's3cretvalue'],
    ['al+ice', 's3cret value'],
  ])('redacts JSON quoted judge arguments for %s / %s', async (username, password) => {
    await decide('Bash', { command: `curl -u "${username}:${password}" https://example.com` });

    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
    const instruction = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![1];
    const { toolArguments } = JSON.parse(instruction) as { toolArguments: string };
    expect(toolArguments).toBe(JSON.stringify({ command: 'curl -u [REDACTED] https://example.com' }));
    expect(toolArguments).not.toMatch(/al\+ice|alice|s3cret/iu);
  });

  it.each(['ja', 'en'] as const)('resolves %s facets and passes sanitized tool arguments and actual cwd to an isolated judge', async (language) => {
    const session = createExecutor('claude-sdk', language);
    const target = { id: goal.id, repositoryDirectory: '/fixture/goal-repository', constraints: goal.constraints };
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      await handler(options)(request('Bash', { command: 'inspect api_key=fixture-secret', count: 7 }));
      return reply();
    });
    {
      const turn: TurnOptions = { text: humanInstruction, goal: target };
      expect((await executeTurn(session, turn)).summary).toBeNull();
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
      const [system, instruction, , options] = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]!;
      const input = `${system}\n${instruction}`;
      for (const value of ['Bash', '7', toolCwd, humanInstruction, ...target.constraints,
        `${language}:personas:manager:fixture-content`, `${language}:policies:manager:fixture-content`,
        `${language}:personas:manager-permission-judge:fixture-content`, `${language}:policies:manager-permission-judge:fixture-content`]) {
        expect(input).toContain(value);
      }
      expect(input).toContain('[REDACTED]');
      expect(input).not.toMatch(/fixture[\s_-]*secret/iu);
      expect(options.cwd).toBe(toolCwd);
      expect(options.sessionId).toBeUndefined();
      expect(options.mcpAssignment).toBeUndefined();
    }
  });
  it('falls back to the manager provider and model instead of different runtime defaults', async () => {
    await decide('Bash', { command: 'pwd' });
    expect(vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![3].resolution).toEqual({
      provider: 'claude-sdk', model: 'manager-model', providerOptions: { claude: { effort: 'high' } },
    });
  });
  it('uses an explicit judge seat without inheriting manager provider options', async () => {
    environment.internalAgents = { managerPermissionJudge: { provider: 'opencode', model: 'seat-model', providerOptions: { opencode: { allowedTools: ['read'] } } } };
    await decide('Bash', { command: 'pwd' });
    expect(vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![3].resolution).toEqual({
      provider: 'opencode', model: 'seat-model', providerOptions: { opencode: { allowedTools: ['read'] } },
    });
  });
  it('does not inherit a manager model or options when the explicit seat omits them', async () => {
    environment.internalAgents = { managerPermissionJudge: { provider: 'opencode' } };
    await decide('Bash');
    expect(vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![3].resolution).toEqual({
      provider: 'opencode', model: undefined, providerOptions: {},
    });
  });
  it('rejects an explicit seat without a resolved provider', () => {
    environment.internalAgents = { managerPermissionJudge: { model: 'unresolved' } };
    expect(() => createExecutor()).toThrow();
    expect(doubles.call).not.toHaveBeenCalled();
  });
  it.each(['personas', 'policies'])('rejects a missing judge %s facet before a conversation', (category) => {
    doubles.facet.mockImplementation((name: string, kind: string) => name === 'manager-permission-judge' && kind === category ? undefined : 'fixture');
    expect(() => createExecutor()).toThrow();
    expect(doubles.call).not.toHaveBeenCalled();
  });
  it('denies arguments that cannot be serialized without invoking the judge', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.value = cyclic;
    expectDenial(await decide('UnknownTool', cyclic));
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });
  it('runs the judge with no tools, MCP servers or conversation session at the runner boundary', async () => {
    const actual = await vi.importActual<typeof import('../agents/agent-usecases.js')>('../agents/agent-usecases.js');
    vi.mocked(executeIsolatedStructuredInternalAgent).mockImplementationOnce(actual.executeIsolatedStructuredInternalAgent);
    vi.mocked(runAgent).mockResolvedValue(judgment({ decision: 'allow', reason: null }));
    const session = createExecutor();
    {
      expect((await executeTurn(session, { text: '会話を開始' })).summary).toBeNull();
      doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
        expect(options.sessionId).toBe('manager-conversation-session');
        expect(options.mcpServers).toHaveProperty('external');
        expect(await handler(options)(request())).toEqual({ decision: 'allow' });
        return reply();
      });
      expect((await executeTurn(session, { text: humanInstruction, sessionId: 'manager-conversation-session' })).summary).toBeNull();
      expect(runAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent).mock.calls[0]![2]).toMatchObject({
        executionProfile: 'isolated-structured', allowedTools: [], mcpServers: {},
        sessionId: undefined, internalAgentIsolation: 'strict-readonly',
        resolvedExecution: { permissionMode: 'readonly' },
      });
    }
  });
  it.each(['structuredOutput', 'content'] as const)('accepts a top-level denial from %s and passes a schema accepting exactly three decisions', async (format) => {
    const output = { decision: 'deny', reason: '成果物を書き換える操作です' };
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment(format === 'content' ? undefined : output, JSON.stringify(output)));
    expect(await decide('Bash')).toEqual(output);
    const schema = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![2];
    for (const decision of ['allow', 'deny', 'ask']) {
      expect(() => validateStructuredOutputAgainstSchema({ decision, reason: 'fixture reason' }, schema)).not.toThrow();
    }
    for (const invalid of [{ decision: 'unknown', reason: 'reason' }, { result: { decision: 'allow', reason: null } }, { decision: 'deny' }]) {
      expect(() => validateStructuredOutputAgainstSchema(invalid, schema)).toThrow();
    }
  });
  it.each([
    null, {}, { decision: 'unknown', reason: 'reason' }, { decision: 'deny' },
    { decision: 'deny', reason: '' }, { decision: 'deny', reason: '   ' },
    { decision: 'ask', reason: '' }, { decision: 'ask', reason: null },
    { result: { decision: 'allow', reason: null } }, { decision: 'allow', reason: null, unexpected: true },
  ])('denies invalid structured output without retrying: %j', async (output) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment(output));
    expectDenial(await decide('Bash'));
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  it.each(['', 'not json', '```json\n{"decision":"allow","reason":null}\n```', '{"result":{"decision":"allow","reason":null}}'])('does not extract allow from invalid text output: %s', async (content) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment(undefined, content));
    expectDenial(await decide('Bash'));
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  it.each(['throw', 'error response'] as const)('denies a judge %s without retrying or failing the conversation', async (failure) => {
    if (failure === 'throw') vi.mocked(executeIsolatedStructuredInternalAgent).mockRejectedValue(new Error('judge failure'));
    else vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue({ ...judgment(undefined), status: 'error', error: 'judge failure' });
    expectDenial(await decide('Bash'));
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });
  describe.each(['ja', 'en'] as const)('fixed judge failure reasons in %s', (language) => {
    it.each([
      { failure: 'error response', ja: '道具の判断役の実行に失敗したため拒否しました。', en: 'Denied because the tool permission judge failed to run.' },
      { failure: 'invalid output', ja: '道具の判断役の出力が不正なため拒否しました。', en: 'Denied because the tool permission judge returned invalid output.' },
      { failure: 'missing reason', ja: '道具の判断役が理由を返さなかったため拒否しました。', en: 'Denied because the tool permission judge did not provide a reason.' },
      { failure: 'exception', ja: '道具の判断役の実行または出力の検証に失敗したため拒否しました。', en: 'Denied because the tool permission judge failed to run or its output could not be validated.' },
    ])('denies $failure with the localized reason without retrying', async ({ failure, ja, en }) => {
      if (failure === 'exception') vi.mocked(executeIsolatedStructuredInternalAgent).mockRejectedValueOnce(new Error('judge failure'));
      else {
        const response = failure === 'error response' ? { ...judgment(undefined), status: 'error' as const }
          : judgment(failure === 'invalid output' ? {} : { decision: 'deny', reason: '   ' });
        vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValueOnce(response);
      }
      expect(await decide('Bash', { command: 'pwd' }, language)).toEqual({ decision: 'deny', reason: language === 'ja' ? ja : en });
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
    });
  });
});
describe('manager permission judge deadline and cancellation', () => {
  it.each(['ja', 'en'] as const)('denies an already cancelled request in %s without invoking the judge or leaving timers', async (language) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const session = createExecutor('claude-sdk', language);
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expect(await handler(options)(request('Bash', {}, controller.signal))).toEqual({ decision: 'deny', reason: language === 'ja'
        ? '道具の判断が中断されたため拒否しました。' : 'Denied because the tool permission check was interrupted.' });
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction })).summary).toBeNull();
      expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it.each([{ language: 'ja', provider: 'claude-sdk' }, { language: 'en', provider: 'claude-sdk' }, { language: 'ja', provider: 'codex' }] as const)('denies at 30 seconds in $language for $provider even if the judge ignores abort, and never accepts its late allow', async ({ language, provider }) => {
    vi.useFakeTimers();
    let complete!: (response: AgentResponse) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(executeIsolatedStructuredInternalAgent).mockImplementationOnce(() => {
      started(); return new Promise((resolve) => { complete = resolve; });
    });
    const session = createExecutor(provider, language);
    let decision: ToolPermissionDecision | undefined;
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      decision = await handler(options)(request()); return reply();
    });
    const turn = executeTurn(session, { text: humanInstruction });
    try {
      // handler の配線漏れで ready が解決しない場合も、ターンの結果から失敗理由を得る。
      await Promise.race([ready, turn]);
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(decision).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect((await turn).summary).toBeNull();
      expect(decision).toEqual({ decision: 'deny', reason: language === 'ja'
        ? '道具の判断役が30秒の期限を超えたため拒否しました。' : 'Denied because the tool permission judge exceeded the 30-second time limit.' });
      expect(vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![3].abortSignal?.aborted).toBe(true);
      complete(judgment({ decision: 'allow', reason: null }));
      await Promise.resolve();
      expectDenial(decision!);
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { complete?.(judgment({ decision: 'allow', reason: null }));  }
  });
  it.each(['parent', 'hook'] as const)('propagates %s cancellation and denies without retrying', async (source) => {
    const parent = new AbortController(); const hook = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(executeIsolatedStructuredInternalAgent).mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const session = createExecutor();
    let decision: ToolPermissionDecision | undefined;
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      const combined = AbortSignal.any([options.abortSignal!, hook.signal]);
      decision = await handler(options)(request('Bash', { command: 'pwd' }, combined)); return reply();
    });
    const turn = executeTurn(session, { text: humanInstruction, abortSignal: parent.signal });
    try {
      await Promise.race([ready, turn]);
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
      (source === 'parent' ? parent : hook).abort();
      if (source === 'parent') await expect(turn).rejects.toBeDefined();
      else await expect(turn).resolves.toMatchObject({ summary: null });
      expectDenial(decision!);
      expect(vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![3].abortSignal?.aborted).toBe(true);
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
    } finally { parent.abort(); hook.abort();  }
  });
});

describe('manager permission confirmation and turn context', () => {
  const reason = '送信先の選択には人の判断が必要です';
  beforeEach(() => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({ decision: 'ask', reason }));
  });
  describe.each(['goal', 'standalone'] as const)('quoted credentials in %s inquiries', (owner) => {
    it.each([
      ['alice', 's3cretvalue'],
      ['al+ice', 's3cretvalue'],
      ['al+ice', 's3cret value'],
    ])('protects saved operation arguments and the permission proposal for %s / %s', async (username, password) => {
      const session = createExecutor();
      const command = `curl -u "${username}:${password}" https://example.com`;
      doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
        expectDenial(await handler(options)(request('Bash', { command })));
        return reply();
      });
      {
        const turn: TurnOptions = { text: humanInstruction,
          ...(owner === 'goal' ? { goal: { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints } } : {}),
        };
        expect((await executeTurn(session, turn)).summary).toBeNull();
        if (owner === 'standalone') expect(doubles.inquiryApproval).toHaveBeenCalledOnce();
        else expect(goal.questions).toHaveLength(1);
        const saved = owner === 'goal' ? goal.questions![0]!
          : await doubles.inquiryApproval.mock.results[0]!.value as ReturnType<typeof createInquiry>;
        const expectedArgs = JSON.stringify({ command: 'curl -u [REDACTED] https://example.com' });
        expect(saved.operation!.args).toBe(expectedArgs);
        expect(saved.permissionProposal).toContain(expectedArgs);
        expect(saved.permissionProposal).toContain(toolCwd);
        for (const text of [saved.operation!.args, saved.permissionProposal!]) {
          expect(text).not.toMatch(/al\+ice|alice|s3cret/iu);
        }
      }
    });
  });
  it.each(['ja', 'en'] as const)('denies confirmation with a saved inquiry ID in %s, delivers a goal-less notice, and returns the reason to its caller', async (language) => {
    const session = createExecutor('claude-sdk', language); const onNotification = vi.fn(); const onDenial = vi.fn();
    let output: unknown;
    let decision: ToolPermissionDecision | undefined;
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      const decidePermission = handler(options);
      const sdk = buildSdkOptions({ cwd, abortSignal: options.abortSignal, onToolPermissionDecision: async (input) => {
        decision = await decidePermission(input); return decision;
      } });
      const hook = sdk.hooks?.PreToolUse?.find(({ matcher }) => matcher === undefined)?.hooks[0];
      expect(hook).toBeTypeOf('function');
      output = await hook!({ hook_event_name: 'PreToolUse', session_id: 'sdk-session', transcript_path: '/fixture/transcript',
        cwd: toolCwd, tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'fixture-tool-use',
      }, 'fixture-tool-use', { signal: new AbortController().signal });
      return reply();
    });
    {
      const turn: TurnOptions = { text: humanInstruction, onNotification, onDenial };
      expect((await executeTurn(session, turn)).summary).toBeNull();
      expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(inquiryId) });
      expect(decision).toHaveProperty('reason', expect.stringContaining(reason));
      const expectedReason = (decision as { reason: string }).reason;
      expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expectedReason } });
      expect(onNotification).toHaveBeenCalledWith(`manager: ${expectedReason}`);
      expect(doubles.slack).toHaveBeenCalledWith(webhook, `manager: ${expectedReason}`);
      expect(doubles.update).not.toHaveBeenCalled();
      expect(onDenial).toHaveBeenCalledWith(expectedReason);
    }
  });
  it.each(['ja', 'en'] as const)('saves a custom notice in %s for the specified goal repository and sends it through existing goal delivery', async (language) => {
    const session = createExecutor('claude-sdk', language);
    const repositoryDirectory = '/fixture/goal-repository';
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expectDenial(await handler(options)(request())); return reply();
    });
    {
      const turn: TurnOptions = { text: humanInstruction, goal: { id: goal.id, repositoryDirectory, constraints: goal.constraints } };
      expect((await executeTurn(session, turn)).summary).toBeNull();
      expect(doubles.update).toHaveBeenCalledWith(goal.id, expect.any(Function));
      expect(doubles.store).toHaveBeenLastCalledWith(repositoryDirectory);
      expect(goal.questions).toEqual([expect.objectContaining({ kind: 'approval' })]);
      const savedReason = goal.notifications![0]!.body;
      expect(savedReason).toContain(goal.questions![0]!.id);
      expect(savedReason).toContain(reason);
      expect(doubles.savedNotification).toHaveBeenCalledWith(repositoryDirectory,
        expect.objectContaining({ questions: goal.questions }), goal, webhook);
    }
  });
  it('respects a disabled custom notification policy while still refusing the operation', async () => {
    doubles.notificationOptions.mockReturnValue({ policy: { ...policy, custom: false }, webhookUrl: webhook, mainMerge: 'approve' });
    expectDenial(await decide('Bash'));
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.savedNotification).not.toHaveBeenCalled();
    expect(doubles.slack).not.toHaveBeenCalled();
  });
  it('returns the goal-less notice to the TUI when no Slack webhook is configured', async () => {
    doubles.notificationOptions.mockReturnValue({ policy, webhookUrl: undefined, mainMerge: 'approve' });
    const session = createExecutor(); const onNotification = vi.fn();
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expectDenial(await handler(options)(request())); return reply();
    });
    {
      const turn: TurnOptions = { text: humanInstruction, onNotification };
      expect((await executeTurn(session, turn)).summary).toBeNull();
      expect(onNotification).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(doubles.slack).not.toHaveBeenCalled();
    }
  });
  it.each(['notice save', 'goal delivery', 'goal-less Slack'] as const)('continues refusal and conversation after %s fails', async (failure) => {
    const session = createExecutor(); const onNotification = vi.fn();
    if (failure === 'notice save') doubles.update
      .mockImplementationOnce(async (_id: string, transform: (current: Goal) => Goal) => { goal = transform(goal); return goal; })
      .mockRejectedValueOnce(new Error('fixture notice save failure'));
    if (failure === 'goal delivery') doubles.savedNotification.mockRejectedValueOnce(new Error('fixture delivery failure'));
    if (failure === 'goal-less Slack') doubles.slack.mockRejectedValueOnce(new Error('fixture Slack failure'));
    let decision: ToolPermissionDecision | undefined;
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      decision = await handler(options)(request()); return reply();
    });
    {
      const turn: TurnOptions = { text: humanInstruction, onNotification,
        ...(failure === 'goal-less Slack' ? {} : { goal: { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints } }),
      };
      expect((await executeTurn(session, turn)).summary).toBeNull();
      expectDenial(decision!);
      if (failure === 'goal-less Slack') expect(onNotification).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect((await executeTurn(session, { text: '次の調査を続けてください' })).summary).toBeNull();
    }
  });
  it('uses the explicit current instruction, session ID and goal constraints for each executor call', async () => {
    const executor = createExecutor();
    doubles.call.mockImplementation(async (_prompt: string, options: DecisionOptions) => {
      await handler(options)(request()); return reply();
    });
    const first: TurnOptions = { text: '最初の指示を確認', goal: { id: goal.id, repositoryDirectory: cwd, constraints: ['最初のゴール制約'] } };
    const second: TurnOptions = { text: '次の指示を確認', sessionId: 'manager-conversation-session',
      goal: { id: '650e8400-e29b-41d4-a716-446655440002', repositoryDirectory: '/fixture/other-goal', constraints: ['次のゴール制約'] } };
    await executeTurn(executor, first);
    await executeTurn(executor, second);
    const calls = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls;
    expect(calls[0]![1]).toContain(first.text);
    expect(calls[0]![1]).toContain(first.goal!.constraints[0]);
    const current = JSON.stringify(calls[1]!.slice(0, 2));
    expect(current).toContain(second.text);
    expect(current).toContain(second.goal!.constraints[0]);
    expect(current).not.toContain(first.text);
    expect(current).not.toContain(first.goal!.constraints[0]);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBe('manager-conversation-session');
    await executeTurn(executor, { text: '独立した相談' });
    expect(doubles.call.mock.calls[2]![1].sessionId).toBeUndefined();
    expect(JSON.stringify(calls[2]!.slice(0, 2))).not.toContain(second.goal!.constraints[0]);
  });
  it('clears the refused operation context after an interrupted conversation is discarded', async () => {
    const session = createExecutor(); const controller = new AbortController();
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expectDenial(await handler(options)(request()));
      controller.abort(); return reply();
    });
    {
      await expect(executeTurn(session, { text: humanInstruction, abortSignal: controller.signal })).rejects.toBeDefined();
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
      expect((await executeTurn(session, { text: '新しい相談' })).summary).toBeNull();
      expect(doubles.call.mock.calls[1]![0]).not.toContain(reason);
      expect(doubles.call.mock.calls[1]![1].sessionId).toBeUndefined();
    }
  });
  it('returns the refusal to the executor caller together with the explicit goal context', async () => {
    const executor = createExecutor();
    const onDenial = vi.fn();
    const target = { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints };
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expectDenial(await handler(options)(request())); return reply();
    });
    await executeTurn(executor, { text: humanInstruction, goal: target, onDenial });
    expect(onDenial).toHaveBeenCalledOnce();
    expect(onDenial).toHaveBeenCalledWith(expect.stringContaining(reason));
  });
  it('reports a refusal to its caller even when the provider subsequently fails', async () => {
    const executor = createExecutor();
    const onDenial = vi.fn();
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expectDenial(await handler(options)(request()));
      throw new Error('fixture provider response failure');
    });
    await expect(executeTurn(executor, { text: humanInstruction, onDenial })).rejects.toThrow('fixture provider response failure');
    expect(onDenial).toHaveBeenCalledWith(expect.stringContaining(reason));
  });
  it.each(['claude', 'claude-sdk', 'codex', 'opencode', 'mock'] as const)('enables the handler only for supported conversation providers: %s', async (provider) => {
    const session = createExecutor(provider);
    {
      expect((await executeTurn(session, { text: humanInstruction })).summary).toBeNull();
      const options = doubles.call.mock.calls[0]![1] as DecisionOptions;
      if (provider === 'claude' || provider === 'claude-sdk' || provider === 'codex') expect(options.onToolPermissionDecision).toBeTypeOf('function');
      else expect(options.onToolPermissionDecision).toBeUndefined();
    }
  });
});
describe('Codex manager tool permission decisions', () => {
  it.each(['deny', 'allow'] as const)('denies spawn_agent with a reason in PreToolUse output without invoking a judge configured to %s', async (judgeDecision) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({
      decision: judgeDecision, reason: judgeDecision === 'deny' ? 'judge refused' : null,
    }));
    const session = createExecutor('codex');
    let decision: ToolPermissionDecision | undefined;
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      const input = parseCodexToolPermissionInput({
        hook_event_name: 'PreToolUse', tool_name: 'spawn_agent',
        tool_input: { message: 'Inspect the repository' }, cwd: toolCwd,
      });
      decision = await handler(options)(input);
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction })).summary).toBeNull();
      expect(decision).toBeDefined();
      expectDenial(decision!);
      const output = toCodexToolPermissionOutput(decision!);
      expect(output).toEqual({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/\S/u),
      } });
      expect(decision).toHaveProperty('reason', output.hookSpecificOutput.permissionDecisionReason);
      expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
    }
  });

  it.each(TAKT_MCP_MANAGER_TOOL_NAMES)('allows only the exact manager MCP full name for %s without a judge', async (name) => {
    expect(await decide(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`, {}, 'ja', 'codex')).toEqual({ decision: 'allow' });
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });

  it.each([
    'Read', 'Glob', 'Grep', 'ToolSearch', 'Bash', 'apply_patch', 'UnknownTool',
    'mcp__external__takt_list_goals',
    `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_list_goals_extra`,
  ])('judges %s on every invocation even with a manager full name and read-only hint in the arguments', async (toolName) => {
    environment.internalAgents = { managerPermissionJudge: { provider: 'claude-sdk', model: 'judge-seat' } };
    vi.mocked(executeIsolatedStructuredInternalAgent)
      .mockResolvedValueOnce(judgment({ decision: 'allow', reason: null }))
      .mockResolvedValueOnce(judgment({ decision: 'deny', reason: 'second call refused' }));
    const session = createExecutor('codex');
    const toolInput = { command: 'pwd', name: `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_list_goals`, readOnlyHint: true };
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      const decidePermission = handler(options);
      expect(await decidePermission(request(toolName, toolInput))).toEqual({ decision: 'allow' });
      expect(await decidePermission(request(toolName, toolInput))).toEqual({ decision: 'deny', reason: 'second call refused' });
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction })).summary).toBeNull();
      expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledTimes(2);
    }
  });

  it.each([
    ['Task', {}], ['Agent', {}],
    ['Bash', { command: 'codex exec inspect' }],
    ['Bash', { command: 'co"de"x exec inspect' }],
    ['Bash', { command: "bash -c 'codex exec inspect'" }],
  ] as const)('denies %s delegation or an AI CLI launch without invoking the judge: %j', async (name, toolInput) => {
    expectDenial(await decide(name, toolInput, 'ja', 'codex'));
    expect(executeIsolatedStructuredInternalAgent).not.toHaveBeenCalled();
  });

  it.each([
    "printf '%s' 'codex exec inspect'", '# codex exec inspect',
    "cat <<'EOF'\ncodex exec inspect\nEOF", "printf 'codex",
  ])('judges command text without a detected AI launch: %s', async (command) => {
    expect(await decide('Bash', { command }, 'ja', 'codex')).toEqual({ decision: 'allow' });
    expect(executeIsolatedStructuredInternalAgent).toHaveBeenCalledOnce();
  });

  it.each(['ja', 'en'] as const)('uses the explicit judge seat and existing %s facets with the actual tool cwd and current goal', async (language) => {
    environment.internalAgents = { managerPermissionJudge: { provider: 'claude-sdk', model: 'judge-seat' } };
    const session = createExecutor('codex', language);
    const target = { id: goal.id, repositoryDirectory: '/fixture/goal-repository', constraints: goal.constraints };
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      expect(await handler(options)(request('apply_patch', { command: 'fixture patch' }))).toEqual({ decision: 'allow' });
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction, goal: target })).summary).toBeNull();
      const [system, instruction, schema, options] = vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]!;
      expect(system).toContain(`${language}:personas:manager-permission-judge:fixture-content`);
      expect(system).toContain(`${language}:policies:manager-permission-judge:fixture-content`);
      expect(JSON.parse(instruction)).toMatchObject({
        toolName: 'apply_patch', toolArguments: JSON.stringify({ command: 'fixture patch' }),
        cwd: toolCwd, humanInstruction, goal: target,
        managerPersona: `${language}:personas:manager:fixture-content`,
        managerPolicy: `${language}:policies:manager:fixture-content`,
      });
      expect(options).toMatchObject({ cwd: toolCwd, resolution: { provider: 'claude-sdk', model: 'judge-seat', providerOptions: {} } });
      for (const decision of ['allow', 'deny', 'ask']) {
        expect(() => validateStructuredOutputAgainstSchema({ decision, reason: 'fixture' }, schema)).not.toThrow();
      }
      expect(() => validateStructuredOutputAgainstSchema({ decision: 'unknown', reason: 'fixture' }, schema)).toThrow();
    }
  });

  it('uses the Codex manager provider and model when no judge seat is configured', async () => {
    await decide('Bash', { command: 'pwd' }, 'ja', 'codex');
    expect(vi.mocked(executeIsolatedStructuredInternalAgent).mock.calls[0]![3].resolution).toMatchObject({ provider: 'codex', model: 'manager-model' });
  });

  it.each(['ja', 'en'] as const)('turns ask into a reasoned denial and notification in %s', async (language) => {
    vi.mocked(executeIsolatedStructuredInternalAgent).mockResolvedValue(judgment({ decision: 'ask', reason: 'approval needed' }));
    const session = createExecutor('codex', language);
    const onNotification = vi.fn();
    doubles.call.mockImplementationOnce(async (_prompt: string, options: DecisionOptions) => {
      const decision = await handler(options)(request());
      expectDenial(decision);
      expect(decision).toHaveProperty('reason', expect.stringContaining('approval needed'));
      return reply();
    });
    {
      expect((await executeTurn(session, { text: humanInstruction, onNotification })).summary).toBeNull();
      expect(onNotification).toHaveBeenCalledOnce();
      expect(doubles.slack).toHaveBeenCalledOnce();
    }
  });
});
