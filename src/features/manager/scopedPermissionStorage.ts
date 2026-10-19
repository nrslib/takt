import { constants } from 'node:fs';
import { mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { projectIdForCanonicalDirectory } from '../../infra/config/global/projectRegistry.js';
import { readWorkspace } from '../../infra/config/global/workspaceRegistry.js';
import { writeFileAtomic } from '../../infra/config/project/sessionStore.js';

const MAX_FILE_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;
const PERMISSIONS_FILE_NAME = 'manager-permissions.md';
const PROJECT_PERMISSIONS_DIRECTORY = 'manager-permissions';

export type PermissionHeading = '許可' | '毎回確認' | '拒否';
export type PermissionScope =
  | { readonly kind: 'project'; readonly projectDirectory: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'global' };

interface PermissionTarget {
  readonly scope: PermissionScope['kind'];
  readonly filePath: string;
}

export interface PermissionSection {
  readonly heading: PermissionHeading;
  /** UTF-16 offsets of the body in the unmodified content, excluding the heading line. */
  readonly start: number;
  readonly end: number;
}

export interface ScopedPermissionFile extends PermissionTarget {
  readonly content: string;
  readonly sections: readonly PermissionSection[];
}

export type ScopedPermissionsResult =
  | { readonly ok: true; readonly files: readonly ScopedPermissionFile[] }
  | { readonly ok: false; readonly error: unknown };

async function resolveTarget(globalDirectory: string, scope: PermissionScope): Promise<PermissionTarget> {
  switch (scope.kind) {
    case 'project': {
      const canonicalDirectory = await realpath(scope.projectDirectory);
      if (!(await stat(canonicalDirectory)).isDirectory()) throw new Error('Project path is not a directory');
      const projectId = projectIdForCanonicalDirectory(canonicalDirectory);
      return {
        scope: scope.kind,
        filePath: join(globalDirectory, PROJECT_PERMISSIONS_DIRECTORY, 'projects', `${projectId}.md`),
      };
    }
    case 'workspace': {
      const workspace = await readWorkspace(globalDirectory, scope.workspaceId);
      if (workspace === undefined) throw new Error(`Workspace does not exist: ${scope.workspaceId}`);
      return { scope: scope.kind, filePath: join(globalDirectory, 'workspaces', workspace.id, PERMISSIONS_FILE_NAME) };
    }
    case 'global':
      return { scope: scope.kind, filePath: join(globalDirectory, PERMISSIONS_FILE_NAME) };
  }
}

async function openPermissionFile(filePath: string): Promise<FileHandle | undefined> {
  try {
    // FIFOもopenで待機せず、ハンドルの種別検証で拒否する。
    return await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function decodeContent(bytes: Uint8Array): string {
  // BOMも原文の一部として残し、不正UTF-8を置換して保存しない。
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function readBoundedFile(filePath: string, remainingBytes: number): Promise<string | undefined> {
  const handle = await openPermissionFile(filePath);
  if (handle === undefined) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Permission source is not a regular file');
    const limit = Math.min(MAX_FILE_BYTES, remainingBytes);
    if (stats.size > limit) throw new Error(`Permission source exceeds its byte budget (${limit}): ${filePath}`);
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error(`Permission source exceeds its byte budget (${limit}): ${filePath}`);
    return decodeContent(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function isPermissionHeading(value: string): value is PermissionHeading {
  return value === '許可' || value === '毎回確認' || value === '拒否';
}

function commentContinues(line: string, inComment: boolean): boolean {
  let offset = 0;
  while (offset < line.length) {
    const marker = inComment ? '-->' : '<!--';
    const next = line.indexOf(marker, offset);
    if (next === -1) break;
    inComment = !inComment;
    offset = next + marker.length;
  }
  return inComment;
}

function parseSections(content: string): { sections: PermissionSection[]; unsafeEnd: boolean } {
  const sections: { heading: PermissionHeading; start: number; end: number }[] = [];
  let current: typeof sections[number] | undefined;
  let fence: { character: string; length: number } | undefined;
  let inComment = false;

  for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    let line = match[0].replace(/[\r\n]+$/u, '');
    if (match.index === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
    if (fence !== undefined) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line)?.[1];
      if (closing !== undefined && closing[0] === fence.character && closing.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (!inComment && /^(?: {4}| {0,3}[\t>])/u.test(line)) continue;
    const opening = inComment ? null : /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (opening !== null) {
      const delimiter = opening[1]!;
      if (delimiter[0] === '~' || !opening[2]!.includes('`')) {
        fence = { character: delimiter.charAt(0), length: delimiter.length };
        continue;
      }
    }
    if (inComment || line.includes('<!--')) {
      inComment = commentContinues(line, inComment);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/u.exec(line);
    if (heading === null || heading[1]!.length > 2) continue;
    if (current !== undefined) {
      current.end = match.index;
      current = undefined;
    }
    const title = (heading[2] ?? '').replace(/[\t ]+#+[\t ]*$/u, '').trim();
    if (heading[1] === '##' && isPermissionHeading(title)) {
      current = { heading: title, start: match.index + match[0].length, end: content.length };
      sections.push(current);
    }
  }
  return { sections, unsafeEnd: fence !== undefined || inComment };
}

export async function readScopedPermissions(input: {
  readonly projectDirectory: string;
  readonly workspaceId?: string;
}): Promise<ScopedPermissionsResult> {
  try {
    const globalDirectory = getGlobalConfigDir();
    const targets = [await resolveTarget(globalDirectory, { kind: 'project', projectDirectory: input.projectDirectory })];
    if (input.workspaceId !== undefined) {
      targets.push(await resolveTarget(globalDirectory, { kind: 'workspace', workspaceId: input.workspaceId }));
    }
    targets.push(await resolveTarget(globalDirectory, { kind: 'global' }));
    const files: ScopedPermissionFile[] = [];
    for (const target of targets) {
      const remainingBytes = MAX_TOTAL_BYTES - files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
      let content: string | undefined;
      try {
        content = await readBoundedFile(target.filePath, remainingBytes);
      } catch (cause) {
        throw new Error(`Cannot read ${target.scope} permissions: ${target.filePath}`, { cause });
      }
      if (content !== undefined) files.push({ ...target, content, sections: parseSections(content).sections });
    }
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error };
  }
}

async function readForAppend(filePath: string): Promise<string> {
  const handle = await openPermissionFile(filePath);
  if (handle === undefined) return '';
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Permission destination is not a regular file');
    return decodeContent(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function insertSentence(content: string, heading: PermissionHeading, sentence: string): string {
  const { sections, unsafeEnd } = parseSections(content);
  const section = sections.filter((entry) => entry.heading === heading).at(-1);
  const position = section?.end ?? content.length;
  if (position === content.length && unsafeEnd) throw new Error('Cannot append inside an unclosed Markdown region');
  const newline = /\r\n|\n|\r/u.exec(content)?.[0] ?? '\n';
  const prefix = content.slice(0, position);
  const separator = prefix.length > 0 && !/[\r\n]$/u.test(prefix) ? newline : '';
  const newHeading = section === undefined ? `## ${heading}${newline}` : '';
  return prefix + separator + newHeading + `- ${sentence}${newline}` + content.slice(position);
}

/** TUIで人が確定した一文の保存用。AIのツール登録には接続しない。 */
export async function appendScopedPermission(input: {
  readonly scope: PermissionScope;
  readonly heading: PermissionHeading;
  readonly sentence: string;
}): Promise<void> {
  if (/[\r\n]/u.test(input.sentence)) throw new Error('Permission sentence must be a single line');
  const target = await resolveTarget(getGlobalConfigDir(), input.scope);
  const content = await readForAppend(target.filePath);
  const updated = insertSentence(content, input.heading, input.sentence);
  await mkdir(dirname(target.filePath), { recursive: true });
  writeFileAtomic(target.filePath, updated);
}
