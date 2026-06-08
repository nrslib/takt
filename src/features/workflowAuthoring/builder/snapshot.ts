import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  isFacetMarkdownFile,
  isWorkflowFile,
} from './files.js';
import type {
  BuilderFileChangeSummary,
  BuilderFileRollbackChange,
  FileChange,
  FileSnapshot,
} from './types.js';

export function snapshotBuilderChangeFiles(changes: BuilderFileChangeSummary[]): Map<string, FileSnapshot> {
  const snapshot = new Map<string, FileSnapshot>();
  for (const change of changes) {
    if (existsSync(change.filePath)) {
      snapshot.set(resolve(change.filePath), { content: readFileSync(change.filePath) });
    }
  }
  return snapshot;
}

export function diffSnapshots(before: Map<string, FileSnapshot>, after: Map<string, FileSnapshot>): FileChange[] {
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  const changes: FileChange[] = [];
  for (const filePath of allPaths) {
    const beforeSnapshot = before.get(filePath);
    const afterSnapshot = after.get(filePath);
    if (beforeSnapshot && afterSnapshot && beforeSnapshot.content.equals(afterSnapshot.content)) {
      continue;
    }
    changes.push({ filePath, before: beforeSnapshot, after: afterSnapshot });
  }
  return changes.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function categorizeBuilderChanges(changes: FileChange[]): {
  workflowPaths: string[];
  facetPaths: string[];
} {
  const changed = changes
    .filter((change) => change.after !== undefined)
    .map((change) => change.filePath);
  return {
    workflowPaths: changed.filter((filePath) => isWorkflowFile(filePath)).sort(),
    facetPaths: changed.filter((filePath) => isFacetMarkdownFile(filePath)).sort(),
  };
}

export function summarizeFileChanges(changes: FileChange[]): BuilderFileChangeSummary[] {
  return changes.map((change) => ({
    filePath: change.filePath,
    deleted: change.after === undefined,
    created: change.before === undefined && change.after !== undefined,
    content: change.after?.content.toString('utf-8'),
  }));
}

export function toRollbackChanges(changes: FileChange[]): BuilderFileRollbackChange[] {
  return changes.map((change) => ({
    filePath: change.filePath,
    ...(change.before ? { beforeContent: change.before.content } : {}),
  }));
}

export function rollbackBuilderFileChanges(changes: BuilderFileRollbackChange[]): void {
  for (const change of changes) {
    if (!change.beforeContent) {
      if (existsSync(change.filePath)) {
        unlinkSync(change.filePath);
      }
      continue;
    }
    mkdirSync(dirname(change.filePath), { recursive: true });
    writeFileSync(change.filePath, change.beforeContent);
  }
}
