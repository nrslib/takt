import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { firstTextContent } from './helpers/mcp-content.js';
import { confirmationKeys, confirmationPayload, goalId, goalInput, signedConfirmation } from './helpers/goal-fixtures.js';

describe('Goal MCP stdio entrypoint', () => {
  it.each(['source', 'dist'] as const)('propagates the host public key from the %s stdio entrypoint to goal creation', async (entrypoint) => {
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    const cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'goal-mcp-stdio-')));
    const keys = confirmationKeys();
    const publicKeyPath = join(cwd, 'confirmation.pub');
    writeFileSync(publicKeyPath, keys.publicKey);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
      GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
    };
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, env, stdio: 'pipe' });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, env, input: '', encoding: 'utf-8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'goal fixture'], { cwd, env, encoding: 'utf-8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd, env });
    const client = new Client({ name: 'goal-stdio-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...(entrypoint === 'source' ? [
          'node_modules/.bin/vite-node', '--config', 'src/__tests__/helpers/vite-node.config.ts',
          'src/__tests__/helpers/mcp-source-stdio-entrypoint.ts',
        ] : ['dist/app/mcp/index.js']),
        '--goal-confirmation-public-key', publicKeyPath,
      ],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR!,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM!,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
      },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_create_goal');
      const result = await client.callTool({ name: 'takt_create_goal', arguments: {
        cwd, ...goalInput(), confirmation: signedConfirmation(confirmationPayload(cwd), keys.privateKey),
      } });
      expect(result.isError).toBeUndefined();
      const created = (JSON.parse(firstTextContent(result.content)) as { goal: { id: string; branch: string } }).goal;
      expect(created.id).toBe(goalId);
      expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(created);
      expect(execFileSync('git', ['rev-parse', `refs/heads/${created.branch}`], { cwd, env, encoding: 'utf-8' }).trim()).toBe(commit);
    } finally {
      await client.close();
      await transport.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
