import { access, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
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
});
