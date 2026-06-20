import * as fs from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isScopeRef } from 'faceted-prompting';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { StepProviderOptionsObjectSchema } from '../../../core/models/schema-base.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import { isPathInside } from '../../../shared/utils/index.js';
import { mergeProviderOptions, normalizeProviderOptions } from '../providerOptions.js';
import type { FacetResolutionContext } from './workflowPackageScope.js';
import {
  buildProviderOptionsLookupDirs,
  resolveProviderOptionsByName,
  resolveProviderOptionsScopeRef,
  type ScopedProviderOptionsCandidateDirs,
} from './providerOptionsLookupDirectories.js';

type RawWorkflowProviderOptions = Record<string, unknown> & {
  extends?: string;
};

interface ResolvedProviderOptionsExtendsPath {
  path: string;
  realPath: string;
  kind: 'path' | 'name' | 'scope';
  candidateDirs?: readonly string[];
}

interface ProviderOptionsResolutionScope {
  context?: FacetResolutionContext;
  candidateDirs?: readonly string[];
  scopedCandidateDirs?: ScopedProviderOptionsCandidateDirs;
}

export interface ProviderOptionsFileAccess {
  exists(path: string): boolean;
  readText(path: string): string;
  realpath(path: string): string;
  isSymlink?(path: string): boolean;
}

export interface WorkflowProviderOptionsResolutionHost extends ProviderOptionsResolutionScope {
  rootDir: string;
  fileAccess?: ProviderOptionsFileAccess;
}

