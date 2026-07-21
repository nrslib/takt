import { spawnSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import { basename, dirname } from 'node:path';

const ARTIFACT_HELPER_TIMEOUT_MS = 5_000;

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
    cwd,
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
    throw new Error(message.length === 0 ? failureMessage : message);
  }
  return result.stdout;
}
