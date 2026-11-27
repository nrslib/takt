import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasCodexMcpServer } from '../infra/codex/mcp-list.js';

describe('hasCodexMcpServer', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-codex-mcp-list-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function setCliStderr(stderr: string): void {
    writeFileSync(join(cwd, 'mcp'), `process.stderr.write(${JSON.stringify(stderr)});\nprocess.exitCode = 1;\n`);
  }

  function queryServer(): Promise<boolean> {
    return hasCodexMcpServer({
      executablePath: process.execPath,
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
      configOverrides: [],
      serverName: 'datadog',
    });
  }

  it('returns false when the server is missing', async () => {
    setCliStderr("Error: No MCP server named 'datadog' found.\n");

    await expect(queryServer()).resolves.toBe(false);
  });

  it('ignores the non-fatal PATH alias warning before a missing-server error', async () => {
    setCliStderr('WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp" (codex_home: AbsolutePathBuf("/tmp/codex-home"))\n'
      + "Error: No MCP server named 'datadog' found.\n");

    await expect(queryServer()).resolves.toBe(false);
  });

  it('fails closed when Codex reports an unrelated error', async () => {
    setCliStderr('Error: Failed to load configuration.\n');

    await expect(queryServer()).rejects.toThrow('Failed to obtain the effective Codex MCP server configuration');
  });
});
