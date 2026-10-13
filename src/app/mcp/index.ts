#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { createTaktMcpServer } from './server.js';
import { isDirectEntrypoint } from '../../shared/utils/entrypoint.js';
import { z } from 'zod/v4';
import { GOAL_TURN_OWNERS_ENV } from '../../infra/goals/turn-lock.js';
import { GOAL_EVENT_CONTEXT_ENV } from '../../infra/goals/operations.js';

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

function readGoalConfirmationPublicKey(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--goal-confirmation-public-key');
  if (index === -1) return undefined;
  const filePath = argv[index + 1];
  if (!filePath || filePath.startsWith('--')) {
    throw new Error('--goal-confirmation-public-key requires a PEM file path');
  }
  const pem = readFileSync(filePath, 'utf8');
  if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') {
    throw new Error('Goal confirmation requires an Ed25519 public key');
  }
  return pem;
}

export async function connectTaktMcpServerToStdio(): Promise<void> {
  const argv = process.argv.slice(2);
  const server = createTaktMcpServer({}, {
    toolSet: resolveToolSet(argv),
    goalConfirmationPublicKey: readGoalConfirmationPublicKey(argv),
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
