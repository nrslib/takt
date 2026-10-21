import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Provider, ProviderAgent } from '../../infra/providers/types.js';
import { isStdioServer } from '../../infra/providers/mcp/types.js';
import { readWorkspace, readWorkspaceRegistry } from '../../infra/config/global/workspaceRegistry.js';
import { MANAGER_ASSIGNMENT_ENV, MANAGER_ASSIGNMENT_HEADER } from './assignment.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';
import { managerReadScope, type ManagerReadScope, type ScopedReadRequest } from './readScope.js';

const AssignmentIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository'), repositoryDirectory: z.string().min(1) }),
  z.object({ kind: z.literal('workspace'), workspaceId: z.uuid() }),
]);

async function resolveReadScope(managerDirectory: string, configDirectory: string, sensitivePaths: readonly string[], rawAssignment: string | undefined, assignmentRequired: boolean): Promise<ManagerReadScope | undefined> {
  try {
    if (assignmentRequired && rawAssignment === undefined) return undefined;
    const identity = rawAssignment === undefined ? undefined : AssignmentIdentitySchema.parse(JSON.parse(rawAssignment));
    let roots: readonly string[];
    if (identity?.kind === 'workspace') {
      const workspace = await readWorkspace(configDirectory, identity.workspaceId);
      if (workspace === undefined) return undefined;
      roots = workspace.repositoryDirectories;
    } else {
      const directory = await realpath(identity?.repositoryDirectory ?? managerDirectory);
      const workspaces = await readWorkspaceRegistry(configDirectory);
      roots = [directory];
      for (const workspace of workspaces) {
        if (workspace.repositoryDirectories.includes(directory)
          || await realpath(join(configDirectory, 'workspaces', workspace.id)) === directory) {
          roots = workspace.repositoryDirectories;
          break;
        }
      }
    }
    return { repositoryDirectories: await Promise.all(roots.map((root) => realpath(root))), sensitivePaths };
  } catch {
    // 担当範囲を確定できなければ、読み取りを素通しさせず既存の判断役へ渡す。
    return undefined;
  }
}

export function withManagerReadScope(provider: Provider, managerDirectory: string, configDirectory: string, sensitivePaths: readonly string[]): Provider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'setup') {
        return (...args: Parameters<Provider['setup']>): ProviderAgent => {
          const agent = target.setup(...args);
          return {
            async call(prompt, options) {
              const handler = options.onToolPermissionDecision;
              if (handler === undefined) return agent.call(prompt, options);
              const server = options.mcpServers?.[TAKT_MANAGER_MCP_SERVER_NAME];
              let rawAssignment = server !== undefined && isStdioServer(server) ? server.env?.[MANAGER_ASSIGNMENT_ENV] : undefined;
              if (server?.type === 'http') {
                try {
                  const header = server.headers?.[MANAGER_ASSIGNMENT_HEADER];
                  rawAssignment = header === undefined ? undefined : Buffer.from(header, 'base64url').toString('utf8');
                } catch {
                  // HTTP の割り当てを復号できない要求も、範囲未確定として判断役へ渡す。
                  rawAssignment = undefined;
                }
              }
              return agent.call(prompt, {
                ...options,
                onToolPermissionDecision: async (request) => {
                  const scope = await resolveReadScope(managerDirectory, configDirectory, sensitivePaths, rawAssignment, server?.type === 'http');
                  const scoped: ScopedReadRequest = { ...request, [managerReadScope]: scope };
                  return handler(scoped);
                },
              });
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
