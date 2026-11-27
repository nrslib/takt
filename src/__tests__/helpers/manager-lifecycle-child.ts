import { FileAsyncLock } from '../../infra/daemon/lock.js';
import { DirectorManagerStateStore } from '../../infra/director/managerState.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { ConversationAssignmentSchema } from '../../infra/conversations/schema.js';
import { fireDirectorManager } from '../../features/director/managerLifecycle.js';
import { DaemonRouting } from '../../features/daemon/routing.js';
import { managerApproval } from './manager-approval.js';
import { GoalStore } from '../../infra/goals/store.js';
import { goalId, goalInput } from './goal-fixtures.js';

const [config, serialized, repository, mode] = process.argv.slice(2);
if (config === undefined || serialized === undefined || repository === undefined) throw new Error('Missing child arguments');
const identity = ConversationAssignmentSchema.parse(JSON.parse(serialized));
if (identity.kind === 'daemon') throw new Error('Expected manager');
const id = conversationId(identity);
const send = (kind: string, extra: Record<string, unknown> = {}) => process.send!({ kind, ...extra });
const acquire = FileAsyncLock.prototype.acquire;
FileAsyncLock.prototype.acquire = async function(path, options) {
  send('attempt', { path });
  const release = await acquire.call(this, path, options);
  send('acquired', { path, fired: await new DirectorManagerStateStore(config).isFired(id) });
  if ((mode === 'add-paused' || mode === 'remove-paused') && path.includes('assignment-locks')
    && path.endsWith(`${conversationId({ kind: 'repository', repositoryDirectory: repository })}.lock`)) {
    const resume = new Promise<void>((resolve) => process.once('message', () => resolve()));
    send('assignment-ready'); await resume;
  }
  return async () => { await release(); send('released', { path }); };
};
const display = DaemonRouting.prototype.display;
DaemonRouting.prototype.display = async function(...args) {
  const value = await display.apply(this, args);
  send('members', { directories: value.repositoryDirectories });
  return value;
};
const setFired = DirectorManagerStateStore.prototype.setFired;
DirectorManagerStateStore.prototype.setFired = async function(...args) {
  send('saving-fired', { managerId: args[0], fired: args[1] });
  await setFired.apply(this, args);
  send('saved-fired', { managerId: args[0], fired: args[1] });
};
try {
  if (mode === 'fire') {
    try {
      await fireDirectorManager(new DaemonRouting(config), id, new AbortController().signal);
      send('result', { fired: true });
    } catch (error) { send('result', { fired: false, error: String(error) }); }
  } else if (mode === 'create' || mode === 'add' || mode === 'add-paused' || mode === 'remove-paused') {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createTaktMcpServer } = await import('../../features/mcp/server.js');
    const create = GoalStore.prototype.create;
    GoalStore.prototype.create = async function(...args) {
      const goal = await create.apply(this, args);
      send('saved', { fired: await new DirectorManagerStateStore(config).isFired(id) });
      return goal;
    };
    const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
    const server = createTaktMcpServer({}, mode === 'create'
      ? { allowedProjectRoot: repository, toolSet: 'all' }
      : { toolSet: 'manager', managerAssignment: identity });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      send('received');
      const result = await client.callTool(mode === 'create'
        ? { name: 'takt_create_goal', arguments: { cwd: repository, id: goalId, ...goalInput() } }
        : { name: mode === 'remove-paused' ? 'takt_remove_workspace_repository' : 'takt_add_workspace_repository', arguments: { repositoryDirectory: repository } });
      send('result', { result, failed: result.isError === true });
    } finally { await client.close(); await server.close(); }
  } else {
    const approve = managerApproval(config, identity, repository, new AbortController().signal, () => send('reserved'));
    send('result', { outcome: await approve.run() });
  }
} finally { process.disconnect!(); }
