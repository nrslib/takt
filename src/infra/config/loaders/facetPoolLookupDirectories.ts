import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import {
  getBuiltinLanguageFacetPoolsDir,
  getBuiltinSharedFacetPoolsDir,
  getGlobalFacetPoolsDir,
  getProjectFacetPoolsDir,
  getRepertoireFacetPoolsDir,
} from '../paths.js';
import { resolveNamedResourceWithSource } from './namedResourceResolver.js';
import {
  getPackageFromWorkflowDir,
  getWorkflowBaseDir,
  getIsolatedWorkflowResourceDir,
  type FacetResolutionContext,
} from './workflowPackageScope.js';

const FACET_POOL_EXTENSIONS = ['.yaml', '.yml'] as const;

export interface ResolvedFacetPoolResource {
  path: string;
  candidateDir: string;
  candidateDirs: readonly string[];
}

export function buildFacetPoolLookupDirs(context: FacetResolutionContext): string[] {
  const artifactFacetPoolsDir = getIsolatedWorkflowResourceDir(context, 'facet-pools');
  if (artifactFacetPoolsDir !== undefined) {
    return [artifactFacetPoolsDir];
  }

  const dirs: string[] = [];
  if (context.workflowDir && context.repertoireDir) {
    const pkg = getPackageFromWorkflowDir(getWorkflowBaseDir(context.workflowDir), context.repertoireDir);
    if (pkg) {
      dirs.push(getRepertoireFacetPoolsDir(pkg.owner, pkg.repo, context.repertoireDir));
    }
  }
  if (context.projectDir) {
    dirs.push(getProjectFacetPoolsDir(context.projectDir));
  }
  dirs.push(getGlobalFacetPoolsDir());
  dirs.push(getBuiltinLanguageFacetPoolsDir(context.lang));
  dirs.push(getBuiltinSharedFacetPoolsDir());
  return dirs;
}

function requireContext(ref: string, context: FacetResolutionContext | undefined): FacetResolutionContext {
  if (!context) {
    throw new Error(`Configuration error: facet pool requires workflow loader context to resolve "${ref}"`);
  }
  return context;
}

export function getFacetPoolLookupDirs(
  ref: string,
  context: FacetResolutionContext | undefined,
  candidateDirs?: readonly string[],
  scopedCandidateDirs?: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (!ref.startsWith('@')) {
    if (context?.resourceRoot !== undefined) {
      return buildFacetPoolLookupDirs(context);
    }
    return candidateDirs ?? buildFacetPoolLookupDirs(requireContext(ref, context));
  }
  if (!isScopeRef(ref)) {
    throw new Error(`Configuration error: invalid scoped facet pool reference "${ref}"; expected @owner/repo/name`);
  }
  const resolvedContext = requireContext(ref, context);
  if (resolvedContext.resourceRoot !== undefined) {
    return buildFacetPoolLookupDirs(resolvedContext);
  }
  if (!resolvedContext.repertoireDir) {
    throw new Error(`Configuration error: facet pool requires repertoireDir to resolve scoped reference "${ref}"`);
  }
  const scopeRef = parseScopeRef(ref);
  const key = `${scopeRef.owner}/${scopeRef.repo}`;
  return scopedCandidateDirs?.get(key)
    ?? [getRepertoireFacetPoolsDir(scopeRef.owner, scopeRef.repo, resolvedContext.repertoireDir)];
}

export function resolveFacetPoolResource(
  ref: string,
  context: FacetResolutionContext | undefined,
  options: {
    candidateDirs?: readonly string[];
    scopedCandidateDirs?: ReadonlyMap<string, readonly string[]>;
  } = {},
): ResolvedFacetPoolResource | undefined {
  const dirs = getFacetPoolLookupDirs(ref, context, options.candidateDirs, options.scopedCandidateDirs);
  const name = ref.startsWith('@') ? parseScopeRef(ref).name : ref;
  const resolved = resolveNamedResourceWithSource(name, {
    candidateDirs: dirs,
    extensions: FACET_POOL_EXTENSIONS,
    rejectSymlinkedCandidateDirs: true,
  });
  if (!resolved) {
    return undefined;
  }
  return {
    path: resolved.path,
    candidateDir: resolved.candidateDir,
    candidateDirs: dirs.slice(resolved.candidateDirIndex),
  };
}
