import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { resolveCurrentManagerAssignment } from '../manager/assignment.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { ListGoalRegistrationProposalsInput } from './schemas.js';

export async function listTaktGoalRegistrationProposals(
  input: ListGoalRegistrationProposalsInput, deps: McpOperationDependencies,
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const repositoryDirectory = await resolveGitRepositoryDirectory(input.cwd);
    const assignment = await resolveCurrentManagerAssignment(
      { kind: 'repository', repositoryDirectory }, getGlobalConfigDir());
    const store = new ConversationStateStore(await resolveDaemonConfigDirectory(getGlobalConfigDir()));
    const pending = (await store.read(conversationId(assignment)))?.record.pending ?? null;
    return jsonResult({ proposals: pending === null ? [] : [pending] });
  } catch (error) { return errorResult('Goal registration proposal list failed', error); }
}

