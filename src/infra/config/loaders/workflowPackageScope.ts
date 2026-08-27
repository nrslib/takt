import * as path from 'node:path';
import type { FacetType } from '../paths.js';
import {
  getBuiltinFacetDir,
  getGlobalConfigDir,
  getGlobalFacetDir,
  getProjectConfigDir,
  getProjectFacetDir,
  getRepertoireFacetDir,
} from '../paths.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import type { Language } from '../../../core/models/index.js';

type PathOperations = Pick<typeof path, 'dirname' | 'isAbsolute' | 'join' | 'relative' | 'resolve' | 'sep'>;

export interface FacetResolutionContext {
  projectDir?: string;
  lang: Language;
  workflowDir?: string;
  repertoireDir?: string;
  resourceRoot?: string;
}

export function getIsolatedWorkflowResourceDir(
  context: FacetResolutionContext,
  siblingName: 'companions' | 'facets' | 'facet-pools' | 'provider-options' | 'steps' | 'workflows',
): string | undefined {
  return context.resourceRoot === undefined
    ? undefined
    : path.join(context.resourceRoot, siblingName);
}

function normalizeWorkflowBaseDir(workflowDir: string): string {
  if (workflowDir.endsWith('.yaml') || workflowDir.endsWith('.yml')) {
    return path.dirname(workflowDir);
  }
  return workflowDir;
}

export function isPackageWorkflow(workflowDir: string, repertoireDir: string, pathOperations: PathOperations = path): boolean {
  const relativePath = pathOperations.relative(
    pathOperations.resolve(repertoireDir),
    pathOperations.resolve(workflowDir),
  );
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathOperations.sep}`)
    && !pathOperations.isAbsolute(relativePath);
}

export function getPackageFromWorkflowDir(
  workflowDir: string,
  repertoireDir: string,
  pathOperations: PathOperations = path,
): { owner: string; repo: string } | undefined {
  if (!isPackageWorkflow(workflowDir, repertoireDir, pathOperations)) {
    return undefined;
  }
  const relativePath = pathOperations.relative(
    pathOperations.resolve(repertoireDir),
    pathOperations.resolve(workflowDir),
  );
  const parts = relativePath.split(pathOperations.sep);
  if (parts.length < 2) {
    return undefined;
  }
  const ownerWithAt = parts[0];
  if (!ownerWithAt || !ownerWithAt.startsWith('@')) {
    return undefined;
  }
  const owner = ownerWithAt.slice(1);
  const repo = parts[1];
  if (!repo) {
    return undefined;
  }
  return { owner, repo };
}

export function buildCandidateDirsWithPackage(
  facetType: FacetType,
  context: FacetResolutionContext,
): string[] {
  const artifactFacetsDir = getIsolatedWorkflowResourceDir(context, 'facets');
  if (artifactFacetsDir !== undefined) {
    return [path.join(artifactFacetsDir, facetType)];
  }

  const dirs: string[] = [];

  if (context.workflowDir && context.repertoireDir) {
    const workflowBaseDir = normalizeWorkflowBaseDir(context.workflowDir);
    const pkg = getPackageFromWorkflowDir(workflowBaseDir, context.repertoireDir);
    if (pkg) {
      dirs.push(getRepertoireFacetDir(pkg.owner, pkg.repo, facetType, context.repertoireDir));
    }
  }

  if (context.projectDir) {
    dirs.push(getProjectFacetDir(context.projectDir, facetType));
  }
  dirs.push(getGlobalFacetDir(facetType));
  dirs.push(getBuiltinFacetDir(context.lang, facetType));

  return dirs;
}

export function buildFacetsRoots(context: FacetResolutionContext): string[] {
  const artifactFacetsDir = getIsolatedWorkflowResourceDir(context, 'facets');
  if (artifactFacetsDir !== undefined) {
    return [artifactFacetsDir];
  }

  const roots: string[] = [];

  if (context.workflowDir && context.repertoireDir) {
    const workflowBaseDir = normalizeWorkflowBaseDir(context.workflowDir);
    const pkg = getPackageFromWorkflowDir(workflowBaseDir, context.repertoireDir);
    if (pkg) {
      const base = context.repertoireDir;
      roots.push(path.join(base, `@${pkg.owner}`, pkg.repo, 'facets'));
    }
  }

  if (context.projectDir) {
    roots.push(path.join(getProjectConfigDir(context.projectDir), 'facets'));
  }
  roots.push(path.join(getGlobalConfigDir(), 'facets'));
  roots.push(path.join(getLanguageResourcesDir(context.lang), 'facets'));

  return roots;
}

export function getWorkflowBaseDir(workflowDir: string): string {
  return normalizeWorkflowBaseDir(workflowDir);
}
