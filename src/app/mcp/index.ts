#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaktMcpServer } from './server.js';
import { isDirectEntrypoint } from '../../shared/utils/entrypoint.js';

export async function connectTaktMcpServerToStdio(): Promise<void> {
  const server = createTaktMcpServer();
  await server.connect(new StdioServerTransport());
}

if (isDirectEntrypoint(import.meta.url)) {
  connectTaktMcpServerToStdio().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
