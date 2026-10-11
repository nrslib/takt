import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

function resolveBundledCli(): string {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform === 'android' ? 'linux' : process.platform}-${process.arch}`;
  const report = (process.platform === 'linux' ? process.report?.getReport() : undefined) as
    { header: { glibcVersionRuntime?: string } } | undefined;
  const musl = report !== undefined && report.header.glibcVersionRuntime === undefined;
  const packages = process.platform === 'android' ? [`${base}-android`]
    : process.platform === 'linux' ? (musl ? [`${base}-musl`, base] : [base, `${base}-musl`])
    : [base];
  // Match the SDK's optional native-package selection without starting a query.
  for (const name of packages) {
    let path: string;
    try {
      path = sdkRequire.resolve(`${name}/claude${process.platform === 'win32' ? '.exe' : ''}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    if (existsSync(path)) return path;
  }
  throw new Error('Claude SDK native CLI is missing. Reinstall with optional dependencies or configure claude_cli_path.');
}

export async function assertClaudeSdkRuntime(options: Options, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();
  const path = options.pathToClaudeCodeExecutable || resolveBundledCli();
  const isScript = ['.js', '.mjs', '.tsx', '.ts', '.jsx'].some((extension) => path.endsWith(extension));
  const help = await new Promise<string>((resolve, reject) => {
    execFile(isScript ? process.execPath : path, [...(isScript ? [path] : []), '--help'], {
      cwd: options.cwd,
      env: options.env,
      signal: abortSignal,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error('Cannot inspect Claude SDK CLI before startup', { cause: error }));
      else resolve(`${stdout}\n${stderr}`);
    });
  });
  const flags = [
    ...(options.tools !== undefined ? ['--tools'] : []),
    ...(options.strictMcpConfig === true ? ['--strict-mcp-config'] : []),
    ...(options.outputFormat !== undefined ? ['--json-schema'] : []),
  ];
  for (const flag of flags) {
    if (!help.includes(flag)) throw new Error(`Claude SDK CLI does not support required option ${flag}`);
  }
}
