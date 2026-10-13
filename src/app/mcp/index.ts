#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaktMcpServer } from './server.js';
import { isDirectEntrypoint } from '../../shared/utils/entrypoint.js';
import { z } from 'zod/v4';
import { GOAL_TURN_OWNERS_ENV } from '../../infra/goals/turn-lock.js';
import { GOAL_EVENT_CONTEXT_ENV } from '../../infra/goals/operations.js';

import { MANAGER_ASSIGNMENT_ENV } from '../../features/manager/assignment.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';

function resolveToolSet(argv: readonly string[]): 'all' | 'read-only' | 'manager' {
  const index = argv.indexOf('--tool-set');
  if (index === -1) {
    return 'all';
  }
  const value = argv[index + 1];
  if (value === 'all' || value === 'read-only' || value === 'manager') {
    return value;
  }
  throw new Error('--tool-set must be "all", "read-only" or "manager"');
}

function shouldIncludeReferenceMarkers(argv: readonly string[]): boolean {
  return argv.includes('--include-reference-markers');
}

export async function connectTaktMcpServerToStdio(): Promise<void> {
  const argv = process.argv.slice(2);
  const toolSet = resolveToolSet(argv);
  const rawAssignment = process.env[MANAGER_ASSIGNMENT_ENV];
  const managerAssignment = toolSet !== 'manager' ? undefined
    : rawAssignment === undefined
      ? { kind: 'repository' as const, repositoryDirectory: await resolveGitRepositoryDirectory(process.cwd()) }
      : z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('repository'), repositoryDirectory: z.string().min(1) }),
        z.object({ kind: z.literal('workspace'), workspaceId: z.uuid() }),
      ]).parse(JSON.parse(rawAssignment));
  const server = createTaktMcpServer({}, {
    toolSet, managerAssignment,
    includeReferenceMarkers: shouldIncludeReferenceMarkers(argv),
    goalTurnOwners: process.env[GOAL_TURN_OWNERS_ENV] === undefined ? undefined
      : z.record(z.uuid(), z.uuid()).parse(JSON.parse(process.env[GOAL_TURN_OWNERS_ENV]!)),
    goalEventContext: process.env[GOAL_EVENT_CONTEXT_ENV] === undefined ? undefined
      : z.object({ goalId: z.uuid(), eventId: z.string().min(1) }).strict().parse(JSON.parse(process.env[GOAL_EVENT_CONTEXT_ENV]!)),
  });
  await server.connect(new StdioServerTransport());
}

if (isDirectEntrypoint(import.meta.url)) {
  connectTaktMcpServerToStdio().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
