import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { getGlobalRunStoreDir } from '../config/paths.js';

const STORE_DIRECTORY_MODE = 0o700;
const STORE_FILE_MODE = 0o600;

interface RunStoreManifest {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly clone_id: string;
  readonly created_at: string;
  readonly branch: string;
}

export interface WorktreeRunStorage {
  readonly cloneId: string;
  readonly linkPath: string;
  readonly storePath: string;
}

function hashProjectIdentity(projectDir: string): string {
  const canonicalProjectDir = realpathSync(projectDir);
  return createHash('sha256').update(canonicalProjectDir).digest('hex').slice(0, 24);
}

function readExistingStorage(linkPath: string, projectId: string): WorktreeRunStorage | undefined {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return undefined;
    }
    const storePath = realpathSync(linkPath);
    const storeRoot = realpathSync(getGlobalRunStoreDir());
    const relativeStore = relative(storeRoot, storePath);
    if (relativeStore.startsWith('..') || relativeStore.startsWith(`/`) || relativeStore.startsWith('\\')) {
      throw new Error(`Existing worktree run link points outside the TAKT run store: ${linkPath}`);
    }
    const manifestPath = join(storePath, '..', 'store.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<RunStoreManifest>;
    if (
      manifest.schema_version !== 1
      || manifest.project_id !== projectId
      || typeof manifest.clone_id !== 'string'
      || manifest.clone_id.length === 0
    ) {
      throw new Error(`Existing worktree run store manifest is invalid: ${manifestPath}`);
    }
    return { cloneId: manifest.clone_id, linkPath, storePath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isLegacyRunsDirectory(linkPath: string): boolean {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      return false;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to replace non-directory worktree run path: ${linkPath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function writeManifest(path: string, manifest: RunStoreManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: STORE_FILE_MODE,
  });
}

function verifyWritable(storePath: string): void {
  const probePath = join(storePath, '.write-probe');
  writeFileSync(probePath, '', { flag: 'wx', mode: STORE_FILE_MODE });
  unlinkSync(probePath);
}

export function initializeWorktreeRunStorage(
  projectDir: string,
  clonePath: string,
  branch: string,
): WorktreeRunStorage {
  const taktDir = join(clonePath, '.takt');
  const linkPath = join(taktDir, 'runs');
  const projectId = hashProjectIdentity(projectDir);
  const existing = readExistingStorage(linkPath, projectId);
  if (existing !== undefined) {
    return existing;
  }
  const migrateLegacyRuns = isLegacyRunsDirectory(linkPath);
  const cloneId = randomUUID();
  const storeContainer = join(getGlobalRunStoreDir(), projectId, cloneId);
  const storePath = join(storeContainer, 'runs');

  try {
    mkdirSync(taktDir, { recursive: true });
    mkdirSync(storeContainer, { recursive: true, mode: STORE_DIRECTORY_MODE });
    if (migrateLegacyRuns) {
      renameSync(linkPath, storePath);
    } else {
      mkdirSync(storePath, { mode: STORE_DIRECTORY_MODE });
    }
    chmodSync(storeContainer, STORE_DIRECTORY_MODE);
    chmodSync(storePath, STORE_DIRECTORY_MODE);
    writeManifest(join(storeContainer, 'store.json'), {
      schema_version: 1,
      project_id: projectId,
      clone_id: cloneId,
      created_at: new Date().toISOString(),
      branch,
    });
    verifyWritable(storePath);
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    const target = process.platform === 'win32'
      ? storePath
      : relative(dirname(linkPath), storePath);
    symlinkSync(target, linkPath, type);
    if (!existsSync(linkPath) || realpathSync(linkPath) !== realpathSync(storePath)) {
      throw new Error(`Worktree run storage link verification failed: ${linkPath}`);
    }
  } catch (error) {
    try {
      if (lstatSync(linkPath).isSymbolicLink()) {
        unlinkSync(linkPath);
      }
    } catch {
      // The link may not have been created.
    }
    if (migrateLegacyRuns && existsSync(storePath) && !existsSync(linkPath)) {
      renameSync(storePath, linkPath);
    }
    rmSync(storeContainer, { recursive: true, force: true });
    throw error;
  }

  return { cloneId, linkPath, storePath };
}
