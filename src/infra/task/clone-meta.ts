import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('clone');

const CLONE_META_DIR = 'clone-meta';

function encodeBranchName(branch: string): string {
  return branch.replace(/\//g, '--');
}

export function getCloneMetaPath(projectDir: string, branch: string): string {
  return path.join(projectDir, '.takt', CLONE_META_DIR, `${encodeBranchName(branch)}.json`);
}

export function saveCloneMeta(projectDir: string, branch: string, clonePath: string): void {
  const filePath = getCloneMetaPath(projectDir, branch);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ branch, clonePath }));
  log.info('Clone meta saved', { branch, clonePath });
}

export function removeCloneMeta(projectDir: string, branch: string): void {
  const filePath = getCloneMetaPath(projectDir, branch);
  if (!fs.existsSync(filePath)) {
    return;
  }
  fs.unlinkSync(filePath);
  log.info('Clone meta removed', { branch });
}

export function loadCloneMeta(projectDir: string, branch: string): { clonePath: string } | null {
  const filePath = getCloneMetaPath(projectDir, branch);
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
