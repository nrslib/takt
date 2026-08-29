import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  isScopeRef,
} from 'faceted-prompting';

export type { FacetResolutionContext } from './workflowPackageScope.js';

export interface ResolvedFacetContent {
  content: string;
  sourcePath?: string;
  facetType?: FacetType;
  refName?: string;
  literalContent?: true;
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

function isSelectorInstructionResourcePath(spec: string): boolean {
  return isResourcePath(spec) && !/\s/.test(spec);
}

function assertSelectorInstructionResourcePathExtension(spec: string): void {
  if (isSelectorInstructionResourcePath(spec) && !spec.endsWith('.md')) {
    throw new Error(`Selector instruction resource path must use a .md file: ${spec}`);
  }
}

function selectorInstructionFacetRoots(
  context: FacetResolutionContext | undefined,
  includeRepertoireRoot: boolean,
): readonly string[] {
  if (!context) {
    return [];
  }
  return [
    ...buildCandidateDirsWithPackage('instructions', context),
    ...(includeRepertoireRoot && context.repertoireDir ? [context.repertoireDir] : []),
  ];
}

function assertSelectorInstructionFileIsSafe(
  filePath: string,
  context: FacetResolutionContext | undefined,
  includeRepertoireRoot = false,
): void {
  const allowedRoot = selectorInstructionFacetRoots(context, includeRepertoireRoot)
    .find((root) => isPathInside(root, filePath));
  if (!allowedRoot) {
    throw new Error(`Selector instruction file must stay inside an allowed instruction facet root: ${filePath}`);
  }

  const stats = assertPathSegmentsAreSafe(
    allowedRoot,
    filePath,
    (_violation, segmentPath) => new Error(`Selector instruction file must stay inside an allowed instruction facet root and must not use symlinks: ${segmentPath}`),
  );
  if (!stats) {
    throw new Error(`Selector instruction file not found: ${filePath}`);
  }

  const rootStats = lstatSync(allowedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Selector instruction facet root must be a directory and must not be a symlink: ${allowedRoot}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Selector instruction file must be a regular file and must not be a symlink: ${filePath}`);
  }

  const realRoot = realpathSync(allowedRoot);
  const realFilePath = realpathSync(filePath);
  if (!isPathInside(realRoot, realFilePath)) {
    throw new Error(`Selector instruction file must stay inside an allowed instruction facet root: ${filePath}`);
  }
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
  trustedRoot?: string,
  requireFile?: boolean,
  selectorInstruction = false,
): ResolvedFacetContent | undefined {
  if (spec == null) {
    return undefined;
  }
  if (selectorInstruction) {
    assertSelectorInstructionResourcePathExtension(spec);
  }
  if (spec.endsWith('.md') && (!selectorInstruction || !/\s/.test(spec))) {
    const resolved = resolveResourcePath(spec, workflowDir);
    if (existsSync(resolved)) {
      if (selectorInstruction) {
        assertSelectorInstructionFileIsSafe(resolved, context);
      }
      if (trustedRoot !== undefined) {
        assertPathSegmentsAreSafe(
          trustedRoot,
          resolved,
          (_violation, segmentPath) => new Error(`External facet pool resource must stay inside the pool source layer root: ${segmentPath}`),
        );
      }
      return {
        content: readResourceFile(resolved, facetType, workflowDir, context),
        sourcePath: resolved,
        facetType,
        refName,
      };
    }
    if (requireFile === true) {
      throw new Error(`Facet resource file not found: ${resolved}`);
    }
  }
  return { content: spec, facetType, refName };
}

export function resolveSectionMapWithSource(
  raw: Record<string, string> | undefined,
  workflowDir: string,
  facetType: FacetType,
  context?: FacetResolutionContext,
  trustedRoot?: string,
  selectorInstructionRefs?: ReadonlySet<string>,
): ResolvedSectionMap | undefined {
  if (!raw) {
    return undefined;
  }
  const resolved: ResolvedSectionMap = {};
  for (const [name, value] of Object.entries(raw)) {
    const selectorInstruction = facetType === 'instructions'
      && selectorInstructionRefs?.has(name) === true;
    const requireFile = selectorInstruction
      && isResourcePath(value)
      && !/\s/.test(value);
    const content = resolveResourceContentWithSource(
      value,
      workflowDir,
      facetType,
      name,
      context,
      trustedRoot,
      requireFile,
      selectorInstruction,
    );
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
  selectorInstruction = false,
): ResolvedFacetContent | undefined {
  for (const dir of candidateDirs) {
    const filePath = join(dir, `${name}.md`);
    if (excludeSourcePath && samePath(filePath, excludeSourcePath)) {
      continue;
    }
    if (existsSync(filePath) && readdirSync(dirname(filePath)).includes(basename(filePath))) {
      if (selectorInstruction) {
        assertSelectorInstructionFileIsSafe(filePath, context);
      }
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
  selectorInstruction = false,
): ResolvedFacetContent | undefined {
  if (!context) {
    return undefined;
  }

  const candidateDirs = buildCandidateDirsWithPackage(facetType, context);
  const sourceLayerIndex = findSourceLayerIndex(currentSourcePath, candidateDirs);
  const searchDirs = candidateDirs.slice(sourceLayerIndex ?? 0);
  return resolveFacetFromCandidateDirs(
    parentName,
    facetType,
    searchDirs,
    parentName,
    context,
    currentSourcePath,
    selectorInstruction,
  );
}

function expandFacetInheritance(
  resolved: ResolvedFacetContent,
  facetType: FacetType | undefined,
  context: FacetResolutionContext | undefined,
  frames: FacetInheritanceFrame[] = [],
  selectorInstruction = false,
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

  const parent = resolveParentFacetWithSource(
    directive.parentName,
    facetType,
    context,
    resolved.sourcePath,
    selectorInstruction,
  );
  if (!parent) {
    throw new Error(`Facet extends parent "${directive.parentName}" not found for ${sourceLabel}`);
  }

  const expandedParent = expandFacetInheritance(parent, facetType, context, [
    ...frames,
    { sourcePath: resolved.sourcePath, refName: resolved.refName },
  ], selectorInstruction);
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
  if (isScopeRef(name) && context.resourceRoot === undefined && context.repertoireDir) {
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
    if (!readdirSync(dirname(filePath)).includes(basename(filePath))) {
      return undefined;
    }
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

export interface ResolveRefToContentWithSourceOptions {
  /**
   * 当該呼出が facet pool の自己完結解決（context === undefined）のように
   * bare facet name への最終フォールバックを許可しない境界で実行されている場合 true。
   * true のとき、context === undefined かつ bare ref（`isResourcePath(ref)` false・
   * `isScopeRef(ref)` false）が section map・candidate dirs のいずれでも解決できなかった
   * 場合は、ref 名を content とする最終フォールバックを skip し undefined を返す。
   * 呼出元は undefined を fail-fast として扱う。既存の汎用呼出元は未指定で従来通り
   * 最終フォールバックを維持する。
   */
  readonly strictBareName?: boolean;
  /**
   * external facet pool 境界など、facet ファイル解決後に resolved パスが
   * 指定 root に留まることを検証する必要がある呼出元で指定する。
   * `resolveResourceContentWithSource` が read 前に `assertPathSegmentsAreSafe`
   * で境界チェックを行う。未指定の場合は従来通りの境界チェック動作を維持する。
   */
  readonly trustedRoot?: string;
  /**
   * true のとき、.md パス参照がファイルに解決できない場合は undefined を返さず
   * fail-fast で例外を投げる。facet pool の候補参照など、存在しない .md が
   * リテラル文字列として本文に混入するのを防ぐために指定する。
   */
  readonly requireFile?: boolean;
  /** selector instruction の path-like resource を許可 facet root に限定する。 */
  readonly selectorInstruction?: boolean;
}

export function resolveSelectorInstruction(
  ref: string,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  context?: FacetResolutionContext,
): string | undefined {
  assertSelectorInstructionResourcePathExtension(ref);
  return resolveRefToContentWithSource(
    ref,
    resolvedMap,
    workflowDir,
    'instructions',
    context,
    {
      selectorInstruction: true,
      ...(isSelectorInstructionResourcePath(ref) ? { requireFile: true } : {}),
    },
  )?.content;
}

export function resolveRefToContentWithSource(
  ref: string,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
  options?: ResolveRefToContentWithSourceOptions,
): ResolvedFacetContent | undefined {
  const mapped = resolvedMap?.[ref];
  if (mapped !== undefined) {
    const resolved = toResolvedContent(mapped, facetType, ref);
    if (options?.selectorInstruction && resolved.sourcePath !== undefined) {
      assertSelectorInstructionResourcePathExtension(resolved.sourcePath);
      assertSelectorInstructionFileIsSafe(resolved.sourcePath, context);
    }
    if (
      options?.requireFile === true
      && resolved.sourcePath === undefined
      && (options.selectorInstruction
        ? isSelectorInstructionResourcePath(resolved.content)
        : resolved.content.endsWith('.md'))
    ) {
      const resource = resolveResourceContentWithSource(
        resolved.content,
        workflowDir,
        facetType,
        ref,
        context,
        options.trustedRoot,
        true,
        options.selectorInstruction === true,
      );
      if (resource === undefined) return undefined;
      return applyFacetIncludes(
        expandFacetInheritance(resource, facetType, context, [], options.selectorInstruction === true),
        context,
      );
    }
    return applyFacetIncludes(expandFacetInheritance(resolved, facetType, context, [], options?.selectorInstruction === true), context);
  }

  if (facetType && context && isScopeRef(ref) && context.resourceRoot === undefined && context.repertoireDir) {
    const scopeRef = parseScopeRef(ref);
    const filePath = resolveScopeRef(scopeRef, facetType, context.repertoireDir);
    if (options?.selectorInstruction && existsSync(filePath)) {
      assertSelectorInstructionFileIsSafe(filePath, context, true);
    }
    return existsSync(filePath)
      ? applyFacetIncludes(expandFacetInheritance({
          content: readScopedFacetFile(filePath, context),
          sourcePath: filePath,
          facetType,
          refName: ref,
        }, facetType, context, [], options?.selectorInstruction === true), context)
      : undefined;
  }

  if (options?.selectorInstruction === true && isScopeRef(ref)) {
    return undefined;
  }

  if (context?.resourceRoot !== undefined && isScopeRef(ref)) {
    return undefined;
  }

  if (isResourcePath(ref)) {
    if (options?.selectorInstruction && isSelectorInstructionResourcePath(ref)) {
      assertSelectorInstructionFileIsSafe(resolveResourcePath(ref, workflowDir), context);
    }
    const resource = resolveResourceContentWithSource(
      ref,
      workflowDir,
      facetType,
      ref,
      context,
      options?.trustedRoot,
      options?.requireFile,
      options?.selectorInstruction === true,
    );
    return resource
      ? applyFacetIncludes(expandFacetInheritance(resource, facetType, context, [], options?.selectorInstruction === true), context)
      : undefined;
  }

  const candidateDirs = facetType && context
    ? buildCandidateDirsWithPackage(facetType, context)
    : undefined;
  if (candidateDirs) {
    const facetContent = resolveFacetFromCandidateDirs(
      ref,
      facetType!,
      candidateDirs,
      ref,
      context,
      undefined,
      options?.selectorInstruction === true,
    );
    if (facetContent !== undefined) {
      return applyFacetIncludes(
        expandFacetInheritance(facetContent, facetType, context, [], options?.selectorInstruction === true),
        context,
      );
    }
  }

  // Facet pool self-contained resolution (context === undefined) must not fall back to
  // using a bare ref name as content for a bare facet name that missed every resolution
  // layer. The compileExternalPool boundary opts into fail-fast via strictBareName so
  // pool-external bare names throw at the caller instead of being silently captured.
  const isBareName = !isResourcePath(ref) && !isScopeRef(ref);
  if (options?.strictBareName === true && context === undefined && isBareName) {
    return undefined;
  }

  // Selector guidance treats a whitespace-free bare value as a named facet
  // reference. Do not silently turn a missing name into the instruction text;
  // whitespace-containing values remain supported as inline guidance.
  if (options?.selectorInstruction === true && isBareName && !/\s/.test(ref)) {
    return undefined;
  }

  const resource = resolveResourceContentWithSource(
    ref,
    workflowDir,
    facetType,
    ref,
    context,
    options?.trustedRoot,
    undefined,
    options?.selectorInstruction === true,
  );
  return resource
    ? applyFacetIncludes(
      expandFacetInheritance(
        { ...resource, literalContent: true },
        facetType,
        context,
        [],
        options?.selectorInstruction === true,
      ),
      context,
    )
    : undefined;
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

export function resolveRefListWithSource(
  refs: string | string[] | undefined,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): ResolvedFacetContent[] | undefined {
  if (refs == null) return undefined;
  const list = Array.isArray(refs) ? refs : [refs];
  const contents: ResolvedFacetContent[] = [];
  for (const ref of list) {
    const resolved = resolveRefToContentWithSource(ref, resolvedMap, workflowDir, facetType, context);
    if (resolved) contents.push(resolved);
  }
  return contents.length > 0 ? contents : undefined;
}

export function resolvePersona(
  rawPersona: string | undefined,
  sections: WorkflowSections,
  workflowDir: string,
  context?: FacetResolutionContext,
): { personaSpec?: string; personaPath?: string } {
  if (rawPersona && isScopeRef(rawPersona) && context?.resourceRoot === undefined && context?.repertoireDir) {
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
