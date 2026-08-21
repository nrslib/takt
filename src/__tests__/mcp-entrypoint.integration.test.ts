import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const SOURCE_STDIO_ENTRYPOINT_RUNNER = 'src/__tests__/helpers/mcp-source-stdio-entrypoint.ts';

describe('MCP stdio entrypoint integration', () => {
  it('Given the source MCP entrypoint, When a stdio MCP client lists and calls tools, Then stdout remains valid MCP protocol', async () => {
    const cwd = mkdtempSync(join(process.cwd(), '.tmp-takt-mcp-stdio-'));
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'branch_name_strategy: romaji\n', 'utf-8');
    const client = new Client({ name: 'takt-mcp-stdio-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        'node_modules/.bin/vite-node',
        // --script mode ignores --config, so run in normal mode: the config
        // sets an esbuild target that lowers `using` declarations, which raw
        // Node < 24 cannot parse.
        '--config',
        'src/__tests__/helpers/vite-node.config.ts',
        SOURCE_STDIO_ENTRYPOINT_RUNNER,
      ],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        // Keep the spawned MCP server hermetic: without this it falls back to
        // the operator's real ~/.takt/config.yaml.
        ...(process.env.TAKT_CONFIG_DIR !== undefined
          ? { TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR }
          : {}),
      },
      stderr: 'pipe',
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Enqueue through the stdio MCP server',
          workflow: 'default',
          autoPr: false,
        },
      });

      expect(tools.tools.map((tool) => tool.name)).toEqual(['takt_enqueue_task']);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(String(result.content[0]?.text))).toEqual(expect.objectContaining({
        tasksFile: join(cwd, '.takt', 'tasks.yaml'),
        workflow: 'default',
      }));
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      expect(stderr).not.toMatch(/(?:^|\n)(?:Error|TypeError|ReferenceError|SyntaxError):/u);
      expect(stderr).not.toMatch(/(?:^|\n)\s+at\s+/u);
    } finally {
      await client.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
