import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import { getProvider } from '../../infra/providers/index.js';
import type { AgentResponse } from '../../core/models/response.js';
import type { TurnOutcome, TurnStart } from '../../core/daemon/messages.js';
import type { TurnRunner } from '../../core/daemon/ports.js';
import { createTurnBusiness } from '../../features/daemonTurn/turnBusiness.js';
import { createDaemonDispatcher } from '../../features/daemon/dispatcher.js';
import { createDaemonStateRequests } from '../../features/daemon/stateRequests.js';
import { DaemonConversations } from '../../features/daemon/conversationState.js';
import { DaemonRouting } from '../../features/daemon/routing.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { FileEventStore } from '../../infra/daemon/eventStore.js';
import { DaemonNotifications } from '../../infra/daemon/notifications.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { registerProject } from '../../infra/config/global/projectRegistry.js';
import { GoalStore } from '../../infra/goals/store.js';
import { readManagerEvents } from '../../infra/goals/events.js';
import { listDirectorManagers } from '../../features/director/managers.js';
import { parseDirectorResponse } from '../../features/director/turnResponse.js';
import { invalidateGlobalConfigCache } from '../../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../../infra/config/resolveConfigValue.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { clearTaktEnv, restoreTaktEnv } from './taktEnv.js';
import { managedProviderFor } from '../../infra/managed-providers/definitions.js';
import { checkManagedProviders } from '../../infra/managed-providers/preflight.js';

const providerType = z.enum(PROVIDER_TYPES).parse(process.env.TAKT_DIRECTOR_SELECTION_EVAL_PROVIDER);
assert.notEqual(providerType, 'mock', 'A real provider is required');
const model = z.string().min(1).parse(process.env.TAKT_DIRECTOR_SELECTION_EVAL_MODEL);
const output = resolve(z.string().min(1).parse(process.env.TAKT_DIRECTOR_SELECTION_EVAL_DIR));
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const location = relative(project, output);
assert(location !== '' && location !== '..' && !location.startsWith('../'), 'Evaluation output must be inside the project');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'selection-'));
const savedEnvironment = clearTaktEnv();
const provider = getProvider(providerType);
const originalSetup = provider.setup;
const sourceFiles = ['src/__tests__/helpers/director-selection-evaluation.ts',
  'builtins/ja/facets/instructions/director.md', 'src/features/director/conversationPlan.ts',
  'src/features/director/conversationRuntime.ts', 'src/features/director/turnExecutor.ts',
  'src/features/director/turnResponse.ts', 'src/features/manager/conversationService.ts'];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [path,
  createHash('sha256').update(await readFile(join(project, path))).digest('hex')])));
const results: Array<Record<string, unknown>> = [];
let current: { responses: AgentResponse[]; tools: string[]; toolEvents: string[]; promptHashes: string[] };
let currentScenario: unknown;

// Observe the real provider without replacing its responses or tool decisions.
provider.setup = function(setup) {
  const agent = originalSetup.call(this, setup);
  if (setup.name !== 'director') return agent;
  assert(setup.systemPrompt !== undefined, 'Director system prompt is required');
  current.promptHashes.push(createHash('sha256').update(setup.systemPrompt).digest('hex'));
  return { ...agent, async call(prompt, options) {
    assert.equal(options.model, model);
    const response = await agent.call(prompt, { ...options, onStream(event) {
      if (event.type === 'tool_use' && event.data.tool !== undefined) current.tools.push(event.data.tool);
      if (event.type === 'tool_use' || event.type === 'tool_result') {
        const data = event.type === 'tool_use'
          ? { type: event.type, id: event.data.id, tool: event.data.tool, input: event.data.input }
          : { type: event.type, id: event.data.id, content: event.data.content };
        current.toolEvents.push(sanitizeSensitiveText(JSON.stringify(data)));
      }
      options.onStream?.(event);
    } });
    current.responses.push(response);
    return response;
  } };
};

