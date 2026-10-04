import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerConfig } from '../../core/models/index.js';
import { ensureCurrentTmpDirExists } from '../../shared/utils/index.js';

export interface PreparedClaudeMcpConfig {
  path?: string;
  cleanup: () => Promise<void>;
}

const emptyCleanup = async (): Promise<void> => {};

export async function prepareClaudeMcpConfig(
  mcpServers: Record<string, McpServerConfig> | undefined,
): Promise<PreparedClaudeMcpConfig> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return { cleanup: emptyCleanup };
  }

  const tempDir = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-claude-mcp-'));
  const configPath = join(tempDir, 'mcp-config.json');

  try {
    await chmod(tempDir, 0o700);
    await writeFile(configPath, JSON.stringify({ mcpServers }), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: configPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
