import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import { mountInk } from '../tui/inkMount.js';
import { DirectorView } from './DirectorView.js';

export async function runDirector(_input: { cwd: string; agentOverrides?: AssistantCliOverrides }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('takt director requires an interactive terminal');
  const configDirectory = resolveDaemonConfigDirectory();
  const client = new ConversationIpcClient({ kind: 'daemon' }, _input.agentOverrides);
  try {
    await client.connect();
    await mountInk<void>(({ settle }) => <DirectorView client={client} lang={resolveConfigValue(configDirectory, 'language')} onExit={() => settle()} />,
      'Director TUI exited before completing its session');
  } finally { client.close(); }
}