try {
  const managedProvider = managedProviderFor(providerType);
  const managedConfig = join(output, 'managed');
  await mkdir(managedConfig, { recursive: true });
  process.env.TAKT_CONFIG_DIR = managedConfig;
  await checkManagedProviders([providerType], async () => true);
  const repositories: Record<string, string> = {};
  const gitConfig = join(root, 'gitconfig');
  const gitHooks = join(root, 'git-hooks');
  await writeFile(gitConfig, '');
  await mkdir(gitHooks);
  const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: gitHooks };
  for (const name of ['business-app', 'blog-a', 'blog-b']) {
    const directory = join(root, name);
    await mkdir(directory);
    execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'pipe', env: gitEnvironment });
    execFileSync('git', ['-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.test', '-c', 'commit.gpgSign=false',
      'commit', '--allow-empty', '-m', 'fixture'], { cwd: directory, stdio: 'pipe', env: gitEnvironment });
    repositories[name] = await realpath(directory);
  }
  const scenarios = [
    { name: 'unique', candidates: ['business-app', 'blog-a'], text: 'ブログに記事一覧のページを足して', selected: 'blog-a' },
    { name: 'ambiguous', candidates: ['blog-b', 'blog-a'], text: 'ブログに記事一覧のページを足して', selected: null },
    { name: 'explicit', candidates: ['blog-b', 'blog-a'], text: 'ブログ A に記事一覧のページを足して', selected: 'blog-a' },
  ];
  for (const scenario of scenarios) {
    current = { responses: [], tools: [], toolEvents: [], promptHashes: [] };
    currentScenario = scenario;
    const config = join(root, scenario.name);
    await mkdir(config);
    if (managedProvider !== undefined) await symlink(join(managedConfig, managedProvider), join(config, managedProvider), 'dir');
    await writeFile(join(config, 'config.yaml'), `provider: ${providerType}\nmodel: ${model}\nlanguage: ja\n`);
    process.env.TAKT_CONFIG_DIR = config;
    invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
    for (const candidate of scenario.candidates) await registerProject({ globalConfigDirectory: config,
      projectDirectory: repositories[candidate]!, command: 'manager', managerUsed: true });
    const candidates = await listDirectorManagers(config);
    await writeFile(join(root, 'attempt.json'), JSON.stringify({ scenario, provider: providerType, model, sources, candidates }, null, 2));
    assert.deepEqual(candidates.errors, []);
    assert.equal(candidates.managers.length, 2);
    assert.deepEqual(candidates.managers.flatMap((assignment) => assignment.repositoryDirectories).sort(),
      scenario.candidates.map((name) => repositories[name]!).sort());
    const store = new ConversationStateStore(config);
    const events = new FileEventStore(config);
    const failures: unknown[] = [];
    const conversations = new DaemonConversations(store, new DaemonRouting(config), new DaemonNotifications(config),
      async () => {}, (error) => { failures.push(error); }, events);
    await conversations.ensure({ kind: 'daemon' });
    const business = await createTurnBusiness(config, { kind: 'daemon' });
    const pending = new Set<Promise<void>>();
    let outcome: TurnOutcome | undefined;
    const runner: TurnRunner = {
      async start(input: TurnStart, signal) {
        signal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
        await conversations.started(input);
        const operation = business.execute(input, { signal, request: (request, requestSignal) => dispatcher.request(input.turn,
          request, requestSignal === undefined ? signal : AbortSignal.any([signal, requestSignal])),
        progress: (message) => dispatcher.post({ kind: 'turn_progress', turn: input.turn, message }) })
          .catch((error: unknown): TurnOutcome => {
            failures.push(error);
            return { kind: 'failed', message: sanitizeSensitiveText(String(error)) };
          })
          .then(async (result) => { outcome = result; await dispatcher.post({ kind: 'turn_finished', turn: input.turn, outcome: result }); });
        pending.add(operation);
        void operation.then(() => { pending.delete(operation); }, (error: unknown) => { pending.delete(operation); failures.push(error); });
      }, interrupt() {}, resultCommitted() {}, async close() { await Promise.all([...pending]); await business.close(); },
    };
    const owner = createDaemonStateRequests({ conversations, ingress: { accept: (input) => dispatcher.accept(input) }, connectedPorts: () => [] });
    const dispatcher = await createDaemonDispatcher({ store: events, conversations, runner, stateRequests: owner,
      resources: { close: () => conversations.close() }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 },
      onFailure: ({ error }) => { failures.push(error); } });
    try {
      const id = randomUUID();
      await dispatcher.accept({ eventId: id, requestId: id, conversationId: conversationId({ kind: 'daemon' }), source: 'tui',
        occurredAt: new Date().toISOString(), event: { kind: 'human_command', command: { kind: 'message', text: scenario.text },
          speaker: { namespace: 'evaluation', id: 'operator' } } });
      try {
        do { await dispatcher.drain(); await Promise.all([...pending]); } while (dispatcher.activeTurnCount > 0 || dispatcher.hasPendingEvents);
      } catch (error) { failures.push(error); }
      const state = (await store.read(conversationId({ kind: 'daemon' })))!.state;
      const goals = await Promise.all(scenario.candidates.map(async (candidate) => ({ repositoryDirectory: repositories[candidate],
        ...await new GoalStore(repositories[candidate]!).list(), events: readManagerEvents(repositories[candidate]!) })));
      const raw = current.responses.at(-1);
      let parsed: ReturnType<typeof parseDirectorResponse> | null = null;
      if (raw?.status === 'done') {
        try { parsed = parseDirectorResponse(raw, providerType); }
        catch (error) { failures.push(error); }
      }
      const selected = scenario.selected === null ? null : repositories[scenario.selected]!;
      const conditions = {
        providerSucceeded: failures.length === 0 && parsed !== null && outcome?.kind === 'completed' && outcome.result.kind === 'reply',
        listedManagers: current.tools.some((name) => name.endsWith('takt_list_managers')),
        unregistered: goals.every((entry) => entry.goals.length === 0 && entry.errors.length === 0 && entry.events.length === 0),
        noApproval: state.approval === null,
        proposal: selected === null ? parsed?.summary === null && state.pending === null
          : parsed?.summary?.managerId === conversationId({ kind: 'repository', repositoryDirectory: selected })
            && parsed.summary.repositoryDirectory === selected && state.pending?.managerId === parsed.summary.managerId
            && state.pending.repositoryDirectory === selected,
        candidateReferences: selected !== null || parsed !== null
          && ['blog-a', 'blog-b'].every((name) => parsed.message.includes(repositories[name]!)
            || parsed.message.includes(conversationId({ kind: 'repository', repositoryDirectory: repositories[name]! }))
            || new RegExp(`(?:ブログ\\s*${name.at(-1)}|${name})`, 'iu').test(parsed.message)),
      };
      const result = { scenario, provider: providerType, model, sources, candidates,
        rawResponses: current.responses.map((response) => sanitizeSensitiveText(JSON.stringify({ status: response.status,
          content: response.content, structuredOutput: response.structuredOutput, error: response.error }))),
        tools: current.tools, toolEvents: current.toolEvents, promptHashes: current.promptHashes, pending: state.pending, approval: state.approval, goals,
        outcome: outcome === undefined ? null : sanitizeSensitiveText(JSON.stringify(outcome)),
        failures: failures.map((error) => sanitizeSensitiveText(String(error))), conditions,
        passed: Object.values(conditions).every(Boolean) };
      results.push(result);
      await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ evaluationDirectory: root, scenario: scenario.name, conditions, passed: result.passed }));
      assert(raw?.status === 'done', `Real provider did not complete: ${scenario.name}`);
    } finally { await dispatcher.control({ kind: 'stop' }); }
  }
  assert(results.every((result) => result.passed === true), 'Director selection comparison did not meet its conditions');
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ provider: providerType, model, scenario: currentScenario,
    error: sanitizeSensitiveText(String(error)) }, null, 2));
  throw new Error(`Director selection evaluation failed; see ${root}`);
} finally {
  provider.setup = originalSetup;
  restoreTaktEnv(savedEnvironment);
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
}
