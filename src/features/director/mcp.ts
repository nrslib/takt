import type { TurnToolScope } from '../daemonTurn/toolScope.js';
import { isAbsolute } from 'node:path';
import { resolveGitRepositoryDirectory } from '../../infra/task/gitRepositoryDirectory.js';
import { acquireRepositoryAssignmentLocks } from '../../infra/conversations/assignmentLock.js';
import type { McpResponseResources } from '../mcp/responseResources.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { CallToolResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { packageVersion } from '../../shared/package-info.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { listPendingInquiries } from '../../infra/goals/pending-inquiries.js';
import type { DirectorNotificationSubject } from '../../infra/daemon/notifications.js';
import { listTaktGoals, getTaktGoal, errorResult } from '../mcp/operations.js';
import { getGoalInputSchema, listGoalsInputSchema } from '../mcp/schemas.js';
import { jsonResult, pagedResult } from '../mcp/response.js';
import { listDirectorManagers, resolveDirectorManager } from './managers.js';
import { directorNotificationTargetSchema, resolveDirectorNotificationSubject } from './notificationTarget.js';
import { DirectorMessageOriginSchema, type DirectorMessageOrigin } from '../../infra/conversations/schema.js';

export const DIRECTOR_MCP_SERVER_NAME = 'takt_director';
export const DIRECTOR_TOOL_NAMES = [
  'takt_add_manager', 'takt_fire_manager',
  'takt_list_managers', 'takt_list_goals', 'takt_get_goal', 'takt_list_manager_inquiries', 'takt_tell_manager', 'takt_notify_human',
] as const;
export const DIRECTOR_TOOL_ALLOWLIST = DIRECTOR_TOOL_NAMES.map((name) => `mcp__${DIRECTOR_MCP_SERVER_NAME}__${name}`);

export interface DirectorStateActions {
  authorizeAddManager(): void;
  addManager(repositoryDirectory: string, signal: AbortSignal): Promise<{ managerId: string }>;
  fireManager(managerId: string, signal: AbortSignal): Promise<{ managerId: string }>;
  tellManager(managerId: string, text: string, origin: DirectorMessageOrigin): Promise<Record<string, unknown>>;
  notifyHuman(message: string, subject?: DirectorNotificationSubject): Promise<{ id: string; message: string }>;
}

