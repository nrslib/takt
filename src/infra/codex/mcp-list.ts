import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface CodexMcpListInput {
  executablePath: string;
  cwd: string;
  env: Record<string, string>;
  configOverrides: readonly string[];
  abortSignal?: AbortSignal;
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
