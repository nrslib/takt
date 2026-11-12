import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ManagerAssignment } from '../manager/startupResolution.js';
import { resolveAssignedProjectRoot } from '../manager/assignment.js';
import * as epics from '../../infra/epics/index.js';
import { epicSchemas, type EpicToolName } from './epicSchemas.js';
import { epicListPage, epicListResult, epicResult } from './epicResponse.js';
import { errorResult } from './operations.js';

export const EPIC_TOOL_NAMES = Object.keys(epicSchemas) as EpicToolName[];
const actions = {
  takt_create_epic: epics.createEpic, takt_get_epic: epics.getEpic,
  takt_update_epic_definition: epics.updateEpicDefinition, takt_add_epic_member: epics.addEpicMember,
  takt_remove_epic_member: epics.removeEpicMember, takt_replace_epic_member: epics.replaceEpicMember,
  takt_refresh_epic_targets: epics.refreshEpicTargets, takt_start_epic_verification: epics.startEpicVerification,
  takt_record_epic_verification_result: epics.recordEpicVerificationResult, takt_complete_epic: epics.completeEpic,
  takt_abort_epic: epics.abortEpic, takt_get_epic_verification_recovery: epics.getEpicVerificationRecovery,
};

export function registerEpicTools(server: McpServer, options: {
  globalConfigDirectory: string;
  currentAssignment(): Promise<ManagerAssignment>;
  withTurn(action: () => Promise<CallToolResult>): Promise<CallToolResult>;
  turnSignal(signal: AbortSignal): AbortSignal;
  changed?(workspaceId: string, epicId: string, reason: string): Promise<void>;
}): void {
  for (const name of EPIC_TOOL_NAMES) server.registerTool(name, {
    title: name,
    description: 'Operate on the current workspace Epic. Mutations require a reason. Verification start only records the run; result registration never completes the Epic. Responses fit 64 KiB with explicit truncation. Use offset/limit for lists and path with textOffset/maxBytes for any saved field.',
    inputSchema: epicSchemas[name],
  }, async (input: z.infer<(typeof epicSchemas)[EpicToolName]>, extra: { signal: AbortSignal }) => {
    try {
      return await options.withTurn(async () => {
        const signal = options.turnSignal(extra.signal);
        signal.throwIfAborted();
        const assignment = await options.currentAssignment();
        if (assignment.kind !== 'workspace') throw new Error('An assigned workspace is required for Epic operations');
        const { cwd, offset, limit, path, textOffset, maxBytes, ...parsedFields } = input;
        const fields: Record<string, unknown> = parsedFields;
        if (assignment.repositoryDirectories.length > 0) await resolveAssignedProjectRoot(cwd, assignment);
        for (const field of ['member', 'replacement'] as const) {
          if (field in fields) {
            const member = fields[field] as epics.EpicMember;
            fields[field] = { ...member, repositoryDirectory: await resolveAssignedProjectRoot(member.repositoryDirectory, assignment) };
          }
        }
        const { reason, ...withoutReason } = 'reason' in fields ? fields : { ...fields, reason: undefined };
        const omitReason = name === 'takt_start_epic_verification' || name === 'takt_complete_epic' || name === 'takt_record_epic_verification_result';
        signal.throwIfAborted();
        if (name === 'takt_list_epics') {
          const responseInput = { offset, limit, path, textOffset, maxBytes };
          const page = await epics.listEpics({ globalConfigDirectory: options.globalConfigDirectory,
            workspaceId: assignment.workspaceId }, epicListPage(responseInput));
          return epicListResult(page, responseInput);
        }
        const value = await actions[name]({ ...(omitReason ? withoutReason : fields),
          globalConfigDirectory: options.globalConfigDirectory, workspaceId: assignment.workspaceId });
        if (typeof reason === 'string' && 'epicId' in fields && options.changed !== undefined) {
          await options.changed(assignment.workspaceId, fields.epicId as string, reason);
        }
        return epicResult(value, { offset, limit, path, textOffset, maxBytes }, typeof reason === 'string' ? { tool: name, reason } : undefined);
      });
    } catch (error) { return errorResult('Epic operation failed', error); }
  });
}
