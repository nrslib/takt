import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinSharedStepsDir,
  getGlobalStepsDir,
  getProjectStepsDir,
  getRepertoireStepsDir,
} from '../paths.js';
import { resolveNamedResourceWithSource } from './namedResourceResolver.js';
import {
  getPackageFromWorkflowDir,
  getWorkflowBaseDir,
  getIsolatedWorkflowResourceDir,
  type FacetResolutionContext,
} from './workflowPackageScope.js';

const STEP_FRAGMENT_EXTENSIONS = ['.yaml', '.yml'] as const;

export interface StepFragmentLookupScope {
  context?: FacetResolutionContext;
  candidateDirs?: readonly string[];
  scopedCandidateDirs?: ScopedStepFragmentCandidateDirs;
}

export type ScopedStepFragmentCandidateDirs = ReadonlyMap<string, readonly string[]>;

export interface ResolvedStepFragment {
  path: string;
  candidateDir: string;
  candidateDirs: readonly string[];
}

export function getScopedStepFragmentCandidateKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function requireContext(ref: string, context: FacetResolutionContext | undefined): FacetResolutionContext {
  if (!context) {
    throw new Error(`Configuration error: step fragment requires workflow loader context to resolve "${ref}"`);
  }
  return context;
}

export function buildStepFragmentLookupDirs(context: FacetResolutionContext): string[] {
  const artifactStepsDir = getIsolatedWorkflowResourceDir(context, 'steps');
  if (artifactStepsDir !== undefined) {
    return [artifactStepsDir];
  }

  const dirs: string[] = [];
  if (context.workflowDir && context.repertoireDir) {
    const pkg = getPackageFromWorkflowDir(getWorkflowBaseDir(context.workflowDir), context.repertoireDir);
    if (pkg) {
      dirs.push(getRepertoireStepsDir(pkg.owner, pkg.repo, context.repertoireDir));
    }
  }
  if (context.projectDir) {
    dirs.push(getProjectStepsDir(context.projectDir));
  }
  dirs.push(getGlobalStepsDir());
  dirs.push(getBuiltinLanguageStepsDir(context.lang));
  dirs.push(getBuiltinSharedStepsDir());
  return dirs;
}

function resolveStepFragmentByName(ref: string, candidateDirs: readonly string[]): ResolvedStepFragment | undefined {
  const resolved = resolveNamedResourceWithSource(ref, {
    candidateDirs,
    extensions: STEP_FRAGMENT_EXTENSIONS,
    rejectSymlinkedCandidateDirs: true,
  });
  if (!resolved) {
    return undefined;
  }
  return {
    path: resolved.path,
    candidateDir: resolved.candidateDir,
    candidateDirs: candidateDirs.slice(resolved.candidateDirIndex),
  };
}

export function getStepFragmentLookupDirs(ref: string, scope: StepFragmentLookupScope): readonly string[] {
  if (!ref.startsWith('@')) {
    if (scope.context?.resourceRoot !== undefined) {
      return buildStepFragmentLookupDirs(scope.context);
    }
    return scope.candidateDirs ?? buildStepFragmentLookupDirs(requireContext(ref, scope.context));
  }
  if (!isScopeRef(ref)) {
    throw new Error(`Configuration error: invalid scoped step fragment reference "${ref}"; expected @owner/repo/name`);
  }
  const context = requireContext(ref, scope.context);
  if (context.resourceRoot !== undefined) {
    return buildStepFragmentLookupDirs(context);
  }
  if (!context.repertoireDir) {
    throw new Error(`Configuration error: step fragment requires repertoireDir to resolve scoped reference "${ref}"`);
  }
  const scopeRef = parseScopeRef(ref);
  return scope.scopedCandidateDirs?.get(getScopedStepFragmentCandidateKey(scopeRef.owner, scopeRef.repo))
    ?? [getRepertoireStepsDir(scopeRef.owner, scopeRef.repo, context.repertoireDir)];
}

function resolveScopedStepFragment(ref: string, scope: StepFragmentLookupScope): ResolvedStepFragment | undefined {
  const scopeRef = parseScopeRef(ref);
  return resolveStepFragmentByName(scopeRef.name, getStepFragmentLookupDirs(ref, scope));
}

export function resolveStepFragment(
  ref: string,
  scope: StepFragmentLookupScope,
): ResolvedStepFragment | undefined {
  if (ref.startsWith('@')) {
    return resolveScopedStepFragment(ref, scope);
  }
  return resolveStepFragmentByName(ref, getStepFragmentLookupDirs(ref, scope));
}
