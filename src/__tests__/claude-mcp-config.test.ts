import { access, readFile, rm, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareClaudeMcpConfig } from '../infra/claude/mcp-config.js';

describe('prepareClaudeMcpConfig', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('Given no MCP servers, When preparing config, Then no config path is created', async () => {
    const prepared = await prepareClaudeMcpConfig(undefined);

    expect(prepared.path).toBeUndefined();
    await expect(prepared.cleanup()).resolves.toBeUndefined();
  });

  it('Given MCP servers, When preparing config, Then shared Claude config file is private and cleaned up', async () => {
    const prepared = await prepareClaudeMcpConfig({
      docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
    });
    expect(prepared.path).toMatch(/mcp-config\.json$/);
    tempDirs.push(dirname(prepared.path!));

    const mode = (await stat(prepared.path!)).mode & 0o777;
    const content = JSON.parse(await readFile(prepared.path!, 'utf-8'));

    expect(mode).toBe(0o600);
    expect(content).toEqual({
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
      },
    });

    await prepared.cleanup();
    await expect(access(prepared.path!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Given TMPDIR points to a missing directory, When preparing MCP config, Then mkdtemp succeeds', async () => {
    const originalTmpDir = process.env.TMPDIR;
    const parentDir = mkdtempSync(join(tmpdir(), 'takt-claude-mcp-parent-'));
    const missingTmpDir = join(parentDir, 'missing-tmp');
    tempDirs.push(parentDir);
    process.env.TMPDIR = missingTmpDir;

    try {
      const prepared = await prepareClaudeMcpConfig({
        docs: { type: 'stdio', command: 'docs-mcp' },
      });
      expect(prepared.path).toMatch(/mcp-config\.json$/);
      expect(prepared.path?.startsWith(missingTmpDir)).toBe(true);

      const content = JSON.parse(await readFile(prepared.path!, 'utf-8'));
      expect(content).toEqual({
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp' },
        },
      });

      await prepared.cleanup();
      await expect(access(prepared.path!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
  });
});
