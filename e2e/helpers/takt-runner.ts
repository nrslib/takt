import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TaktRunOptions {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
}

export interface TaktRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT = 180_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_TRANSIENT_RETRIES = 4;

function isTransientProviderFailure(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`;
  return output.includes('stream disconnected before completion')
    || output.includes('Reconnecting...')
    || output.includes('error sending request for url (https://chatgpt.com/backend-api/codex/responses)');
}

function getTaktBinPath(): string {
  return resolve(__dirname, '../../bin/takt');
}

/**
 * Prepend --provider <provider> to args if provider is specified
 * and args do not already contain --provider.
 */
export function injectProviderArgs(
  args: readonly string[],
  provider: string | undefined,
): string[] {
  if (provider && !args.includes('--provider')) {
    return ['--provider', provider, ...args];
  }
  return [...args];
}

/**
 * Run the takt CLI and return its result.
 * Non-zero exit codes are returned in the result (not thrown).
 *
 * When TAKT_E2E_PROVIDER env var is set, it automatically prepends
 * --provider <provider> to the args (unless args already contain --provider).
 */
export function runTakt(options: TaktRunOptions): TaktRunResult {
  const binPath = getTaktBinPath();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const args = injectProviderArgs(options.args, process.env.TAKT_E2E_PROVIDER);
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const stdout = execFileSync('node', [binPath, ...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf-8',
        input: options.input,
        timeout,
        maxBuffer: MAX_BUFFER,
      });

      return {
        stdout,
        stderr: '',
        exitCode: 0,
      };
    } catch (error: unknown) {
      // execFileSync throws on non-zero exit or timeout
      const err = error as {
        stdout?: string;
        stderr?: string;
        status?: number | null;
        signal?: string | null;
      };

      if (err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
        throw new Error(`takt process timed out after ${timeout}ms`);
      }

      const result: TaktRunResult = {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: err.status ?? 1,
      };

      if (attempt < MAX_TRANSIENT_RETRIES && isTransientProviderFailure(result.stdout, result.stderr)) {
        continue;
      }

      return result;
    }
  }

  return { stdout: '', stderr: '', exitCode: 1 };
}
