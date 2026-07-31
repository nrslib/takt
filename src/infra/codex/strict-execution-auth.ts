import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PRIVATE_FILE_MODE = 0o600;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const AUTH_FILE_NAME = 'auth.json';

function sourceCodexHome(): string {
  const sourceHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return resolve(process.env.CODEX_HOME ?? join(sourceHome, '.codex'));
}

function readSafeAuthFile(path: string): Buffer {
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error('Strict read-only Codex execution requires a regular, non-symlink auth.json');
  }
  if (pathStat.size > MAX_AUTH_FILE_BYTES) {
    throw new Error(`Strict read-only Codex auth.json exceeds ${MAX_AUTH_FILE_BYTES} bytes`);
  }
  if (process.getuid !== undefined && pathStat.uid !== process.getuid()) {
    throw new Error('Strict read-only Codex auth.json must be owned by the current user');
  }

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile()
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
    ) {
      throw new Error('Strict read-only Codex auth.json changed while being opened');
    }
    const content = readFileSync(descriptor);
    const parsed = JSON.parse(content.toString('utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Strict read-only Codex auth.json must contain a JSON object');
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

export function installStrictCodexAuthentication(
  codexHome: string,
  apiKey: string | undefined,
): void {
  if (apiKey !== undefined) {
    return;
  }
  const sourcePath = join(sourceCodexHome(), AUTH_FILE_NAME);
  let content: Buffer;
  try {
    content = readSafeAuthFile(sourcePath);
  } catch (error) {
    throw new Error(
      'Strict read-only Codex execution requires an explicit API key or an isolated copy of auth.json',
      { cause: error },
    );
  }
  writeFileSync(join(codexHome, AUTH_FILE_NAME), content, {
    flag: 'wx',
    mode: PRIVATE_FILE_MODE,
  });
}
