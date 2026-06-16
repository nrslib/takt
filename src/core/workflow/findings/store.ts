import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { FindingLedger, RawFinding } from './types.js';
import { parseFindingLedger, parseRawFindings } from './schemas.js';
import { assertLedgerIdAllocationInvariant } from './ledger-validation.js';

interface FindingLedgerStoreOptions {
  projectCwd: string;
  reportDir: string;
  workflowName: string;
  ledgerPath: string;
  rawFindingsPath: string;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_ONLY_PRIVATE_FILE_MODE = 0o400;

export interface FindingLedgerStore {
  loadLedger: () => FindingLedger;
  saveLedger: (ledger: FindingLedger) => void;
  createRunCopy: () => string;
  saveRawFindings: (runId: string, stepName: string, rawFindings: RawFinding[]) => string;
}

function resolveInside(baseDir: string, path: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(resolvedBase, path);
  assertPathInside(resolvedBase, resolvedPath, path);
  return resolvedPath;
}

function assertPathInside(resolvedBase: string, resolvedPath: string, path: string): void {
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(basePrefix)) {
    throw new Error(`Finding ledger path escapes base directory: ${path}`);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function assertNotSymlink(path: string): void {
  if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Finding ledger path must not be a symbolic link: ${path}`);
  }
}

function findExistingAncestor(path: string): string {
  let current = path;
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Finding ledger parent directory does not exist: ${path}`);
    }
    current = parent;
  }
  return current;
}

function assertRealPathInside(baseDir: string, path: string): void {
  const resolvedBase = realpathSync(baseDir);
  const resolvedPath = realpathSync(path);
  assertPathInside(resolvedBase, resolvedPath, path);
}

function prepareWritableFilePath(baseDir: string, filePath: string): void {
  const parentDir = dirname(filePath);
  assertRealPathInside(baseDir, findExistingAncestor(parentDir));
  mkdirSync(parentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(parentDir, PRIVATE_DIR_MODE);
  assertRealPathInside(baseDir, parentDir);
  assertNotSymlink(filePath);
  if (pathExists(filePath)) {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  }
}

function prepareWritableCopyPath(baseDir: string, filePath: string): void {
  prepareWritableFilePath(baseDir, filePath);
}

function prepareWritableDirectory(baseDir: string, dirPath: string): void {
  assertRealPathInside(baseDir, findExistingAncestor(dirPath));
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dirPath, PRIVATE_DIR_MODE);
  assertRealPathInside(baseDir, dirPath);
}

function createEmptyLedger(workflowName: string): FindingLedger {
  return {
    version: 1,
    workflowName,
    nextId: 1,
    findings: [],
    rawFindings: [],
    conflicts: [],
    updatedAt: new Date().toISOString(),
  };
}

function readLedgerFile(path: string): FindingLedger {
  const ledger = parseFindingLedger(JSON.parse(readFileSync(path, 'utf-8')));
  assertLedgerIdAllocationInvariant(ledger);
  return ledger;
}

function readProjectLedgerFile(baseDir: string, path: string): FindingLedger {
  assertNotSymlink(path);
  assertRealPathInside(baseDir, path);
  return readLedgerFile(path);
}

function readProjectLedgerOrEmpty(baseDir: string, path: string, workflowName: string): FindingLedger {
  assertRealPathInside(baseDir, findExistingAncestor(dirname(path)));
  assertNotSymlink(path);
  if (!pathExists(path)) {
    return createEmptyLedger(workflowName);
  }
  const ledger = readProjectLedgerFile(baseDir, path);
  assertLedgerWorkflowName(ledger, workflowName, path);
  return ledger;
}

function assertLedgerWorkflowName(ledger: FindingLedger, workflowName: string, source: string): void {
  if (ledger.workflowName !== workflowName) {
    throw new Error(`Finding ledger workflowName mismatch in ${source}: expected "${workflowName}", got "${ledger.workflowName}"`);
  }
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid finding file segment: ${value}`);
  }
  return sanitized;
}

export function createFindingLedgerStore(options: FindingLedgerStoreOptions): FindingLedgerStore {
  const ledgerRoot = resolveFindingLedgerRoot(options.projectCwd);
  assertNotSymlink(ledgerRoot);
  const ledgerPath = resolveInside(ledgerRoot, options.ledgerPath);
  const copyPath = resolveInside(options.reportDir, 'findings-ledger.json');
  const rawFindingsDir = resolveInside(ledgerRoot, options.rawFindingsPath);

  return {
    loadLedger: () => {
      return readProjectLedgerOrEmpty(ledgerRoot, ledgerPath, options.workflowName);
    },
    saveLedger: (ledger) => {
      assertLedgerWorkflowName(ledger, options.workflowName, ledgerPath);
      assertLedgerIdAllocationInvariant(ledger);
      prepareWritableFilePath(ledgerRoot, ledgerPath);
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
      chmodSync(ledgerPath, PRIVATE_FILE_MODE);
    },
    createRunCopy: () => {
      const ledger = readProjectLedgerOrEmpty(ledgerRoot, ledgerPath, options.workflowName);
      prepareWritableCopyPath(options.reportDir, copyPath);
      writeFileSync(copyPath, JSON.stringify(ledger, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
      chmodSync(copyPath, READ_ONLY_PRIVATE_FILE_MODE);
      return copyPath;
    },
    saveRawFindings: (runId, stepName, rawFindings) => {
      const parsedRawFindings = parseRawFindings(rawFindings);
      prepareWritableDirectory(ledgerRoot, rawFindingsDir);
      const baseName = `${sanitizeFileSegment(runId)}.${sanitizeFileSegment(stepName)}`;
      let rawFindingsFile = `${baseName}.json`;
      let generation = 2;
      while (pathExists(resolveInside(rawFindingsDir, rawFindingsFile))) {
        rawFindingsFile = `${baseName}.${generation}.json`;
        generation += 1;
      }
      const rawFindingsFilePath = resolveInside(rawFindingsDir, rawFindingsFile);
      assertNotSymlink(rawFindingsFilePath);
      writeFileSync(rawFindingsFilePath, JSON.stringify(parsedRawFindings, null, 2), {
        encoding: 'utf-8',
        mode: PRIVATE_FILE_MODE,
      });
      chmodSync(rawFindingsFilePath, PRIVATE_FILE_MODE);
      return rawFindingsFilePath;
    },
  };
}

export function resolveFindingLedgerRoot(projectCwd: string): string {
  return resolve(projectCwd);
}
