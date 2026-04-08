import { dirname, resolve } from 'node:path';
import type { FacetType } from '../paths.js';
import {
  getBuiltinFacetDir,
  getGlobalFacetDir,
  getProjectFacetDir,
  getRepertoireFacetDir,
} from '../paths.js';
import type { Language } from '../../../core/models/index.js';

export interface FacetResolutionContext {
  projectDir?: string;
  lang: Language;
  workflowDir?: string;
  repertoireDir?: string;
}

function normalizeWorkflowBaseDir(workflowDir: string): string {
  if (workflowDir.endsWith('.yaml') || workflowDir.endsWith('.yml')) {
    return dirname(workflowDir);
  }
  return workflowDir;
}

export function isPackageWorkflow(workflowDir: string, repertoireDir: string): boolean {
  const resolvedWorkflow = resolve(workflowDir);
  const resolvedRepertoire = resolve(repertoireDir);
  return resolvedWorkflow.startsWith(`${resolvedRepertoire}/`);
}

export function getPackageFromWorkflowDir(
  workflowDir: string,
  repertoireDir: string,
): { owner: string; repo: string } | undefined {
  if (!isPackageWorkflow(workflowDir, repertoireDir)) {
    return undefined;
  }
  const resolvedRepertoire = resolve(repertoireDir);
  const resolvedWorkflow = resolve(workflowDir);
  const relative = resolvedWorkflow.slice(resolvedRepertoire.length + 1);
  const parts = relative.split('/');
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

export function getWorkflowBaseDir(workflowDir: string): string {
  return normalizeWorkflowBaseDir(workflowDir);
}
