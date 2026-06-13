import { parseScopeRef } from 'faceted-prompting';
import {
  getBuiltinProviderOptionsDir,
  getGlobalProviderOptionsDir,
  getProjectProviderOptionsDir,
  getRepertoireProviderOptionsDir,
} from '../paths.js';
import type { FacetResolutionContext } from './workflowPackageScope.js';
import { getPackageFromWorkflowDir, getWorkflowBaseDir } from './workflowPackageScope.js';
import { resolveNamedResourceWithSource, type NamedResourceFileAccess } from './namedResourceResolver.js';

const PROVIDER_OPTIONS_EXTENSIONS = ['.yaml', '.yml'] as const;

export interface ResolvedProviderOptionsResource {
  path: string;
  candidateDir: string;
  sourceLayerIndex: number;
}

export type ScopedProviderOptionsCandidateDirs = ReadonlyMap<string, readonly string[]>;

export function getScopedProviderOptionsCandidateKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function buildProviderOptionsLookupDirs(context: FacetResolutionContext): string[] {
  const dirs: string[] = [];
  const builtinProviderOptionsDir = getBuiltinProviderOptionsDir(context.lang);

  if (context.workflowDir && context.repertoireDir) {
    const pkg = getPackageFromWorkflowDir(getWorkflowBaseDir(context.workflowDir), context.repertoireDir);
    if (pkg) {
      dirs.push(getRepertoireProviderOptionsDir(pkg.owner, pkg.repo, context.repertoireDir));
    }
  }

  if (context.projectDir) {
    dirs.push(getProjectProviderOptionsDir(context.projectDir));
  }
  dirs.push(getGlobalProviderOptionsDir());
  dirs.push(builtinProviderOptionsDir);

  return dirs;
}

export function resolveProviderOptionsByName(
  name: string,
  candidateDirs: readonly string[],
  fileAccess?: NamedResourceFileAccess,
): ResolvedProviderOptionsResource | undefined {
  const resolved = resolveNamedResourceWithSource(name, {
    candidateDirs,
    extensions: PROVIDER_OPTIONS_EXTENSIONS,
    fileAccess,
  });
  if (!resolved) {
    return undefined;
  }
  return {
    path: resolved.path,
    candidateDir: resolved.candidateDir,
    sourceLayerIndex: resolved.candidateDirIndex,
  };
}

export function resolveProviderOptionsScopeRef(
  ref: string,
  context: FacetResolutionContext,
  fileAccess?: NamedResourceFileAccess,
  scopedCandidateDirs?: ScopedProviderOptionsCandidateDirs,
): ResolvedProviderOptionsResource | undefined {
  if (!context.repertoireDir) {
    throw new Error(`Configuration error: provider_options.$ref requires repertoireDir to resolve scope reference: ${ref}`);
  }

  const scopeRef = parseScopeRef(ref);
  const candidateDirs = scopedCandidateDirs?.get(getScopedProviderOptionsCandidateKey(scopeRef.owner, scopeRef.repo))
    ?? [getRepertoireProviderOptionsDir(scopeRef.owner, scopeRef.repo, context.repertoireDir)];
  const resolved = resolveNamedResourceWithSource(scopeRef.name, {
    candidateDirs,
    extensions: PROVIDER_OPTIONS_EXTENSIONS,
    fileAccess,
  });
  if (!resolved) {
    return undefined;
  }
  return {
    path: resolved.path,
    candidateDir: resolved.candidateDir,
    sourceLayerIndex: resolved.candidateDirIndex,
  };
}
