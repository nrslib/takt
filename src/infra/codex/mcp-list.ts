import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface CodexMcpListInput {
  executablePath: string;
  cwd: string;
  env: Record<string, string>;
  configOverrides: readonly string[];
  abortSignal?: AbortSignal;
}

const codexPathAliasWarningPrefix = 'WARNING: proceeding, even though we could not create PATH aliases:';

function isMissingCodexMcpServerError(error: unknown, serverName: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 1
    || !('stderr' in error) || typeof error.stderr !== 'string') return false;
  const lines = error.stderr.trim().split(/\r?\n/);
  return lines.at(-1) === `Error: No MCP server named '${serverName}' found.`
    && lines.slice(0, -1).every((line) => line.startsWith(codexPathAliasWarningPrefix));
}

export async function hasCodexMcpServer(input: CodexMcpListInput & { serverName: string; configProfile?: string }): Promise<boolean> {
  try {
    await promisify(execFile)(input.executablePath, [
      ...(input.configProfile === undefined ? [] : ['--profile', input.configProfile]),
      'mcp', 'get', '--json', ...input.configOverrides.flatMap((override) => ['-c', override]), '--', input.serverName,
    ], {
      cwd: input.cwd, env: input.env, signal: input.abortSignal,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    if (isMissingCodexMcpServerError(error, input.serverName)) return false;
    throw new Error('Failed to obtain the effective Codex MCP server configuration');
  }
}

export async function runCodexMcpList(input: CodexMcpListInput): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(input.executablePath, [
      'mcp', 'list', '--json', ...input.configOverrides.flatMap((override) => ['-c', override]),
    ], {
      cwd: input.cwd, env: input.env, signal: input.abortSignal,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    // execFile errors include stdout, stderr and arguments, which can contain credentials.
    throw new Error('Failed to obtain the effective Codex MCP server list');
  }
}
