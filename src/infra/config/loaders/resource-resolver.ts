import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getProjectFacetDir, getRepertoireFacetDir, type FacetType } from '../paths.js';
import { assertPathSegmentsAreSafe } from '../../../shared/utils/pathBoundary.js';
import {
  resolveFacetPath as resolveFacetPathGeneric,
  resolvePersona as resolvePersonaGeneric,
  isResourcePath,
  resolveResourcePath,
  isScopeRef,
  parseScopeRef,
  resolveScopeRef,
} from 'faceted-prompting';
import {
  assertAllowedPersonaPath,
} from './workflowPersonaPathPolicy.js';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';
import {
  buildCandidateDirsWithPackage,
  buildFacetsRoots,
  getPackageFromWorkflowDir,
  getWorkflowBaseDir,
  type FacetResolutionContext,
} from './workflowPackageScope.js';

export interface WorkflowSections {
  personas?: Record<string, string>;
  resolvedPolicies?: Record<string, string>;
  resolvedPoliciesWithSource?: ResolvedSectionMap;
  resolvedKnowledge?: Record<string, string>;
  resolvedKnowledgeWithSource?: ResolvedSectionMap;
  resolvedInstructions?: Record<string, string>;
  resolvedInstructionsWithSource?: ResolvedSectionMap;
  resolvedReportFormats?: Record<string, string>;
  resolvedReportFormatsWithSource?: ResolvedSectionMap;
}

export {
  isResourcePath,
  resolveResourcePath,
  resolveSectionMap,
  extractPersonaDisplayName,
} from 'faceted-prompting';

export type { FacetResolutionContext } from './workflowPackageScope.js';

export interface ResolvedFacetContent {
  content: string;
  sourcePath?: string;
  facetType?: FacetType;
  refName?: string;
}

export type ResolvedSectionMap = Record<string, ResolvedFacetContent>;

type ResolvedMapInput = Record<string, string> | ResolvedSectionMap;

interface FacetInheritanceFrame {
  sourcePath?: string;
  refName?: string;
}

