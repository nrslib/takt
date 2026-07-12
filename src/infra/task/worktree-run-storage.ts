import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

export interface StoredProjectRun {
  readonly cloneId: string;
  readonly runSlug: string;
  readonly runPath: string;
}

function hashProjectIdentity(projectDir: string): string {
  const canonicalProjectDir = realpathSync(projectDir);
  return createHash('sha256').update(canonicalProjectDir).digest('hex').slice(0, 24);
}

function readStoreManifest(
  manifestPath: string,
  projectId: string,
  cloneId?: string,
): RunStoreManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<RunStoreManifest>;
  if (
    manifest.schema_version !== 1
    || manifest.project_id !== projectId
    || typeof manifest.clone_id !== 'string'
    || manifest.clone_id.length === 0
    || (cloneId !== undefined && manifest.clone_id !== cloneId)
    || typeof manifest.created_at !== 'string'
    || typeof manifest.branch !== 'string'
  ) {
    throw new Error(`Run store manifest is invalid: ${manifestPath}`);
  }
  return manifest as RunStoreManifest;
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
    const manifest = readStoreManifest(manifestPath, projectId);
    return { cloneId: manifest.clone_id, linkPath, storePath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function moveDirectory(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
    cpSync(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    rmSync(source, { recursive: true, force: true });
  }
}

export function listStoredProjectRuns(projectDir: string): readonly StoredProjectRun[] {
  const projectId = hashProjectIdentity(projectDir);
  const projectStore = join(getGlobalRunStoreDir(), projectId);
  if (!existsSync(projectStore)) {
    return [];
  }
  const runs: StoredProjectRun[] = [];
  for (const cloneEntry of readdirSync(projectStore, { withFileTypes: true })) {
    if (!cloneEntry.isDirectory()) {
      continue;
    }
    const cloneStore = join(projectStore, cloneEntry.name);
    readStoreManifest(join(cloneStore, 'store.json'), projectId, cloneEntry.name);
    const runsPath = join(cloneStore, 'runs');
    if (!existsSync(runsPath)) {
      continue;
    }
    for (const runEntry of readdirSync(runsPath, { withFileTypes: true })) {
      if (runEntry.isDirectory()) {
        runs.push({
          cloneId: cloneEntry.name,
          runSlug: runEntry.name,
          runPath: join(runsPath, runEntry.name),
        });
      }
    }
  }
  return runs;
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
  const runStoreRoot = getGlobalRunStoreDir();
  const projectStore = join(runStoreRoot, projectId);
  const storeContainer = join(projectStore, cloneId);
  const storePath = join(storeContainer, 'runs');

  try {
    mkdirSync(taktDir, { recursive: true });
    mkdirSync(runStoreRoot, { recursive: true, mode: STORE_DIRECTORY_MODE });
    chmodSync(runStoreRoot, STORE_DIRECTORY_MODE);
    mkdirSync(projectStore, { recursive: true, mode: STORE_DIRECTORY_MODE });
    chmodSync(projectStore, STORE_DIRECTORY_MODE);
    mkdirSync(storeContainer, { mode: STORE_DIRECTORY_MODE });
    if (migrateLegacyRuns) {
      moveDirectory(linkPath, storePath);
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
      moveDirectory(storePath, linkPath);
    }
    rmSync(storeContainer, { recursive: true, force: true });
    throw error;
  }

  return { cloneId, linkPath, storePath };
}
