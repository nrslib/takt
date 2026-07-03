#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaktMcpServer } from './server.js';

export async function connectTaktMcpServerToStdio(): Promise<void> {
  const server = createTaktMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  connectTaktMcpServerToStdio().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