interface ExtendsDirective {
  parentName: string;
  start: number;
  end: number;
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(resolve(basePath), resolve(targetPath));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isPathInsideOrSame(basePath: string, targetPath: string): boolean {
  const rel = relative(resolve(basePath), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function contentSourceLabel(content: ResolvedFacetContent): string {
  return content.sourcePath ?? content.refName ?? '<inline>';
}

function formatInheritanceChain(frames: FacetInheritanceFrame[], current: ResolvedFacetContent): string {
  return [...frames.map((frame) => frame.sourcePath ?? frame.refName ?? '<inline>'), contentSourceLabel(current)].join(' -> ');
}

function isResolvedFacetContent(value: string | ResolvedFacetContent): value is ResolvedFacetContent {
  return typeof value !== 'string';
}

function toResolvedContent(
  value: string | ResolvedFacetContent,
  facetType: FacetType | undefined,
  refName: string | undefined,
): ResolvedFacetContent {
  if (isResolvedFacetContent(value)) {
    return {
      ...value,
      facetType: value.facetType ?? facetType,
      refName: value.refName ?? refName,
    };
  }
  return { content: value, facetType, refName };
}

export function unwrapResolvedSectionMap(map: ResolvedSectionMap | undefined): Record<string, string> | undefined {
  if (!map) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    result[name] = value.content;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveResourceContentWithSource(
  spec: string | undefined,
  workflowDir: string,
  facetType?: FacetType,
  refName?: string,
  context?: FacetResolutionContext,
): ResolvedFacetContent | undefined {
  if (spec == null) {
    return undefined;
  }
  if (spec.endsWith('.md')) {
    const resolved = resolveResourcePath(spec, workflowDir);
    if (existsSync(resolved)) {
      return {
        content: readResourceFile(resolved, facetType, workflowDir, context),
        sourcePath: resolved,
        facetType,
        refName,
      };
    }
  }
  return { content: spec, facetType, refName };
}

export function resolveSectionMapWithSource(
  raw: Record<string, string> | undefined,
  workflowDir: string,
  facetType: FacetType,
  context?: FacetResolutionContext,
): ResolvedSectionMap | undefined {
  if (!raw) {
    return undefined;
  }
  const resolved: ResolvedSectionMap = {};
  for (const [name, value] of Object.entries(raw)) {
    const content = resolveResourceContentWithSource(value, workflowDir, facetType, name, context);
    if (content?.content) {
      resolved[name] = content;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

const EXTENDS_LIKE_PATTERN = /\{\s*extends\s*:[^}]*\}/g;
const EXTENDS_LINE_PATTERN = /^[ \t]*\{extends:\s*([^}]+?)\s*\}[ \t]*$/gm;
const BARE_FACET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isBareFacetName(name: string): boolean {
  return BARE_FACET_NAME_PATTERN.test(name)
    && !isResourcePath(name)
    && !isScopeRef(name);
}

function parseExtendsDirective(content: string, sourceLabel: string): ExtendsDirective | undefined {
  const likeMatches = [...content.matchAll(EXTENDS_LIKE_PATTERN)];
  if (content.includes('{extends:') && likeMatches.length === 0) {
    throw new Error(`Malformed facet extends directive in ${sourceLabel}`);
  }
  if (likeMatches.length === 0) {
    return undefined;
  }

  const lineMatches = [...content.matchAll(EXTENDS_LINE_PATTERN)];
  if (lineMatches.length !== likeMatches.length) {
    throw new Error(`Facet extends directive must be on its own line in ${sourceLabel}`);
  }
  if (lineMatches.length > 1) {
    throw new Error(`Facet file ${sourceLabel} contains multiple extends directives`);
  }

  const match = lineMatches[0]!;
  const parentName = (match[1] ?? '').trim();
  if (!isBareFacetName(parentName)) {
    throw new Error(`Unsupported facet extends parent "${parentName}" in ${sourceLabel}; only bare facet names are supported`);
  }

  const start = match.index;
  if (start === undefined) {
    throw new Error(`Malformed facet extends directive in ${sourceLabel}`);
  }
  return {
    parentName,
    start,
    end: start + match[0].length,
  };
}

function findSourceLayerIndex(sourcePath: string, candidateDirs: readonly string[]): number | undefined {
  const index = candidateDirs.findIndex((dir) => isPathInside(dir, sourcePath));
  return index >= 0 ? index : undefined;
}

function isProjectFacetFile(
  filePath: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
): boolean {
  if (!context?.projectDir) {
    return false;
  }
  return isPathInside(getProjectFacetDir(context.projectDir, facetType), filePath);
}

function getPackageFacetDir(
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
): string | undefined {
  if (!context?.workflowDir || !context.repertoireDir) {
    return undefined;
  }
  const pkg = getPackageFromWorkflowDir(getWorkflowBaseDir(context.workflowDir), context.repertoireDir);
  return pkg
    ? getRepertoireFacetDir(pkg.owner, pkg.repo, facetType, context.repertoireDir)
    : undefined;
}

function isPackageFacetFile(
  filePath: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
): boolean {
  const packageFacetDir = getPackageFacetDir(facetType, context);
  return packageFacetDir !== undefined && isPathInside(packageFacetDir, filePath);
}

function assertProjectFacetFileIsSafe(
  filePath: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
): void {
  const projectDir = context?.projectDir;
  if (!projectDir || !isProjectFacetFile(filePath, facetType, context)) {
    return;
  }

  assertPathSegmentsAreSafe(
    projectDir,
    filePath,
    (_violation, segmentPath) => new Error(`Project facet file must stay inside the project and must not use symlinks: ${segmentPath}`),
  );

  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Project facet file must be a regular file and must not be a symlink: ${filePath}`);
  }

  const resolvedProjectDir = realpathSync(projectDir);
  const facetDir = realpathSync(getProjectFacetDir(projectDir, facetType));
  const realFilePath = realpathSync(filePath);
  if (!isPathInsideOrSame(resolvedProjectDir, facetDir) || !isPathInside(facetDir, realFilePath)) {
    throw new Error(`Project facet file must stay inside the project and must not use symlinks: ${filePath}`);
  }
}

function assertScopedFacetFileIsSafe(
  filePath: string,
  context: FacetResolutionContext | undefined,
): void {
  const repertoireDir = context?.repertoireDir;
  if (!repertoireDir) {
    return;
  }

  const stats = assertPathSegmentsAreSafe(
    repertoireDir,
    filePath,
    (_violation, segmentPath) => new Error(`Scoped facet file must stay inside the repertoire and must not use symlinks: ${segmentPath}`),
  );
  if (!stats) {
    throw new Error(`Scoped facet file not found: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Scoped facet file must be a regular file and must not be a symlink: ${filePath}`);
  }

  const resolvedRepertoireDir = realpathSync(repertoireDir);
  const realFilePath = realpathSync(filePath);
  if (!isPathInside(resolvedRepertoireDir, realFilePath)) {
    throw new Error(`Scoped facet file must stay inside the repertoire and must not use symlinks: ${filePath}`);
  }
}

function assertFacetFileIsSafe(
  filePath: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
): void {
  if (isPackageFacetFile(filePath, facetType, context)) {
    assertScopedFacetFileIsSafe(filePath, context);
    return;
  }
  assertProjectFacetFileIsSafe(filePath, facetType, context);
}

function readFacetFile(
  filePath: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
): string {
  assertFacetFileIsSafe(filePath, facetType, context);
  return readFileSync(filePath, 'utf-8');
}

function readScopedFacetFile(
  filePath: string,
  context: FacetResolutionContext,
): string {
  assertScopedFacetFileIsSafe(filePath, context);
  return readFileSync(filePath, 'utf-8');
}

function readResourceFile(
  filePath: string,
  facetType: FacetType | undefined,
  workflowDir: string,
  context: FacetResolutionContext | undefined,
): string {
  if (facetType === undefined) {
    const stats = assertPathSegmentsAreSafe(
      workflowDir,
      filePath,
      (_violation, segmentPath) => new Error(`Workflow resource file must stay inside the workflow directory and must not use symlinks: ${segmentPath}`),
    );
    if (!stats) {
      throw new Error(`Workflow resource file not found: ${filePath}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Workflow resource file must be a regular file and must not be a symlink: ${filePath}`);
    }

    const resolvedWorkflowDir = realpathSync(workflowDir);
    const realFilePath = realpathSync(filePath);
    if (!isPathInside(resolvedWorkflowDir, realFilePath)) {
      throw new Error(`Workflow resource file must stay inside the workflow directory and must not use symlinks: ${filePath}`);
    }
    return readFileSync(filePath, 'utf-8');
  }
  return readFacetFile(filePath, facetType, context);
}

function resolveFacetFromCandidateDirs(
  name: string,
  facetType: FacetType,
  candidateDirs: readonly string[],
  refName: string,
  context?: FacetResolutionContext,
  excludeSourcePath?: string,
): ResolvedFacetContent | undefined {
  for (const dir of candidateDirs) {
    const filePath = join(dir, `${name}.md`);
    if (excludeSourcePath && samePath(filePath, excludeSourcePath)) {
      continue;
    }
    if (existsSync(filePath)) {
      return {
        content: readFacetFile(filePath, facetType, context),
        sourcePath: filePath,
        facetType,
        refName,
      };
    }
  }
  return undefined;
}

function resolveParentFacetWithSource(
  parentName: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
  currentSourcePath: string,
): ResolvedFacetContent | undefined {
  if (!context) {
    return undefined;
  }

  const candidateDirs = buildCandidateDirsWithPackage(facetType, context);
  const sourceLayerIndex = findSourceLayerIndex(currentSourcePath, candidateDirs);
  const searchDirs = candidateDirs.slice(sourceLayerIndex ?? 0);
  return resolveFacetFromCandidateDirs(parentName, facetType, searchDirs, parentName, context, currentSourcePath);
}

function expandFacetInheritance(
  resolved: ResolvedFacetContent,
  facetType: FacetType | undefined,
  context: FacetResolutionContext | undefined,
  frames: FacetInheritanceFrame[] = [],
): ResolvedFacetContent {
  if (!facetType) {
    return resolved;
  }

  const sourceLabel = contentSourceLabel(resolved);
  const directive = parseExtendsDirective(resolved.content, sourceLabel);
  if (!directive) {
    return resolved;
  }

  if (!resolved.sourcePath) {
    throw new Error(`Facet extends directive in ${sourceLabel} requires a source file path`);
  }

  if (frames.some((frame) => frame.sourcePath && samePath(frame.sourcePath, resolved.sourcePath!))) {
    throw new Error(`Facet inheritance cycle detected: ${formatInheritanceChain(frames, resolved)}`);
  }

  const parent = resolveParentFacetWithSource(directive.parentName, facetType, context, resolved.sourcePath);
  if (!parent) {
    throw new Error(`Facet extends parent "${directive.parentName}" not found for ${sourceLabel}`);
  }

  const expandedParent = expandFacetInheritance(parent, facetType, context, [
    ...frames,
    { sourcePath: resolved.sourcePath, refName: resolved.refName },
  ]);
  return {
    ...resolved,
    content: `${resolved.content.slice(0, directive.start)}${expandedParent.content}${resolved.content.slice(directive.end)}`,
  };
}

export function resolveFacetPath(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): string | undefined {
  if (isScopeRef(name) && context.repertoireDir) {
    const scopeRef = parseScopeRef(name);
    const filePath = resolveScopeRef(scopeRef, facetType, context.repertoireDir);
    if (!existsSync(filePath)) {
      return undefined;
    }
    assertScopedFacetFileIsSafe(filePath, context);
    return filePath;
  }
  const filePath = resolveFacetPathGeneric(name, buildCandidateDirsWithPackage(facetType, context));
  if (filePath) {
    assertFacetFileIsSafe(filePath, facetType, context);
  }
  return filePath;
}

export function resolveFacetByName(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): string | undefined {
  return resolveFacetByNameWithSource(name, facetType, context)?.content;
}

export function resolveFacetByNameWithSource(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): ResolvedFacetContent | undefined {
  const filePath = resolveFacetPath(name, facetType, context);
  if (filePath) {
    return expandFacetInheritance(
      {
        content: readFacetFile(filePath, facetType, context),
        sourcePath: filePath,
        facetType,
        refName: name,
      },
      facetType,
      context,
    );
  }
  return undefined;
}

export function resolveRefToContent(
  ref: string,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string | undefined {
  return resolveRefToContentWithSource(ref, resolvedMap, workflowDir, facetType, context)?.content;
}

function applyFacetIncludes(
  resolved: ResolvedFacetContent | undefined,
  context?: FacetResolutionContext,
): ResolvedFacetContent | undefined {
  if (!resolved || !context || !resolved.sourcePath) return resolved;
  const facetsRoots = buildFacetsRoots(context);
  const sourceLayerIndex = findSourceLayerIndex(resolved.sourcePath, facetsRoots);
  const includeRoots = facetsRoots.slice(sourceLayerIndex ?? 0);
  const { body } = expandFacetIncludes({
    body: resolved.content,
    facetsRoots: includeRoots,
    repertoireDirs: [],
    allowedRoots: includeRoots,
  });
  return body !== resolved.content ? { ...resolved, content: body } : resolved;
}

export function resolveRefToContentWithSource(
  ref: string,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): ResolvedFacetContent | undefined {
  const mapped = resolvedMap?.[ref];
  if (mapped !== undefined) {
    return applyFacetIncludes(expandFacetInheritance(toResolvedContent(mapped, facetType, ref), facetType, context), context);
  }

  if (facetType && context && isScopeRef(ref) && context.repertoireDir) {
    const scopeRef = parseScopeRef(ref);
    const filePath = resolveScopeRef(scopeRef, facetType, context.repertoireDir);
    return existsSync(filePath)
      ? applyFacetIncludes(expandFacetInheritance({
          content: readScopedFacetFile(filePath, context),
          sourcePath: filePath,
          facetType,
          refName: ref,
        }, facetType, context), context)
      : undefined;
  }

  if (isResourcePath(ref)) {
    const resource = resolveResourceContentWithSource(ref, workflowDir, facetType, ref, context);
    return resource ? applyFacetIncludes(expandFacetInheritance(resource, facetType, context), context) : undefined;
  }

  const candidateDirs = facetType && context
    ? buildCandidateDirsWithPackage(facetType, context)
    : undefined;
  if (candidateDirs) {
    const facetContent = resolveFacetFromCandidateDirs(ref, facetType!, candidateDirs, ref, context);
    if (facetContent !== undefined) {
      return applyFacetIncludes(expandFacetInheritance(facetContent, facetType, context), context);
    }
  }

  const resource = resolveResourceContentWithSource(ref, workflowDir, facetType, ref, context);
  return resource ? applyFacetIncludes(expandFacetInheritance(resource, facetType, context), context) : undefined;
}

export function resolveRefList(
  refs: string | string[] | undefined,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string[] | undefined {
  if (refs == null) return undefined;
  const list = Array.isArray(refs) ? refs : [refs];
  const contents: string[] = [];
  for (const ref of list) {
    const content = resolveRefToContent(ref, resolvedMap, workflowDir, facetType, context);
    if (content) contents.push(content);
  }
  return contents.length > 0 ? contents : undefined;
}

export function resolvePersona(
  rawPersona: string | undefined,
  sections: WorkflowSections,
  workflowDir: string,
  context?: FacetResolutionContext,
): { personaSpec?: string; personaPath?: string } {
  if (rawPersona && isScopeRef(rawPersona) && context?.repertoireDir) {
    const scopeRef = parseScopeRef(rawPersona);
    const personaPath = resolveScopeRef(scopeRef, 'personas', context.repertoireDir);
    if (existsSync(personaPath)) {
      assertScopedFacetFileIsSafe(personaPath, context);
      assertAllowedPersonaPath(personaPath, context);
      return { personaSpec: rawPersona, personaPath };
    }
    return { personaSpec: rawPersona, personaPath: undefined };
  }
  const candidateDirs = context
    ? buildCandidateDirsWithPackage('personas', context)
    : undefined;
  const resolved = resolvePersonaGeneric(rawPersona, sections, workflowDir, candidateDirs);
  if (resolved.personaPath) {
    assertFacetFileIsSafe(resolved.personaPath, 'personas', context);
    assertAllowedPersonaPath(resolved.personaPath, context);
  }
  return resolved;
}
