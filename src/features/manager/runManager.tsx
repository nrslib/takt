import { realpathSync } from 'node:fs';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { mountInk } from '../tui/inkMount.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { createManagerConversationSession, managerOutputSchema } from './conversationSession.js';
import type { ManagerConversationSession } from './conversationSession.js';
import { createGoalConfirmation } from './goalConfirmation.js';
import { connectManagerMcp } from './managerMcp.js';
import { ManagerView } from './ManagerView.js';
import { recoverManagerEvents } from './completionTurn.js';
import { ensureManagerRun } from './autoRun.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export async function runManager(input: { cwd: string; agentOverrides?: AssistantCliOverrides }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('takt manager requires an interactive terminal');
  }
  const cwd = realpathSync(input.cwd);
  const plan = createManagerConversationPlan(cwd, input.agentOverrides ?? {});
  const confirmation = createGoalConfirmation(cwd);
  const mcp = await connectManagerMcp(cwd, confirmation.publicKey);
  let session: ManagerConversationSession | undefined;
  let startupTask: Promise<readonly string[]> | undefined;
  try {
    await plan.ctx.provider.preflight?.({
      cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
      allowedTools: plan.strategy.allowedTools,
      mcpOnlySideEffects: plan.strategy.allowedTools,
      permissionMode: 'readonly', mcpServers: mcp.servers,
      outputSchema: managerOutputSchema,
    });
    session = createManagerConversationSession({
      cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } },
      confirmation, mcpClient: mcp.client,
      agentOverrides: input.agentOverrides,
    });
    const viewSession = session;
    await mountInk<void>(({ settle, fail }) => (
      <ManagerView cwd={cwd} lang={plan.ctx.lang} session={viewSession}
        initialDiagnostics={[]} onExit={() => settle()} startup={{
          run: (signal) => {
            startupTask = (async () => {
              const diagnostics: string[] = [];
              try {
                await recoverManagerEvents(cwd, {}, signal);
              } catch (error) {
                diagnostics.push(sanitizeSensitiveText(getErrorMessage(error)));
              }
              if (signal.aborted) return [];
              await ensureManagerRun(cwd);
              return diagnostics;
            })();
            return startupTask;
          },
          fail,
        }} />
    ), 'Manager TUI exited before completing its session');
  } finally {
    // Recovery owns separate MCP resources and must finish teardown before the session closes.
    try { await startupTask; }
    finally {
      try { await session?.close(); } finally { await mcp.dispose(); }
    }
  }
}
