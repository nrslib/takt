#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaktMcpServer } from './server.js';
import { isDirectEntrypoint } from '../../shared/utils/entrypoint.js';

function resolveToolSet(argv: readonly string[]): 'all' | 'read-only' {
  const index = argv.indexOf('--tool-set');
  if (index === -1) {
    return 'all';
  }
  const value = argv[index + 1];
  if (value === 'all' || value === 'read-only') {
    return value;
  }
  throw new Error('--tool-set must be "all" or "read-only"');
}

function shouldIncludeReferenceMarkers(argv: readonly string[]): boolean {
  return argv.includes('--include-reference-markers');
}

export async function connectTaktMcpServerToStdio(): Promise<void> {
  const argv = process.argv.slice(2);
  const server = createTaktMcpServer({}, {
    toolSet: resolveToolSet(argv),
    includeReferenceMarkers: shouldIncludeReferenceMarkers(argv),
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
