import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { createWorkspaceManagerContext, resolveManagerStartup } from './startupResolution.js';
import { selectOption } from '../../shared/prompt/index.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { mountInk } from '../tui/inkMount.js';
import { toSingleLineText } from '../tui/displayText.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { createManagerConversationSession, getManagerOutputSchema } from './conversationSession.js';
import type { ManagerConversationSession } from './conversationSession.js';
import { connectManagerMcp } from './managerMcp.js';
import { ManagerView } from './ManagerView.js';
import { ensureManagerRun } from './autoRun.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { registerProject } from '../../infra/config/global/projectRegistry.js';
import { ensureDaemon } from '../daemon/lifecycle.js';

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
  await ensureDaemon();
  const plan = createManagerConversationPlan(cwd, input.agentOverrides ?? {});
  const mcp = await connectManagerMcp(cwd, assignment);
  let session: ManagerConversationSession | undefined;
  let startupTask: Promise<readonly string[]> | undefined;
  try {
    await plan.ctx.provider.preflight?.({
      cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
      allowedTools: plan.strategy.allowedTools,
      mcpOnlySideEffects: plan.strategy.allowedTools,
      permissionMode: 'readonly', mcpServers: mcp.servers,
      outputSchema: getManagerOutputSchema(plan.ctx.providerType),
    });
    session = createManagerConversationSession({
      cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } },
      agentOverrides: input.agentOverrides, assignment,
    });
    const viewSession = session;
    await mountInk<void>(({ settle, fail }) => (
      <ManagerView cwd={cwd} assignment={assignment} lang={plan.ctx.lang} session={viewSession}
        initialDiagnostics={[]} onExit={() => settle()} startup={{
          run: (signal) => {
            startupTask = (async () => {
              const diagnostics: string[] = [];
              if (signal.aborted) return [];
              for (const directory of assignment.repositoryDirectories) await ensureManagerRun(directory);
              return diagnostics;
            })();
            return startupTask;
          },
          fail,
        }} />
    ), 'Manager TUI exited before completing its session');
  } catch (error) {
    const notification = await notifyManagerTurnFailure(cwd, undefined, error);
    if (notification !== undefined) process.stderr.write(`${notification}\n`);
    throw error;
  } finally {
    try { await startupTask; }
    finally {
      try { await session?.close(); } finally {
        try { await mcp.dispose(); } finally {
          const current = await session?.getAssignment();
          for (const directory of current?.repositoryDirectories ?? assignment.repositoryDirectories) await ensureManagerRun(directory);
        }
      }
    }
  }
}
