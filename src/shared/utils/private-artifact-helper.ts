import { spawnSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolveHelperSpawnCwd } from './spawnCwd.js';

const ARTIFACT_HELPER_TIMEOUT_MS = 30_000;

export class PrivateArtifactHelperError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly errno: number | undefined) {
    super(message);
  }
}

export interface SerializedPrivateArtifactIdentity {
  dev: string;
  ino: string;
}

export function serializePrivateArtifactIdentity(
  stat: Stats,
): SerializedPrivateArtifactIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

export function assertPrivateArtifactImmediateChild(
  parentPath: string,
  childPath: string,
): string {
  const name = basename(childPath);
  if (dirname(childPath) !== parentPath || name === '.' || name === '..') {
    throw new Error(`Private artifact target must be an immediate child: ${childPath}`);
  }
  return name;
}

export function runPrivateArtifactHelper(
  script: string,
  request: string,
  cwd: string,
  failureMessage: string,
): string {
  const result = spawnSync(process.execPath, ['-e', script, request], {
    cwd: resolveHelperSpawnCwd(cwd),
    encoding: 'utf-8',
    env: {},
    timeout: ARTIFACT_HELPER_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    const message = result.stderr.trim();
    let code: string | undefined;
    let errno: number | undefined;
    try {
      const metadata: unknown = JSON.parse(result.stdout);
      if (metadata !== null && typeof metadata === 'object') {
        const fields = metadata as Record<string, unknown>;
        if (typeof fields.code === 'string') code = fields.code;
        if (typeof fields.errno === 'number' && Number.isInteger(fields.errno)) errno = fields.errno;
      }
    } catch {
      // Older helpers and arbitrary scripts may report only a human-readable error.
    }
    throw new PrivateArtifactHelperError(message.length === 0 ? failureMessage : message, code, errno);
  }
  return result.stdout;
}