export function createDirectorMcpServer(configDirectory: string, actions: DirectorStateActions, signal: AbortSignal,
  responses: McpResponseResources, turnScope?: TurnToolScope): McpServer {
  const server = new McpServer({ name: 'takt-director', version: packageVersion });
  const addInput = z.object({ repositoryDirectory: z.string().min(1) }).strict();
  type PreparedRepository = { suppliedDirectory: string; directory: string } | { error: unknown };
  const repositories = new Map<RequestId, PreparedRepository>();
  const requests = responses.bind(server, signal, async (messages, active, retain) => {
    const prepared: Array<[RequestId, PreparedRepository]> = [];
    await retain('director-prepared-requests', async () => async () => {
      for (const [id, value] of prepared) if (repositories.get(id) === value) repositories.delete(id);
    });
    for (const message of messages) {
      if (message.method !== 'tools/call' || message.params?.name !== 'takt_add_manager') continue;
      let value: PreparedRepository;
      try {
        const input = addInput.parse(message.params.arguments);
        if (!isAbsolute(input.repositoryDirectory)) throw new Error('Repository directory must be an absolute path');
        actions.authorizeAddManager();
        value = { suppliedDirectory: input.repositoryDirectory, directory: await resolveGitRepositoryDirectory(input.repositoryDirectory) };
      } catch (error) { value = { error }; }
      prepared.push([message.id, value]); repositories.set(message.id, value);
    }
    const directories = prepared.flatMap(([, value]) => 'directory' in value ? [value.directory] : []);
    if (directories.length === 0) return;
    try { await retain('director-assignment-locks', () => acquireRepositoryAssignmentLocks(configDirectory, directories, active)); }
    catch (error) {
      for (const entry of prepared) if ('directory' in entry[1]) { entry[1] = { error }; repositories.set(entry[0], entry[1]); }
    }
  });
  const managerId = z.string().regex(/^manager-[a-f0-9]{64}$/);
  const page = { offset: z.number().int().safe().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() };
  const guarded = <T>(action: (value: T, requestSignal: AbortSignal, requestId: RequestId) => Promise<CallToolResult>) => async (value: T, extra: { requestId: RequestId }): Promise<CallToolResult> => {
    try {
      const execute = async () => { signal.throwIfAborted(); return requests.run(extra.requestId, (active) => action(value, active, extra.requestId)); };
      return await (turnScope === undefined ? execute() : turnScope.run(execute));
    }
    catch (error) { return errorResult('Director operation failed', error); }
  };
  server.registerTool('takt_add_manager', { description: 'Prepare or restore a manager for the Git repository at the absolute path supplied by the human. Return its managerId without creating a goal.',
    inputSchema: addInput },
  guarded(async (_value: { repositoryDirectory: string }, active, requestId) => {
    const prepared = repositories.get(requestId);
    if (prepared === undefined) throw new Error('Manager request was not prepared');
    if ('error' in prepared) throw prepared.error;
    active.throwIfAborted();
    return jsonResult(await actions.addManager(prepared.suppliedDirectory, active));
  }));
  server.registerTool('takt_fire_manager', { description: 'Remove a manager from the director list only on a human request. Refuse when any assigned goal is unfinished. Preserve repositories, goals, branches, and conversations.',
    inputSchema: z.object({ managerId }).strict() },
  guarded(async (value: { managerId: string }, active) => jsonResult(await actions.fireManager(value.managerId, active))));
  server.registerTool('takt_list_managers', { description: 'List every manager assigned to this daemon.', inputSchema: z.object(page).strict() },
    guarded(async (value: { offset?: number; limit?: number }) => {
      const offset = value.offset ?? 0;
      const { managers, errors } = await listDirectorManagers(configDirectory);
      return pagedResult('managers', managers.slice(offset, offset + (value.limit ?? 50)).map((assignment) => ({
        id: conversationId(assignment), assignment,
      })), managers.length, offset, false, { errors });
    }));
  server.registerTool('takt_list_goals', { description: 'Read saved goals and states of an assigned manager repository. Optional state selects open, finished (completed or aborted) or all goals (default all).',
    inputSchema: listGoalsInputSchema.extend({ managerId }).strict() }, guarded(async (value: z.infer<typeof listGoalsInputSchema> & { managerId: string }) => {
    const assignment = await resolveDirectorManager(configDirectory, value.managerId);
    if (!assignment.repositoryDirectories.includes(value.cwd)) throw new Error('Repository is outside manager assignment');
    return listTaktGoals(value, { readOnly: true, allowedProjectRoot: value.cwd });
  }));
  server.registerTool('takt_get_goal', { description: 'Read saved goal detail; never read run internals.',
    inputSchema: getGoalInputSchema.extend({ managerId }).strict() }, guarded(async (value: z.infer<typeof getGoalInputSchema> & { managerId: string }) => {
    const assignment = await resolveDirectorManager(configDirectory, value.managerId);
    if (!assignment.repositoryDirectories.includes(value.cwd)) throw new Error('Repository is outside manager assignment');
    return getTaktGoal(value, { readOnly: true, allowedProjectRoot: value.cwd });
  }));
  server.registerTool('takt_list_manager_inquiries', { description: 'Read pending human inquiries of an assigned manager.',
    inputSchema: z.object({ managerId, ...page }).strict() }, guarded(async (value: { managerId: string; offset?: number; limit?: number }) => {
    const assignment = await resolveDirectorManager(configDirectory, value.managerId);
    const offset = value.offset ?? 0;
    const result = await listPendingInquiries(configDirectory, assignment);
    return pagedResult('inquiries', result.inquiries.slice(offset, offset + (value.limit ?? 50)), result.inquiries.length, offset,
      result.errors.length > 0, { errors: result.errors.map(({ repositoryDirectory, goalId }) => ({ repositoryDirectory, goalId })) });
  }));
  server.registerTool('takt_tell_manager', { description: 'Save a message for a manager through daemon IPC and return accepted with operationId and managerId immediately. Saved messages are processed in order. Replies, failures, and interruptions appear later as director notifications with the same operationId. Acceptance does not mean a requested merge succeeded. Never automatically resend an accepted message.',
    inputSchema: z.object({ managerId, text: z.string().min(1), origin: DirectorMessageOriginSchema.describe('Use director for your own request. Use human only to relay an instruction received from a person; put that instruction in text and keep your own requests separate.') }).strict() }, guarded(async (value: { managerId: string; text: string; origin: DirectorMessageOrigin }) => {
    await resolveDirectorManager(configDirectory, value.managerId);
    signal.throwIfAborted();
    return jsonResult(await actions.tellManager(value.managerId, value.text, value.origin));
  }));
  server.registerTool('takt_notify_human', { description: 'Save a director notification and show it in the director conversation. New notifications from this turn are grouped into one post when director Slack is configured.',
    inputSchema: z.object({ message: z.string().min(1), target: directorNotificationTargetSchema.optional() }).strict() },
  guarded(async (value: { message: string; target?: z.infer<typeof directorNotificationTargetSchema> }) => {
    const subject = value.target === undefined ? undefined : await resolveDirectorNotificationSubject(configDirectory, value.target);
    signal.throwIfAborted();
    const message = value.target === undefined ? value.message : 'goalId' in value.target
      ? `${value.target.cwd} (${value.target.goalId}): ${value.message}`
      : `${value.target.managerId} (${value.target.inquiryId}): ${value.message}`;
    const notification = await actions.notifyHuman(message, subject);
    return jsonResult(notification);
  }));
  return server;
}
