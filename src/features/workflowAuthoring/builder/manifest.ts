import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isPathSafe } from '../../../infra/config/index.js';
import {
  assertBuilderRootIsNotSymlink,
  assertNoSymlinkInManagedPath,
  findBuilderRoot,
} from './files.js';
import type {
  BuilderChangeManifest,
  BuilderFileChangeSummary,
  BuilderManifestChange,
  ResolvedBuilderScope,
} from './types.js';

const BUILDER_MANIFEST_JSON_BLOCK = /```(?:json)?\s*([\s\S]*?)```/i;

export function parseBuilderChangeManifest(content: string): BuilderChangeManifest {
  const jsonText = extractBuilderManifestJson(content);
  const parsed: unknown = JSON.parse(jsonText);
  if (!isRecord(parsed)) {
    throw new Error('Workflow builder manifest must be a JSON object.');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error('Workflow builder manifest requires a non-empty summary string.');
  }
  if (!Array.isArray(parsed.changes)) {
    throw new Error('Workflow builder manifest requires a changes array.');
  }
  const changes = parsed.changes.map(parseBuilderManifestChange);
  return { summary: parsed.summary.trim(), changes };
}

export function resolveBuilderManifestChanges(
  projectDir: string,
  scope: ResolvedBuilderScope,
  manifest: BuilderChangeManifest,
): BuilderFileChangeSummary[] {
  const seen = new Set<string>();
  return manifest.changes.map((change) => {
    const filePath = resolveBuilderManifestPath(projectDir, scope, change.path);
    assertBuilderManifestPathSafeForWrite(scope, filePath);
    if (seen.has(filePath)) {
      throw new Error(`Workflow builder manifest contains duplicate path "${change.path}".`);
    }
    seen.add(filePath);
    return {
      filePath,
      deleted: false,
      created: !existsSync(filePath),
      content: change.content,
    };
  });
}

export function applyBuilderChangeManifest(
  projectDir: string,
  scope: ResolvedBuilderScope,
  manifest: BuilderChangeManifest,
): void {
  for (const change of manifest.changes) {
    const filePath = resolveBuilderManifestPath(projectDir, scope, change.path);
    assertBuilderManifestPathSafeForWrite(scope, filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, change.content, 'utf-8');
  }
}

function extractBuilderManifestJson(content: string): string {
  const fenced = BUILDER_MANIFEST_JSON_BLOCK.exec(content);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return content.trim();
}

function parseBuilderManifestChange(change: unknown): BuilderManifestChange {
  if (!isRecord(change)) {
    throw new Error('Workflow builder manifest changes must be JSON objects.');
  }
  if (typeof change.path !== 'string' || change.path.trim().length === 0) {
    throw new Error('Workflow builder manifest change requires a non-empty path string.');
  }
  if (typeof change.content !== 'string') {
    throw new Error(`Workflow builder manifest change "${change.path}" requires a content string.`);
  }
  return { path: change.path.trim(), content: change.content };
}

function resolveBuilderManifestPath(
  _projectDir: string,
  scope: ResolvedBuilderScope,
  manifestPath: string,
): string {
  if (isAbsolute(manifestPath)) {
    throw new Error(`Workflow builder manifest path "${manifestPath}" must be relative to the selected scope root.`);
  }
  const scopedPath = resolveLanguagePrefixedManifestPath(scope, manifestPath);
  if (scopedPath) {
    return scopedPath;
  }
  if (scope.roots.length === 1) {
    return resolve(scope.roots[0]!.rootDir, manifestPath);
  }
  throw new Error(`Builtin workflow builder manifest path "${manifestPath}" must use an en: or ja: prefix.`);
}

function assertBuilderManifestPathSafeForWrite(scope: ResolvedBuilderScope, filePath: string): void {
  for (const root of scope.roots) {
    assertBuilderRootIsNotSymlink(root.rootDir);
  }
  const root = findBuilderRoot(scope, filePath);
  if (!root) {
    throw new Error(`Workflow builder manifest path "${filePath}" is outside the selected scope.`);
  }
  assertNoSymlinkInManagedPath(root.rootDir, filePath);
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir)) {
    return;
  }
  if (!isPathSafe(root.rootDir, realpathSync(parentDir))) {
    throw new Error(`Workflow builder manifest path "${filePath}" resolves outside the selected scope.`);
  }
}

function resolveLanguagePrefixedManifestPath(
  scope: ResolvedBuilderScope,
  manifestPath: string,
): string | undefined {
  const match = /^(en|ja):(.*)$/.exec(manifestPath);
  if (!match) {
    return undefined;
  }
  const lang = match[1] as 'en' | 'ja';
  const relativePath = match[2];
  if (!relativePath) {
    throw new Error(`Workflow builder manifest path "${manifestPath}" is missing a relative path.`);
  }
  if (isAbsolute(relativePath)) {
    throw new Error(`Workflow builder manifest path "${manifestPath}" must be relative to the selected scope root.`);
  }
  const root = scope.roots.find((candidate) => candidate.lang === lang);
  if (!root) {
    throw new Error(`Workflow builder manifest path "${manifestPath}" uses a language outside the selected scope.`);
  }
  return resolve(root.rootDir, relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
