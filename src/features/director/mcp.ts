import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { packageVersion } from '../../shared/package-info.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { listPendingInquiries } from '../../infra/goals/pending-inquiries.js';
import { DirectorNotificationStore, type DirectorNotification } from '../../infra/conversations/directorNotifications.js';
import { listTaktGoals, getTaktGoal, errorResult } from '../mcp/operations.js';
import { getGoalInputSchema, listGoalsInputSchema } from '../mcp/schemas.js';
import { jsonResult, pagedResult } from '../mcp/response.js';
import { listDirectorManagers, resolveDirectorManager } from './managers.js';
import { tellDirectorManager } from './tellManager.js';
import { directorNotificationTargetSchema, resolveDirectorNotificationSubject } from './notificationTarget.js';

export const DIRECTOR_MCP_SERVER_NAME = 'takt_director';
export const DIRECTOR_TOOL_NAMES = [
  'takt_list_managers', 'takt_list_goals', 'takt_get_goal', 'takt_list_manager_inquiries', 'takt_tell_manager', 'takt_notify_human',
] as const;
export const DIRECTOR_TOOL_ALLOWLIST = DIRECTOR_TOOL_NAMES.map((name) => `mcp__${DIRECTOR_MCP_SERVER_NAME}__${name}`);

export interface DirectorNotifications {
  notify(notification: DirectorNotification): Promise<void>;
}

export function createDirectorMcpServer(configDirectory: string, notifications: DirectorNotifications, signal: AbortSignal, requireNotificationTarget = false): McpServer {
  const server = new McpServer({ name: 'takt-director', version: packageVersion });
  const managerId = z.string().regex(/^manager-[a-f0-9]{64}$/);
  const page = { offset: z.number().int().safe().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() };
  const guarded = <T>(action: (value: T) => Promise<CallToolResult>) => async (value: T): Promise<CallToolResult> => {
    try { signal.throwIfAborted(); return await action(value); }
    catch (error) { return errorResult('Director operation failed', error); }
  };
  server.registerTool('takt_list_managers', { description: 'List every manager assigned to this daemon.', inputSchema: z.object(page).strict() },
    guarded(async (value: { offset?: number; limit?: number }) => {
      const offset = value.offset ?? 0;
      const managers = await listDirectorManagers(configDirectory);
      return pagedResult('managers', managers.slice(offset, offset + (value.limit ?? 50)).map((assignment) => ({
        id: conversationId(assignment), assignment,
      })), managers.length, offset);
    }));
  server.registerTool('takt_list_goals', { description: 'Read saved goals and states of an assigned manager repository.',
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
  server.registerTool('takt_tell_manager', { description: 'Send a message as director through daemon IPC. Busy messages are never queued or resent.',
    inputSchema: z.object({ managerId, text: z.string().min(1) }).strict() }, guarded(async (value: { managerId: string; text: string }) =>
    jsonResult(await tellDirectorManager(configDirectory, value.managerId, value.text, signal))));
  server.registerTool('takt_notify_human', { description: 'Save a director notification and show it in the director conversation. Does not post to Slack.',
    inputSchema: z.object({ message: z.string().min(1), target: directorNotificationTargetSchema.optional() }).strict() },
  guarded(async (value: { message: string; target?: z.infer<typeof directorNotificationTargetSchema> }) => {
    if (requireNotificationTarget && value.target === undefined) throw new Error('Patrol notifications require a target');
    const store = new DirectorNotificationStore(configDirectory);
    const subject = value.target === undefined ? undefined : await resolveDirectorNotificationSubject(configDirectory, value.target);
    signal.throwIfAborted();
    const message = value.target === undefined ? value.message : 'goalId' in value.target
      ? `${value.target.cwd} (${value.target.goalId}): ${value.message}`
      : `${value.target.managerId} (${value.target.inquiryId}): ${value.message}`;
    const notification = subject === undefined ? store.create(message) : store.create(message, subject);
    if (notification === undefined) return jsonResult({ notified: false });
    await notifications.notify(notification);
    return jsonResult(notification);
  }));
  return server;
}
