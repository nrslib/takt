import { realpathSync } from 'node:fs';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { mountInk } from '../tui/inkMount.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { createManagerConversationSession } from './conversationSession.js';
import type { ManagerConversationSession } from './conversationSession.js';
import { createGoalConfirmation } from './goalConfirmation.js';
import { connectManagerMcp } from './managerMcp.js';
import { ManagerView } from './ManagerView.js';

export async function runManager(input: { cwd: string; agentOverrides?: AssistantCliOverrides }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('takt manager requires an interactive terminal');
  }
  const cwd = realpathSync(input.cwd);
  const plan = createManagerConversationPlan(cwd, input.agentOverrides ?? {});
  const confirmation = createGoalConfirmation(cwd);
  const mcp = await connectManagerMcp(cwd, confirmation.publicKey);
  let session: ManagerConversationSession | undefined;
  try {
    session = createManagerConversationSession({
      cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } },
      confirmation, mcpClient: mcp.client,
    });
    const viewSession = session;
    await mountInk<void>(({ settle }) => (
      <ManagerView cwd={cwd} lang={plan.ctx.lang} session={viewSession} onExit={() => settle()} />
    ), 'Manager TUI exited before completing its session');
  } finally {
    try { await session?.close(); } finally { await mcp.dispose(); }
  }
}
