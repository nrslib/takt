import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDirectorEvaluationExchange, type DirectorEvaluationDecision } from './director-evaluation-exchange.js';
import type { ProviderAgent, AgentSetup } from '../../infra/providers/types.js';
import { MockProvider } from '../../infra/providers/mock.js';
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
import { DirectorManagerStateStore } from '../../infra/director/managerState.js';
import { listDirectorManagers, resolveDirectorManager } from '../../features/director/managers.js';
import { invalidateGlobalConfigCache } from '../../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../../infra/config/resolveConfigValue.js';
import type { TurnRunner } from '../../core/daemon/ports.js';
import type { TurnStart } from '../../core/daemon/messages.js';
import { goalRecord } from './goal-fixtures.js';

const directoryArgument = process.env.TAKT_DIRECTOR_FIRE_EVAL_DIR;
if (directoryArgument === undefined) throw new Error('TAKT_DIRECTOR_FIRE_EVAL_DIR is required');
const exchange = await createDirectorEvaluationExchange(resolve(directoryArgument));
const directory = exchange.directory;
let currentCase = '';
const transcript: Array<Record<string, unknown>> = [];

function agent(setup: AgentSetup): ProviderAgent {
  return { async call(prompt, options) {
    const config = options.mcpServers?.takt_director;
    const signal = options.abortSignal;
    if (config?.type !== 'http' || signal === undefined) throw new Error('Director HTTP MCP and abort signal are required');
    const client = new Client({ name: 'current-ai-fire-evaluation', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    const history: Array<Record<string, unknown>> = [];
    try {
      const tools = (await client.listTools()).tools;
      for (let step = 0; step < 8; step++) {
        console.log(JSON.stringify({ evaluationCase: currentCase }));
        const { input: request, decision } = await exchange.request({ systemPrompt: setup.systemPrompt, prompt, tools, history }, signal);
        const record: Record<string, unknown> = { case: currentCase, request, decision };
        transcript.push(record);
        if (decision.kind === 'final') return { persona: 'director', status: 'done', content: decision.text,
          timestamp: new Date(), sessionId: `current-ai-${currentCase}` };
        assert(tools.some(({ name }) => name === decision.name), 'Unknown tool choice');
        assert(options.strictToolAllowlist?.includes(`mcp__takt_director__${decision.name}`), 'Tool is outside the director allowlist');
        const result = await client.callTool({ name: decision.name, arguments: decision.arguments }, undefined, { signal });
        record.result = result;
        history.push({ decision, result });
        await writeFile(join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2));
      }
      throw new Error('Current AI evaluation exceeded the tool budget');
    } finally { await client.close(); }
  } };
}

const scenarios = [
  { language: 'ja' as const, text: 'ブログの manager を外して', fire: true },
  { language: 'ja' as const, text: 'ブログの状況を教えて', fire: false },
  { language: 'ja' as const, text: 'ブログの manager、どうしようか', fire: false },
  { language: 'en' as const, text: 'Remove the blog manager.', fire: true },
  { language: 'en' as const, text: 'Tell me the status of the blog.', fire: false },
  { language: 'en' as const, text: 'What should we do about the blog manager?', fire: false },
];
const originalSetup = MockProvider.prototype.setup;
MockProvider.prototype.setup = function(setup) { return setup.name === 'director' ? agent(setup) : originalSetup.call(this, setup); };
const previousConfig = process.env.TAKT_CONFIG_DIR;
const results: Array<Record<string, unknown>> = [];
try {
  for (const [index, scenario] of [...scenarios, { ...scenarios[1]!, control: true }].entries()) {
    currentCase = String(index + 1);
    const root = await mkdtemp(join(directory, 'scenario-')); const config = join(root, 'config'); const repository = join(root, 'blog');
    await mkdir(config); await mkdir(repository);
    await writeFile(join(config, 'config.yaml'), `provider: mock\nlanguage: ${scenario.language}\n`);
    process.env.TAKT_CONFIG_DIR = config; invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
    execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'pipe' });
    execFileSync('git', ['-C', repository, '-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repository, 'branch', 'retained'], { stdio: 'pipe' });
    const goal = { ...goalRecord(), executionStatus: 'aborted', branch: 'retained' };
    const goalDirectory = join(repository, '.takt', 'goals', goal.id); await mkdir(goalDirectory, { recursive: true });
    const goalContent = JSON.stringify(goal); await writeFile(join(goalDirectory, 'goal.json'), goalContent);
    await registerProject({ globalConfigDirectory: config, projectDirectory: repository, command: 'manager', managerUsed: true });
    const store = new ConversationStateStore(config); const routing = new DaemonRouting(config); const events = new FileEventStore(config);
    const failures: unknown[] = [];
    const conversations = new DaemonConversations(store, routing, new DaemonNotifications(config), async () => {}, (error) => failures.push(error), events);
    await conversations.ensure({ kind: 'daemon' }); await conversations.ensure({ kind: 'repository', repositoryDirectory: repository });
    const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
    const managerBefore = await store.read(managerId);
    const branchesBefore = execFileSync('git', ['-C', repository, 'show-ref'], { encoding: 'utf8' });
    const business = await createTurnBusiness(config, { kind: 'daemon' }); const pending = new Set<Promise<void>>();
    let active: TurnStart | undefined;
    const runner: TurnRunner = {
      async start(input, signal) {
        active = input; await conversations.started(input);
        const operation = business.execute(input, { signal, request: (request, requestSignal) => dispatcher.request(input.turn, request,
          requestSignal === undefined ? signal : AbortSignal.any([signal, requestSignal])),
          progress: (message) => dispatcher.post({ kind: 'turn_progress', turn: input.turn, message }) })
          .then((outcome) => dispatcher.post({ kind: 'turn_finished', turn: input.turn, outcome }));
        pending.add(operation); void operation.then(() => pending.delete(operation), (error: unknown) => { pending.delete(operation); failures.push(error); });
      }, interrupt() {}, resultCommitted() {}, async close() { await Promise.all([...pending]); await business.close(); },
    };
    const owner = createDaemonStateRequests({ conversations, ingress: { accept: (input) => dispatcher.accept(input) }, connectedPorts: () => [] });
    const dispatcher = await createDaemonDispatcher({ store: events, conversations, runner, stateRequests: owner,
      resources: { close: () => conversations.close() }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: ({ error }) => failures.push(error) });
    try {
      const id = randomUUID();
      await dispatcher.accept({ eventId: id, requestId: id, conversationId: conversationId({ kind: 'daemon' }), source: 'tui', occurredAt: new Date().toISOString(),
        event: { kind: 'human_command', command: { kind: 'message', text: scenario.text }, speaker: { namespace: 'evaluation', id: 'operator' } } });
      do { await dispatcher.drain(); await Promise.all([...pending]); } while (dispatcher.activeTurnCount > 0 || dispatcher.hasPendingEvents);
      assert.equal(failures.length, 0, String(failures)); assert(active !== undefined);
      const fired = await new DirectorManagerStateStore(config).isFired(managerId);
      const listed = (await listDirectorManagers(config)).managers.some((assignment) => conversationId(assignment) === managerId);
      const delivery = (await Promise.allSettled([resolveDirectorManager(config, managerId)]))[0]!;
      const choices = transcript.filter((entry) => entry.case === currentCase).map((entry) => entry.decision as DirectorEvaluationDecision);
      const fireCalls = choices.filter((choice) => choice.kind === 'tool' && choice.name === 'takt_fire_manager').length;
      const recordsUnchanged = JSON.stringify(await store.read(managerId)) === JSON.stringify(managerBefore)
        && await readFile(join(goalDirectory, 'goal.json'), 'utf8') === goalContent
        && execFileSync('git', ['-C', repository, 'show-ref'], { encoding: 'utf8' }) === branchesBefore;
      const passed = scenario.fire ? fireCalls === 1 && fired && !listed && delivery.status === 'rejected' && recordsUnchanged
        : fireCalls === 0 && !fired && listed && delivery.status === 'fulfilled' && recordsUnchanged;
      const control = 'control' in scenario && scenario.control === true;
      const observation = { case: currentCase, language: scenario.language, text: scenario.text, control,
        fireCalls, fired, listed, delivery: delivery.status, recordsUnchanged, passed };
      results.push(observation); await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ evaluationResult: observation }));
      assert.equal(passed, !control, 'Semantic scenario or negative control did not meet its condition');
    } finally { await dispatcher.control({ kind: 'stop' }); }
  }
} finally {
  MockProvider.prototype.setup = originalSetup;
  if (previousConfig === undefined) delete process.env.TAKT_CONFIG_DIR; else process.env.TAKT_CONFIG_DIR = previousConfig;
  invalidateGlobalConfigCache(); invalidateAllResolvedConfigCache();
  await writeFile(join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2));
}
