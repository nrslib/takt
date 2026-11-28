import { readFileSync, statSync, type Stats } from 'node:fs';

/**
 * Resolves the worker registration token from exactly one source: the TAKT_WORKER_TOKEN
 * environment variable, a --token-file whose permissions only the owner can read, or the
 * deprecated --token argument. Giving the token in more than one way stops startup, and no
 * message produced here ever contains a token value or, for the overlap error, a file path.
 */
export function resolveWorkerToken(
  input: { token?: string; tokenFile?: string },
  environment: NodeJS.ProcessEnv,
): { token: string; warnings: string[] } {
  const environmentToken = environment.TAKT_WORKER_TOKEN;
  const ways: string[] = [];
  if (environmentToken !== undefined && environmentToken !== '') ways.push('TAKT_WORKER_TOKEN');
  if (input.tokenFile !== undefined) ways.push('--token-file');
  if (input.token !== undefined) ways.push('--token');
  if (ways.length > 1) {
    throw new Error(`Worker token was given more than once (${ways.join(', ')}). Give it in exactly one way.`);
  }
  if (environmentToken !== undefined && environmentToken !== '') return { token: environmentToken, warnings: [] };
  if (input.tokenFile !== undefined) return { token: readWorkerTokenFile(input.tokenFile), warnings: [] };
  if (input.token !== undefined) {
    return {
      token: input.token,
      warnings: ['--token leaves the worker token in the process arguments, where other users of this machine can read it with ps. Use TAKT_WORKER_TOKEN or --token-file instead.'],
    };
  }
  throw new Error('Worker startup requires a worker token: set TAKT_WORKER_TOKEN, or pass --token-file or --token');
}

function readWorkerTokenFile(tokenFile: string): string {
  let stats: Stats;
  try {
    stats = statSync(tokenFile);
  } catch (error) {
    throw new Error(`Cannot read worker token file ${tokenFile}: ${errorCode(error)}`);
  }
  if (!stats.isFile()) throw new Error(`Worker token file ${tokenFile} is not a regular file`);
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0');
    throw new Error(`Worker token file ${tokenFile} must not be accessible by group or others (mode ${mode}). Run: chmod 600 ${tokenFile}`);
  }
  let content: string;
  try {
    content = readFileSync(tokenFile, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read worker token file ${tokenFile}: ${errorCode(error)}`);
  }
  const token = content.trim();
  if (token === '') throw new Error(`Worker token file ${tokenFile} is empty`);
  return token;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'unknown error';
}
