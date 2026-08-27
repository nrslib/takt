import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('clone');

const CLONE_META_DIR = 'clone-meta';

function encodeBranchName(branch: string): string {
  return branch.replace(/\//g, '--');
}

export function getCloneMetaPath(projectDir: string, branch: string, metadataDirectory?: string): string {
  return metadataDirectory === undefined
    ? path.join(projectDir, '.takt', CLONE_META_DIR, `${encodeBranchName(branch)}.json`)
    : path.join(metadataDirectory, `${encodeBranchName(branch)}.json`);
}

export function saveCloneMeta(projectDir: string, branch: string, clonePath: string, metadataDirectory?: string): void {
  const filePath = getCloneMetaPath(projectDir, branch, metadataDirectory);
  const directory = path.dirname(filePath);
  const mode = metadataDirectory === undefined ? 0o644 : 0o600;
  fs.mkdirSync(directory, { recursive: true, mode: metadataDirectory === undefined ? 0o755 : 0o700 });
  if (metadataDirectory !== undefined) fs.chmodSync(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ branch, clonePath }), { encoding: 'utf8', mode, flag: 'wx' });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file was already renamed or did not get created.
    }
  }
  log.info('Clone meta saved', { branch, clonePath });
}

export function removeCloneMeta(projectDir: string, branch: string, metadataDirectory?: string): void {
  const filePath = getCloneMetaPath(projectDir, branch, metadataDirectory);
  if (!fs.existsSync(filePath)) {
    return;
  }
  fs.unlinkSync(filePath);
  log.info('Clone meta removed', { branch });
}

export function loadCloneMeta(projectDir: string, branch: string, metadataDirectory?: string): { clonePath: string } | null {
  const filePath = getCloneMetaPath(projectDir, branch, metadataDirectory);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as { clonePath: string };
  } catch (err) {
    log.debug('Failed to load clone meta', { branch, error: String(err) });
    return null;
  }
}
