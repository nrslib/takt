import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { createWorkspaceManagerContext, resolveManagerStartup } from './startupResolution.js';
import { selectOption } from '../../shared/prompt/index.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { mountInk } from '../tui/inkMount.js';
import { toSingleLineText } from '../tui/displayText.js';
import { ConversationIpcClient } from './conversationIpcClient.js';
import { ManagerView } from './ManagerView.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { registerProject } from '../../infra/config/global/projectRegistry.js';

export async function runManager(input: { cwd: string; agentOverrides?: AssistantCliOverrides }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('takt manager requires an interactive terminal');
  }
  const globalConfigDirectory = getGlobalConfigDir();
  const resolution = await resolveManagerStartup(input.cwd, globalConfigDirectory);
  let context;
  if (resolution.kind === 'selection') {
    const lang = resolveConfigValue(input.cwd, 'language');
    if (resolution.workspaces.length === 0) {
      process.stdout.write(lang === 'ja' ? 'workspace がありません。Git リポジトリで takt manager を起動し、担当の追加を依頼してください。\n'
        : 'No workspaces. Start takt manager in a Git repository and ask it to add another repository.\n');
      return;
    }
    const workspaceId = await selectOption(
      lang === 'ja' ? '担当する workspace を選んでください' : 'Select a workspace',
      resolution.workspaces.map((workspace) => ({
        value: workspace.id,
        label: `${toSingleLineText(workspace.name)} (${workspace.repositoryDirectories.length})`,
      })),
    );
    if (workspaceId === null) return;
    const workspace = resolution.workspaces.find((workspace) => workspace.id === workspaceId)!;
    context = createWorkspaceManagerContext(workspace, globalConfigDirectory);
  } else context = resolution.context;
  const { cwd, assignment } = context;
  for (const directory of assignment.repositoryDirectories) {
    await registerProject({ globalConfigDirectory, projectDirectory: directory, command: 'manager', managerUsed: true });
  }
  const identity = assignment.kind === 'workspace' ? { kind: 'workspace' as const, workspaceId: assignment.workspaceId }
    : { kind: 'repository' as const, repositoryDirectory: assignment.repositoryDirectory };
  const client = new ConversationIpcClient(identity, input.agentOverrides);
  try {
    await client.connect();
    await mountInk<void>(({ settle }) => (
      <ManagerView cwd={cwd} assignment={assignment} lang={resolveConfigValue(cwd, 'language')} client={client}
        initialDiagnostics={[]} onExit={() => settle()} />
    ), 'Manager TUI exited before completing its session');
  } catch (error) {
    const notification = await notifyManagerTurnFailure(cwd, undefined, error);
    if (notification !== undefined) process.stderr.write(notification + '\n');
    throw error;
  } finally {
    client.close();
  }
}