const nodeFileAccess: ProviderOptionsFileAccess = {
  exists: (path) => fs.existsSync(path),
  readText: (path) => fs.readFileSync(path, 'utf-8'),
  realpath: (path) => fs.realpathSync(path),
  isSymlink: (path) => fs.lstatSync(path).isSymbolicLink(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeProviderOptionsExtends(raw: RawWorkflowProviderOptions): Record<string, unknown> | undefined {
  const inline = { ...raw };
  delete inline.extends;
  return Object.keys(inline).length > 0 ? inline : undefined;
}

const ProviderOptionsWithExtendsSchema = StepProviderOptionsObjectSchema.extend({
  extends: z.string().min(1).optional(),
}).strict();

function isProviderOptionsExtendsPath(ref: string): boolean {
  return ref.startsWith('./')
    || ref.startsWith('../')
    || ref.startsWith('/')
    || ref.startsWith('~')
    || ref.includes('/')
    || ref.includes('\\')
    || ref.endsWith('.yaml')
    || ref.endsWith('.yml');
}

function requireProviderOptionsContext(ref: string, context: FacetResolutionContext | undefined): FacetResolutionContext {
  if (!context) {
    throw new Error(`Configuration error: provider_options.extends requires workflow loader context to resolve named resource: ${ref}`);
  }
  return context;
}

function resolvePathLikeProviderOptionsExtends(
  ref: string,
  currentDir: string,
  rootDir: string,
  fileAccess: ProviderOptionsFileAccess,
): ResolvedProviderOptionsExtendsPath {
  if (isAbsolute(ref)) {
    throw new Error(`Configuration error: provider_options.extends must be a relative path inside the workflow directory: ${ref}`);
  }

  const refPath = resolve(currentDir, ref);
  const resolvedRootDir = resolve(rootDir);
  if (!isPathInside(resolvedRootDir, refPath)) {
    throw new Error(`Configuration error: provider_options.extends must stay inside the workflow directory: ${ref}`);
  }

  if (!fileAccess.exists(refPath)) {
    throw new Error(`Configuration error: provider_options.extends not found: ${ref}`);
  }

  const realRootDir = fileAccess.realpath(rootDir);
  const realRefPath = fileAccess.realpath(refPath);
  if (!isPathInside(realRootDir, realRefPath)) {
    throw new Error(`Configuration error: provider_options.extends must stay inside the workflow directory: ${ref}`);
  }

  return { path: refPath, realPath: realRefPath, kind: 'path' };
}

function getProviderOptionsCandidateDirs(scope: ProviderOptionsResolutionScope, ref: string): readonly string[] {
  if (scope.candidateDirs) {
    return scope.candidateDirs;
  }
  const context = requireProviderOptionsContext(ref, scope.context);
  return buildProviderOptionsLookupDirs(context);
}

function resolveProviderOptionsByNameExtends(
  name: string,
  candidateDirs: readonly string[],
  fileAccess: ProviderOptionsFileAccess,
): ResolvedProviderOptionsExtendsPath | undefined {
  const resolved = resolveProviderOptionsByName(name, candidateDirs, fileAccess);
  return resolved
    ? {
        path: resolved.path,
        realPath: fileAccess.realpath(resolved.path),
        kind: 'name',
        candidateDirs: candidateDirs.slice(resolved.sourceLayerIndex),
      }
    : undefined;
}

function resolveProviderOptionsScopeRefPath(
  ref: string,
  context: FacetResolutionContext,
  fileAccess: ProviderOptionsFileAccess,
  scopedCandidateDirs: ScopedProviderOptionsCandidateDirs | undefined,
): ResolvedProviderOptionsExtendsPath | undefined {
  const resolved = resolveProviderOptionsScopeRef(ref, context, fileAccess, scopedCandidateDirs);
  return resolved
    ? {
        path: resolved.path,
        realPath: fileAccess.realpath(resolved.path),
        kind: 'scope',
        candidateDirs: [resolved.candidateDir],
      }
    : undefined;
}

function resolveProviderOptionsExtendsPath(
  ref: string,
  currentDir: string,
  rootDir: string,
  scope: ProviderOptionsResolutionScope,
  fileAccess: ProviderOptionsFileAccess,
): ResolvedProviderOptionsExtendsPath {
  if (isScopeRef(ref)) {
    const resolved = resolveProviderOptionsScopeRefPath(
      ref,
      requireProviderOptionsContext(ref, scope.context),
      fileAccess,
      scope.scopedCandidateDirs,
    );
    if (!resolved) {
      throw new Error(`Configuration error: provider_options.extends not found: ${ref}`);
    }
    return resolved;
  }

  if (isProviderOptionsExtendsPath(ref)) {
    return resolvePathLikeProviderOptionsExtends(ref, currentDir, rootDir, fileAccess);
  }

  const candidateDirs = getProviderOptionsCandidateDirs(scope, ref);
  const resolved = resolveProviderOptionsByNameExtends(ref, candidateDirs, fileAccess);
  if (!resolved) {
    throw new Error(`Configuration error: provider_options.extends not found: ${ref}`);
  }
  return resolved;
}

export function resolveWorkflowProviderOptions(
  raw: RawWorkflowProviderOptions | undefined,
  workflowDir: string,
  context?: FacetResolutionContext,
): StepProviderOptions | undefined {
  return resolveWorkflowProviderOptionsWithHost(raw, workflowDir, {
    rootDir: workflowDir,
    context,
  });
}

export function resolveWorkflowProviderOptionsWithHost(
  raw: RawWorkflowProviderOptions | undefined,
  workflowDir: string,
  host: WorkflowProviderOptionsResolutionHost,
): StepProviderOptions | undefined {
  return resolveWorkflowProviderOptionsFromDir(
    raw,
    workflowDir,
    host.rootDir,
    {
      context: host.context,
      candidateDirs: host.candidateDirs,
      scopedCandidateDirs: host.scopedCandidateDirs,
    },
    host.fileAccess ?? nodeFileAccess,
    new Set<string>(),
  );
}

function resolveWorkflowProviderOptionsFromDir(
  raw: RawWorkflowProviderOptions | undefined,
  currentDir: string,
  rootDir: string,
  scope: ProviderOptionsResolutionScope,
  fileAccess: ProviderOptionsFileAccess,
  seenRefs: Set<string>,
): StepProviderOptions | undefined {
  if (!raw) {
    return undefined;
  }

  const parsedRaw = ProviderOptionsWithExtendsSchema.parse(raw) as RawWorkflowProviderOptions;
  const ref = parsedRaw.extends;
  if (ref === undefined) {
    return normalizeProviderOptions(parsedRaw, {
      baseUrlTrust: 'loopback-only',
      pathPrefix: 'provider_options',
    });
  }

  const refPath = resolveProviderOptionsExtendsPath(ref, currentDir, rootDir, scope, fileAccess);
  if (seenRefs.has(refPath.realPath)) {
    throw new Error(`Configuration error: provider_options.extends contains a circular reference: ${ref}`);
  }

  const referencedRaw = parseYaml(fileAccess.readText(refPath.path));
  if (!isRecord(referencedRaw)) {
    throw new Error(`Configuration error: provider_options.extends must point to a YAML object: ${ref}`);
  }
  const parsedReferencedRaw = ProviderOptionsWithExtendsSchema.parse(referencedRaw) as RawWorkflowProviderOptions;

  const nextSeenRefs = new Set(seenRefs);
  nextSeenRefs.add(refPath.realPath);
  const referencedOptions = resolveWorkflowProviderOptionsFromDir(
    parsedReferencedRaw,
    dirname(refPath.path),
    refPath.kind === 'path' ? rootDir : dirname(refPath.path),
    {
      context: scope.context,
      candidateDirs: refPath.candidateDirs ?? scope.candidateDirs,
      scopedCandidateDirs: scope.scopedCandidateDirs,
    },
    fileAccess,
    nextSeenRefs,
  );
  const inlineOptions = normalizeProviderOptions(removeProviderOptionsExtends(parsedRaw), {
    baseUrlTrust: 'loopback-only',
    pathPrefix: 'provider_options',
  });
  return mergeProviderOptions(referencedOptions, inlineOptions);
}
