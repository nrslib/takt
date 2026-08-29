import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import type { FacetType } from '../../infra/config/paths.js';
import {
  getBuiltinWorkflowsDir,
  getGlobalSchemasDir,
  getGlobalWorkflowsDir,
  getProjectSchemasDir,
  getProjectWorkflowsDir,
  getRepertoireFacetDir,
  getRepertoireDir,
} from '../../infra/config/paths.js';
import { getResourcesDir } from '../../infra/resources/index.js';
import { resolveWorkflowConfigValue } from '../../infra/config/resolveWorkflowConfigValue.js';
import {
  getFacetPoolLookupDirs,
  resolveFacetPoolResource,
} from '../../infra/config/loaders/facetPoolLookupDirectories.js';
import { resolveFacetPath } from '../../infra/config/loaders/resource-resolver.js';
import {
  getStepFragmentLookupDirs,
  resolveStepFragment,
} from '../../infra/config/loaders/stepFragmentLookupDirectories.js';
import {
  buildCandidateDirsWithPackage,
  buildFacetsRoots,
  getPackageFromWorkflowDir,
  type FacetResolutionContext,
} from '../../infra/config/loaders/workflowPackageScope.js';
import {
  assertPathSegmentsAreSafe,
  isPathInside,
} from '../../shared/utils/pathBoundary.js';
import { readRegularFileNoFollow } from '../../shared/utils/private-file.js';
import { buildConfiguredCompanionLookupDirs } from '../../infra/config/loaders/companionLookupDirectories.js';
import {
  parseCompanionDefinitionDocument,
  resolveCompanionDefinitionResource,
} from '../../infra/config/loaders/companionDefinitionLoader.js';
import { assertCapabilitySetOptions } from '../../infra/config/loaders/capabilitySetResolver.js';
import {
  parseProviderOptionsDocument,
  resolveProviderOptionsExtendsResource,
  resolveWorkflowProviderOptionsWithHost,
  type WorkflowProviderOptionsResolutionHost,
} from '../../infra/config/loaders/workflowProviderOptionsResolver.js';

export type WorkflowMakerWorkflowSource = 'project' | 'user' | 'builtin' | 'repertoire';

export type WorkflowMakerBase =
  | { readonly kind: 'new'; readonly name: string }
  | {
    readonly kind: 'existing';
    readonly workflow: {
      readonly name: string;
      readonly path: string;
      readonly source: WorkflowMakerWorkflowSource;
    };
  };

export interface WorkflowMakerArtifactFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface WorkflowMakerArtifactPlan {
  readonly artifactRoot: string;
  readonly rootWorkflowPath: string;
  readonly workflowName: string;
  readonly files: readonly WorkflowMakerArtifactFile[];
}

export interface PlanWorkflowMakerArtifactOptions {
  readonly projectDir: string;
  readonly base: WorkflowMakerBase;
  readonly now?: () => Date;
}

type RawRecord = Record<string, unknown>;
type ArtifactDirectory =
  | 'workflows'
  | 'steps'
  | 'facet-pools'
  | 'schemas'
  | 'assets'
  | 'companions'
  | 'provider-options';

interface SafeResource {
  readonly path: string;
  readonly canonicalPath: string;
  readonly content: string;
  readonly root: string;
}

const SAFE_WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SCHEMA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const YAML_EXTENSIONS = ['.yaml', '.yml'] as const;
const FACET_SECTIONS = {
  personas: 'personas',
  policies: 'policies',
  knowledge: 'knowledge',
  instructions: 'instructions',
  report_formats: 'output-contracts',
} as const satisfies Record<string, FacetType>;
const FACET_SECTION_BY_TYPE = {
  personas: 'personas',
  policies: 'policies',
  knowledge: 'knowledge',
  instructions: 'instructions',
  'output-contracts': 'report_formats',
} as const satisfies Record<FacetType, keyof typeof FACET_SECTIONS>;
const STEP_FACET_FIELDS = {
  persona: 'personas',
  policy: 'policies',
  knowledge: 'knowledge',
  instruction: 'instructions',
} as const satisfies Record<string, FacetType>;
const INCLUDE_PATTERN = /\{\{include:([a-z-]+)\/([A-Za-z0-9._/-]+)\}\}/g;
const EXTENDS_LINE_PATTERN = /^[ \t]*\{extends:\s*([^}]+?)\s*\}[ \t]*$/gm;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExplicitFacetPath(ref: string): boolean {
  return ref.endsWith('.md') || ref.startsWith('./') || ref.startsWith('../') || isAbsolute(ref);
}

function parseRecord(content: string, sourcePath: string): RawRecord {
  const parsed: unknown = parseYaml(content);
  if (!isRecord(parsed)) {
    throw new Error(`Workflow Maker dependency must be a YAML mapping: ${sourcePath}`);
  }
  return parsed;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, length: number) => String(value).padStart(length, '0');
  return [
    pad(date.getFullYear(), 4),
    pad(date.getMonth() + 1, 2),
    pad(date.getDate(), 2),
    '-',
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function selectArtifactRoot(projectDir: string, now: () => Date): string {
  const baseTime = now().getTime();
  for (let offset = 0; offset < 10_000; offset += 1) {
    const candidate = join(projectDir, '.takt', 'make', formatTimestamp(new Date(baseTime + offset)));
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Workflow Maker could not reserve an unused artifact timestamp');
}

function assertSafeWorkflowName(name: string): void {
  if (!SAFE_WORKFLOW_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid Workflow Maker workflow name: ${name}`);
  }
}

function relativeReference(fromDir: string, toPath: string): string {
  const value = relative(fromDir, toPath).split(sep).join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

function requireStaticReference(ref: string, label: string): void {
  if (ref.startsWith('$')) {
    throw new Error(`Workflow Maker cannot resolve dynamic ${label} reference "${ref}"`);
  }
}

function dynamicReferenceError(value: unknown, label: string): Error {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return new Error(`Workflow Maker cannot resolve dynamic ${label} reference "${rendered}"`);
}

function normalizeFacetType(value: unknown): FacetType | undefined {
  switch (value) {
    case 'persona': return 'personas';
    case 'policy': return 'policies';
    case 'knowledge': return 'knowledge';
    case 'instruction': return 'instructions';
    case 'report_format': return 'output-contracts';
    case 'personas':
    case 'policies':
    case 'instructions':
    case 'output-contracts':
      return value;
    default:
      return undefined;
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((entry) => resolve(entry)))];
}

function facetRootFromCandidateDir(candidateDir: string): string {
  const candidateName = basename(candidateDir);
  return Object.values(FACET_SECTIONS).includes(candidateName as FacetType)
    ? dirname(candidateDir)
    : join(candidateDir, 'facets');
}

function resourceError(label: string, targetPath: string, detail: string): Error {
  return new Error(`Workflow Maker refused ${label} resource "${targetPath}": ${detail}`);
}

function inspectRegularFile(root: string, targetPath: string, label: string): Stats | null {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget) || resolvedRoot === resolvedTarget) {
    throw resourceError(label, targetPath, 'path is outside its allowed root');
  }
  let rootStats: Stats;
  try {
    rootStats = lstatSync(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw resourceError(label, resolvedRoot, 'allowed root is not a canonical directory');
  }
  const targetStats = assertPathSegmentsAreSafe(
    resolvedRoot,
    resolvedTarget,
    (violation, segmentPath) => resourceError(label, segmentPath, `unsafe path segment (${violation})`),
    { rejectSamePath: true },
  );
  if (targetStats === null) return null;
  if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
    throw resourceError(label, resolvedTarget, 'target is not a regular file');
  }
  const canonicalRoot = realpathSync(resolvedRoot);
  const canonicalTarget = realpathSync(resolvedTarget);
  if (!isPathInside(canonicalRoot, canonicalTarget)) {
    throw resourceError(label, resolvedTarget, 'canonical path is outside its allowed root');
  }
  return targetStats;
}

function readResourceAtPath(
  targetPath: string,
  allowedRoots: readonly string[],
  label: string,
): SafeResource | undefined {
  const resolvedTarget = resolve(targetPath);
  const matchingRoots = uniquePaths(allowedRoots).filter((root) => (
    root !== resolvedTarget && isPathInside(root, resolvedTarget)
  ));
  if (matchingRoots.length === 0) {
    throw resourceError(label, targetPath, 'path is outside every allowed root');
  }
  for (const root of matchingRoots) {
    const stats = inspectRegularFile(root, resolvedTarget, label);
    if (stats === null) continue;
    return {
      path: resolvedTarget,
      canonicalPath: realpathSync(resolvedTarget),
      content: readRegularFileNoFollow(resolvedTarget, stats).toString('utf-8'),
      root,
    };
  }
  return undefined;
}

function readFirstResource(
  candidates: readonly { readonly path: string; readonly root: string }[],
  label: string,
): SafeResource | undefined {
  for (const candidate of candidates) {
    const resource = readResourceAtPath(candidate.path, [candidate.root], label);
    if (resource !== undefined) return resource;
  }
  return undefined;
}

function yamlCandidates(pathValue: string): string[] {
  return extname(pathValue) === ''
    ? YAML_EXTENSIONS.map((extension) => `${pathValue}${extension}`)
    : [pathValue];
}

class DependencyPlanner {
  readonly #artifactRoot: string;
  readonly #projectDir: string;
  readonly #context: FacetResolutionContext;
  readonly #files = new Map<string, string>();
  readonly #destinationsBySource = new Map<string, string>();
  readonly #sourcesByDestination = new Map<string, string>();
  readonly #assetRootsBySource = new Map<string, string>();
  readonly #workflowsInProgress = new Set<string>();
  readonly #facetsInProgress = new Set<string>();
  readonly #providerOptionsInProgress = new Set<string>();
  readonly #safeProviderOptionsContent = new Map<string, string>();
  readonly #schemaRefs = new Map<string, string>();

  constructor(projectDir: string, artifactRoot: string, workflowPath?: string) {
    this.#projectDir = projectDir;
    this.#artifactRoot = artifactRoot;
    this.#context = {
      lang: resolveWorkflowConfigValue(projectDir, 'language'),
      projectDir,
      workflowDir: workflowPath === undefined ? undefined : dirname(workflowPath),
      repertoireDir: getRepertoireDir(),
    };
  }

  get files(): readonly WorkflowMakerArtifactFile[] {
    return [...this.#files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => ({ relativePath, content }));
  }

  planRootWorkflow(sourcePath: string, source: WorkflowMakerWorkflowSource): string {
    const resource = this.#readRootWorkflow(sourcePath, source);
    const destination = join('workflows', basename(resource.path));
    this.#rememberDestination(resource, destination);
    this.#planWorkflow(resource, destination);
    return join(this.#artifactRoot, destination);
  }

  #readRootWorkflow(sourcePath: string, source: WorkflowMakerWorkflowSource): SafeResource {
    const roots = source === 'project'
      ? [getProjectWorkflowsDir(this.#projectDir)]
      : source === 'user'
        ? [getGlobalWorkflowsDir()]
        : source === 'builtin'
          ? [getBuiltinWorkflowsDir(this.#context.lang)]
          : this.#repertoireWorkflowRootsForPath(sourcePath);
    const resource = readResourceAtPath(sourcePath, roots, 'base workflow');
    if (resource === undefined) {
      throw new Error(`Workflow Maker base workflow was not found: ${sourcePath}`);
    }
    return resource;
  }

  #repertoireWorkflowRootsForPath(sourcePath: string): string[] {
    const packageInfo = getPackageFromWorkflowDir(dirname(sourcePath), getRepertoireDir());
    if (packageInfo === undefined) {
      throw resourceError('base workflow', sourcePath, 'path is not in the selected repertoire package');
    }
    return [join(getRepertoireDir(), `@${packageInfo.owner}`, packageInfo.repo, 'workflows')];
  }

  #rememberDestination(resource: SafeResource, destination: string): void {
    this.#destinationsBySource.set(resource.canonicalPath, destination);
    this.#sourcesByDestination.set(destination, resource.canonicalPath);
  }

  #rememberSourceProvenance(resource: SafeResource): void {
    this.#assetRootsBySource.set(resource.canonicalPath, dirname(resource.root));
  }

  #allocateDestination(resource: SafeResource, directory: ArtifactDirectory, preferredName: string): string {
    const existing = this.#destinationsBySource.get(resource.canonicalPath);
    if (existing !== undefined) return existing;
    const extension = extname(preferredName);
    const stem = basename(preferredName, extension);
    let filename = preferredName;
    let destination = join(directory, filename);
    if (this.#sourcesByDestination.has(destination)) {
      const suffix = createHash('sha256').update(resource.canonicalPath).digest('hex').slice(0, 8);
      filename = `${stem}-${suffix}${extension}`;
      destination = join(directory, filename);
    }
    this.#rememberDestination(resource, destination);
    return destination;
  }

  #planWorkflow(resource: SafeResource, destination: string, allowParameterReferences = false): void {
    if (this.#workflowsInProgress.has(resource.canonicalPath)) {
      throw new Error(`Workflow Maker detected a workflow dependency cycle at ${resource.path}`);
    }
    if (this.#files.has(destination)) return;
    this.#rememberSourceProvenance(resource);
    this.#workflowsInProgress.add(resource.canonicalPath);
    try {
      const raw = parseRecord(resource.content, resource.path);
      this.#rewriteFacetSections(raw, resource.path, destination);
      this.#rewriteFacetPools(raw, resource.path, destination);
      this.#rewriteWorkflowRules(raw);
      this.#rewriteSubworkflowDefaults(raw, resource.path, destination);
      this.#rewriteCapabilities(raw, resource.path);
      this.#rewriteLoopMonitors(raw, resource.path, destination);
      if (Array.isArray(raw.steps)) {
        raw.steps = raw.steps.map((step) => this.#rewriteStepTree(
          step,
          resource.path,
          destination,
          raw,
          allowParameterReferences,
          resource.path,
        ));
      }
      this.#files.set(destination, stringifyYaml(raw));
    } finally {
      this.#workflowsInProgress.delete(resource.canonicalPath);
    }
  }

  #rewriteWorkflowRules(raw: RawRecord): void {
    const allSteps = raw.all_steps;
    if (!isRecord(allSteps) || !Array.isArray(allSteps.rules)) return;
    for (const entry of allSteps.rules) {
      const ref = typeof entry === 'string'
        ? entry
        : isRecord(entry) && typeof entry.ref === 'string' ? entry.ref : undefined;
      if (ref === undefined) continue;
      requireStaticReference(ref, 'workflow-wide rule');
      if (!SAFE_WORKFLOW_NAME.test(ref)) {
        throw new Error(`Invalid workflow-wide rule reference: ${ref}`);
      }
      const roots = [
        join(getProjectWorkflowsDir(this.#projectDir), 'rules'),
        join(getGlobalWorkflowsDir(), 'rules'),
        join(getBuiltinWorkflowsDir(this.#context.lang), 'rules'),
      ];
      const resource = readFirstResource(
        roots.map((root) => ({ root, path: join(root, `${ref}.md`) })),
        'workflow-wide rule',
      );
      if (resource === undefined) {
        throw new Error(`Workflow Maker could not resolve workflow-wide rule "${ref}"`);
      }
      const destination = join('workflows', 'rules', `${ref}.md`);
      const currentSource = this.#sourcesByDestination.get(destination);
      if (currentSource !== undefined && currentSource !== resource.canonicalPath) {
        throw new Error(`Workflow Maker cannot preserve colliding workflow-wide rule "${ref}"`);
      }
      this.#rememberDestination(resource, destination);
      this.#files.set(destination, resource.content);
    }
  }

  #rewriteSubworkflowDefaults(raw: RawRecord, sourcePath: string, destination: string): void {
    const subworkflow = raw.subworkflow;
    if (!isRecord(subworkflow) || !isRecord(subworkflow.params)) return;
    for (const definition of Object.values(subworkflow.params)) {
      if (!isRecord(definition) || definition.default === undefined) continue;
      if (definition.type === 'workflow_ref' && typeof definition.default === 'string') {
        definition.default = this.#copyWorkflowReference(definition.default, sourcePath, destination);
      } else if (definition.type === 'facet_pool_ref' && typeof definition.default === 'string') {
        if (!(isRecord(raw.facet_pools) && Object.hasOwn(raw.facet_pools, definition.default))) {
          definition.default = this.#copyFacetPoolReference(definition.default, sourcePath, destination);
        }
      } else if (definition.type === 'facet_ref') {
        definition.default = this.#rewriteTypedFacetReference(
          definition.default,
          definition.facet_kind,
          sourcePath,
          destination,
          raw,
        );
      } else if (definition.type === 'facet_ref[]' && Array.isArray(definition.default)) {
        definition.default = this.#rewriteTypedFacetReference(
          definition.default,
          definition.facet_kind,
          sourcePath,
          destination,
          raw,
        );
      } else if (definition.type === 'companion_ref[]') {
        definition.default = this.#rewriteCompanionSelection(definition.default, sourcePath);
      }
    }
  }

  #rewriteLoopMonitors(raw: RawRecord, sourcePath: string, destination: string): void {
    if (!Array.isArray(raw.loop_monitors)) return;
    for (const monitor of raw.loop_monitors) {
      if (!isRecord(monitor) || !isRecord(monitor.judge)) continue;
      for (const [field, facetType, section] of [
        ['persona', 'personas', raw.personas],
        ['instruction', 'instructions', raw.instructions],
      ] as const) {
        if (field in monitor.judge) {
          monitor.judge[field] = this.#rewriteFacetField(
            monitor.judge[field],
            facetType,
            sourcePath,
            destination,
            section,
          );
        }
      }
    }
  }

  #rewriteFacetPools(raw: RawRecord, sourcePath: string, destination: string): void {
    if (!isRecord(raw.facet_pools)) return;
    for (const pool of Object.values(raw.facet_pools)) {
      if (!isRecord(pool)) continue;
      if ('uses' in pool) {
        if (typeof pool.uses !== 'string') throw dynamicReferenceError(pool.uses, 'facet pool');
        pool.uses = this.#copyFacetPoolReference(pool.uses, sourcePath, destination);
      } else {
        this.#rewriteFacetSections(pool, sourcePath, destination);
        this.#rewriteFacetPoolCandidates(pool, sourcePath, destination);
      }
    }
  }

  #rewriteFacetPoolCandidates(
    pool: RawRecord,
    sourcePath: string,
    destination: string,
    trustedRoot?: string,
    dependencyRootsByType?: Readonly<Record<FacetType, readonly string[]>>,
  ): void {
    if (!Array.isArray(pool.candidates)) return;
    for (const candidate of pool.candidates) {
      if (!isRecord(candidate)) continue;
      for (const [field, facetType, section] of [
        ['policy', 'policies', pool.policies],
        ['knowledge', 'knowledge', pool.knowledge],
      ] as const) {
        if (!(field in candidate)) continue;
        const rewrite = (value: unknown): unknown => {
          if (typeof value === 'string' && isRecord(section) && Object.hasOwn(section, value)) return value;
          return this.#rewriteFacetReferenceValue(
            value,
            facetType,
            sourcePath,
            destination,
            trustedRoot,
            true,
            false,
            dependencyRootsByType?.[facetType],
          );
        };
        candidate[field] = Array.isArray(candidate[field])
          ? candidate[field].map(rewrite)
          : rewrite(candidate[field]);
      }
    }
  }

  #copyFacetPoolReference(ref: string, ownerSource: string, _ownerDestination: string): string {
    requireStaticReference(ref, 'facet pool');
    const context = { ...this.#context, workflowDir: dirname(ownerSource) };
    const resolvedPool = resolveFacetPoolResource(ref, context);
    if (resolvedPool === undefined) {
      throw new Error(`Workflow Maker could not resolve facet pool "${ref}"`);
    }
    const resource = readResourceAtPath(
      resolvedPool.path,
      getFacetPoolLookupDirs(ref, context),
      'facet pool',
    );
    if (resource === undefined) {
      throw new Error(`Workflow Maker could not resolve facet pool "${ref}"`);
    }
    const destination = this.#allocateDestination(resource, 'facet-pools', basename(resource.path));
    if (!this.#files.has(destination)) {
      const raw = parseRecord(resource.content, resource.path);
      const trustedRoot = dirname(resolvedPool.candidateDir);
      const dependencyRoots = (facetType: FacetType): readonly string[] => uniquePaths([
        join(resolvedPool.candidateDir, 'facets', facetType),
        ...resolvedPool.candidateDirs.map((candidateDir) => (
          join(dirname(candidateDir), 'facets', facetType)
        )),
      ]);
      const dependencyRootsByType: Record<FacetType, readonly string[]> = {
        personas: dependencyRoots('personas'),
        policies: dependencyRoots('policies'),
        knowledge: dependencyRoots('knowledge'),
        instructions: dependencyRoots('instructions'),
        'output-contracts': dependencyRoots('output-contracts'),
      };
      this.#rewriteFacetSections(
        raw,
        resource.path,
        destination,
        trustedRoot,
        dependencyRootsByType,
      );
      this.#rewriteFacetPoolCandidates(
        raw,
        resource.path,
        destination,
        trustedRoot,
        dependencyRootsByType,
      );
      this.#files.set(destination, stringifyYaml(raw));
    }
    return basename(destination, extname(destination));
  }

  #rewriteStepTree(
    value: unknown,
    ownerSource: string,
    ownerDestination: string,
    workflow: RawRecord,
    allowParameterReferences = false,
    workflowSource = ownerSource,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.#rewriteStepTree(
        entry,
        ownerSource,
        ownerDestination,
        workflow,
        allowParameterReferences,
        workflowSource,
      ));
    }
    if (!isRecord(value)) return value;

    if ('uses' in value) {
      if (typeof value.uses !== 'string') {
        if (!(allowParameterReferences && isRecord(value.uses) && typeof value.uses.$param === 'string')) {
          throw dynamicReferenceError(value.uses, 'step fragment');
        }
      } else {
        const ref = value.uses;
        requireStaticReference(ref, 'step fragment');
        const context = { ...this.#context, workflowDir: dirname(ownerSource) };
        const resolvedStep = resolveStepFragment(ref, { context });
        if (resolvedStep === undefined) {
          throw new Error(`Workflow Maker could not resolve step fragment "${ref}"`);
        }
        const resource = readResourceAtPath(
          resolvedStep.path,
          getStepFragmentLookupDirs(ref, { context }),
          'step fragment',
        );
        if (resource === undefined) {
          throw new Error(`Workflow Maker could not resolve step fragment "${ref}"`);
        }
        const destination = this.#allocateDestination(resource, 'steps', basename(resource.path));
        value.uses = basename(destination, extname(destination));
        this.#rememberSourceProvenance(resource);
        const fragment = parseRecord(resource.content, resource.path);
        this.#rewriteTypedArguments(
          value.with,
          fragment.params,
          ownerSource,
          ownerDestination,
          allowParameterReferences,
          workflowSource,
          workflow,
        );
        if (!this.#files.has(destination)) {
          const rewritten = this.#rewriteStepTree(
            fragment,
            resource.path,
            destination,
            workflow,
            true,
            workflowSource,
          );
          this.#files.set(destination, stringifyYaml(rewritten));
        }
      }
    }

    if ('call' in value && typeof value.call !== 'string') {
      if (!(allowParameterReferences && isRecord(value.call) && typeof value.call.$param === 'string')) {
        throw dynamicReferenceError(value.call, 'workflow');
      }
    }
    if (typeof value.call === 'string') {
      const copied = this.#copyWorkflowReferenceWithRaw(value.call, ownerSource, ownerDestination);
      value.call = copied.reference;
      this.#rewriteTypedArguments(
        value.args,
        copied.raw.subworkflow && isRecord(copied.raw.subworkflow)
          ? copied.raw.subworkflow.params
          : undefined,
        ownerSource,
        ownerDestination,
        allowParameterReferences,
        copied.sourcePath,
        copied.raw,
      );
    }

    if (isRecord(value.dynamic_facets) && 'pool' in value.dynamic_facets) {
      const pool = value.dynamic_facets.pool;
      if (typeof pool !== 'string') {
        if (!(allowParameterReferences && isRecord(pool) && typeof pool.$param === 'string')) {
          throw dynamicReferenceError(pool, 'facet pool');
        }
      } else {
        if (!(isRecord(workflow.facet_pools) && Object.hasOwn(workflow.facet_pools, pool))) {
          value.dynamic_facets.pool = this.#copyFacetPoolReference(pool, ownerSource, ownerDestination);
        }
      }
      if (isRecord(value.dynamic_facets.selector)) {
        for (const [field, facetType, section] of [
          ['persona', 'personas', workflow.personas],
          ['instruction', 'instructions', workflow.instructions],
        ] as const) {
          if (field in value.dynamic_facets.selector) {
            value.dynamic_facets.selector[field] = this.#rewriteFacetField(
              value.dynamic_facets.selector[field],
              facetType,
              ownerSource,
              ownerDestination,
              section,
            );
          }
        }
      }
    }

    this.#rewriteDirectStepFacets(value, ownerSource, ownerDestination, workflow);
    this.#rewriteAdditionalStepFacets(value, ownerSource, ownerDestination, workflow);
    this.#rewriteCapabilities(value, ownerSource);
    if ('companion' in value) {
      if (allowParameterReferences && isRecord(value.companion) && typeof value.companion.$param === 'string') {
        // The matching typed default or workflow_call argument is rewritten at its declaration site.
      } else {
        value.companion = this.#rewriteCompanionSelection(value.companion, workflowSource);
      }
    }
    this.#rewriteArpeggioAssets(value, ownerSource, ownerDestination);
    this.#rewriteStructuredOutput(value, workflow);
    for (const [key, entry] of Object.entries(value)) {
      if ([
        'uses',
        'call',
        'with',
        'args',
        'completion_retry',
        'team_leader',
        'structured_output',
        'output_contracts',
        'dynamic_facets',
        'arpeggio',
      ].includes(key)) continue;
      value[key] = this.#rewriteStepTree(
        entry,
        ownerSource,
        ownerDestination,
        workflow,
        allowParameterReferences,
        workflowSource,
      );
    }
    return value;
  }

  #rewriteAdditionalStepFacets(
    step: RawRecord,
    sourcePath: string,
    destination: string,
    workflow: RawRecord,
  ): void {
    if (isRecord(step.completion_retry) && 'retry_instruction' in step.completion_retry) {
      step.completion_retry.retry_instruction = this.#rewriteFacetField(
        step.completion_retry.retry_instruction,
        'instructions',
        sourcePath,
        destination,
        workflow.instructions,
      );
    }
    if (isRecord(step.team_leader)) {
      for (const field of ['persona', 'part_persona'] as const) {
        if (field in step.team_leader) {
          step.team_leader[field] = this.#rewriteFacetField(
            step.team_leader[field],
            'personas',
            sourcePath,
            destination,
            workflow.personas,
          );
        }
      }
    }
    if (isRecord(step.output_contracts) && Array.isArray(step.output_contracts.report)) {
      const reportFormats = workflow.report_formats;
      for (const report of step.output_contracts.report) {
        if (!isRecord(report)) continue;
        for (const field of ['format', 'order'] as const) {
          const reference = report[field];
          if (typeof reference !== 'string' || reference.length === 0) continue;
          if (isRecord(reportFormats) && Object.hasOwn(reportFormats, reference)) continue;
          report[field] = this.#rewriteFacetReferenceValue(
            reference,
            'output-contracts',
            sourcePath,
            destination,
            undefined,
            true,
          );
        }
      }
    }
  }

  #rewriteArpeggioAssets(step: RawRecord, sourcePath: string, destination: string): void {
    if (!isRecord(step.arpeggio)) return;
    for (const [field, label] of [
      ['source_path', 'Arpeggio source'],
      ['template', 'Arpeggio template'],
    ] as const) {
      step.arpeggio[field] = this.#copyAssetReference(
        step.arpeggio[field],
        label,
        sourcePath,
        destination,
      );
    }
    if (isRecord(step.arpeggio.merge) && 'file' in step.arpeggio.merge) {
      step.arpeggio.merge.file = this.#copyAssetReference(
        step.arpeggio.merge.file,
        'Arpeggio merge file',
        sourcePath,
        destination,
      );
    }
  }

  #copyAssetReference(
    reference: unknown,
    label: string,
    ownerSource: string,
    ownerDestination: string,
  ): string {
    if (typeof reference !== 'string') {
      throw dynamicReferenceError(reference, label);
    }
    requireStaticReference(reference, label);
    const canonicalOwner = realpathSync(ownerSource);
    const allowedRoot = this.#assetRootsBySource.get(canonicalOwner);
    if (allowedRoot === undefined) {
      throw new Error(`Workflow Maker has no source provenance for ${label} in ${ownerSource}`);
    }
    const sourcePath = isAbsolute(reference)
      ? reference
      : resolve(dirname(ownerSource), reference);
    const resource = readResourceAtPath(sourcePath, [allowedRoot], label);
    if (resource === undefined) {
      throw new Error(`Workflow Maker could not resolve ${label} "${reference}"`);
    }
    const destination = this.#allocateDestination(resource, 'assets', basename(resource.path));
    if (!this.#files.has(destination)) {
      this.#files.set(destination, resource.content);
    }
    return relativeReference(
      dirname(join(this.#artifactRoot, ownerDestination)),
      join(this.#artifactRoot, destination),
    );
  }

  #rewriteStructuredOutput(step: RawRecord, workflow: RawRecord): void {
    if (!isRecord(step.structured_output) || typeof step.structured_output.schema_ref !== 'string') return;
    const schemaRef = step.structured_output.schema_ref;
    requireStaticReference(schemaRef, 'structured output schema');
    const configured = isRecord(workflow.schemas) && typeof workflow.schemas[schemaRef] === 'string'
      ? workflow.schemas[schemaRef]
      : schemaRef;
    if (!SAFE_SCHEMA_NAME.test(configured)) {
      throw new Error(`Invalid structured output schema reference: ${configured}`);
    }
    let localName = this.#schemaRefs.get(configured);
    if (localName === undefined) {
      const roots = [
        getProjectSchemasDir(this.#projectDir),
        getGlobalSchemasDir(),
        join(getResourcesDir(), 'schemas'),
      ];
      const resource = readFirstResource(
        roots.map((root) => ({ root, path: join(root, `${configured}.json`) })),
        'structured output schema',
      );
      if (resource === undefined) {
        throw new Error(`Workflow Maker could not resolve structured output schema "${schemaRef}"`);
      }
      const schemaDestination = this.#allocateDestination(resource, 'schemas', basename(resource.path));
      this.#files.set(schemaDestination, resource.content);
      localName = basename(schemaDestination, extname(schemaDestination));
      this.#schemaRefs.set(configured, localName);
    }
    const schemas = isRecord(workflow.schemas) ? workflow.schemas : {};
    schemas[schemaRef] = localName;
    workflow.schemas = schemas;
  }

  #rewriteTypedArguments(
    values: unknown,
    definitions: unknown,
    ownerSource: string,
    ownerDestination: string,
    allowParameterReferences: boolean,
    companionSource: string,
    localWorkflow: RawRecord,
  ): void {
    if (!isRecord(values) || !isRecord(definitions)) return;
    for (const [name, definition] of Object.entries(definitions)) {
      if (!isRecord(definition) || !Object.hasOwn(values, name)) continue;
      const current = values[name];
      if (definition.type === 'workflow_ref' && typeof current === 'string') {
        values[name] = this.#copyWorkflowReference(current, ownerSource, ownerDestination);
      } else if (definition.type === 'facet_pool_ref' && typeof current === 'string') {
        if (!(isRecord(localWorkflow.facet_pools) && Object.hasOwn(localWorkflow.facet_pools, current))) {
          values[name] = this.#copyFacetPoolReference(current, ownerSource, ownerDestination);
        }
      } else if (definition.type === 'facet_ref') {
        values[name] = this.#rewriteTypedFacetReference(
          current,
          definition.facet_kind,
          ownerSource,
          ownerDestination,
          localWorkflow,
        );
      } else if (definition.type === 'facet_ref[]' && Array.isArray(current)) {
        values[name] = this.#rewriteTypedFacetReference(
          current,
          definition.facet_kind,
          ownerSource,
          ownerDestination,
          localWorkflow,
        );
      } else if (definition.type === 'companion_ref[]') {
        if (!(allowParameterReferences && isRecord(current) && typeof current.$param === 'string')) {
          values[name] = this.#rewriteCompanionSelection(current, companionSource);
        }
      }
    }
  }

  #rewriteCompanionSelection(value: unknown, ownerSource: string): unknown {
    const rewriteName = (entry: unknown): string => {
      if (typeof entry !== 'string') {
        throw dynamicReferenceError(entry, 'companion');
      }
      return this.#copyCompanionReference(entry, ownerSource);
    };
    if (Array.isArray(value)) {
      return value.map(rewriteName);
    }
    if (!isRecord(value)) {
      throw dynamicReferenceError(value, 'companion');
    }
    if (typeof value.$param === 'string') {
      throw dynamicReferenceError(value, 'companion');
    }
    const fixed = value.fixed === undefined ? undefined : value.fixed;
    const pool = value.pool === undefined ? undefined : value.pool;
    if (fixed !== undefined && !Array.isArray(fixed)) {
      throw dynamicReferenceError(fixed, 'companion fixed');
    }
    if (pool !== undefined && !Array.isArray(pool)) {
      throw dynamicReferenceError(pool, 'companion pool');
    }
    if (value.moderator !== undefined && typeof value.moderator !== 'string') {
      throw dynamicReferenceError(value.moderator, 'companion moderator');
    }
    return {
      ...(fixed === undefined ? {} : { fixed: fixed.map(rewriteName) }),
      ...(pool === undefined ? {} : { pool: pool.map(rewriteName) }),
      ...(value.moderator === undefined ? {} : { moderator: rewriteName(value.moderator) }),
    };
  }

  #copyCompanionReference(ref: string, ownerSource: string): string {
    requireStaticReference(ref, 'companion');
    const candidateDirs = buildConfiguredCompanionLookupDirs(this.#projectDir, this.#context.lang);
    const resolved = resolveCompanionDefinitionResource(ref, candidateDirs);
    if (resolved === undefined) {
      throw new Error(`Workflow Maker could not resolve companion "${ref}"`);
    }
    const resource = readResourceAtPath(resolved.path, [resolved.candidateDir], 'companion');
    if (resource === undefined) {
      throw new Error(`Workflow Maker could not resolve companion "${ref}"`);
    }
    const destination = this.#allocateDestination(resource, 'companions', basename(resource.path));
    const localName = basename(destination, extname(destination));
    if (this.#files.has(destination)) return localName;

    const document = parseCompanionDefinitionDocument(resource.content, ref);
    const raw: RawRecord = { ...document, name: localName };
    for (const [field, facetType] of [
      ['persona', 'personas'],
      ['policy', 'policies'],
      ['knowledge', 'knowledge'],
      ['instruction', 'instructions'],
    ] as const) {
      if (!(field in raw)) continue;
      const rewrite = (entry: unknown): unknown => this.#rewriteFacetReferenceValue(
        entry,
        facetType,
        ownerSource,
        destination,
        undefined,
        true,
      );
      raw[field] = Array.isArray(raw[field]) ? raw[field].map(rewrite) : rewrite(raw[field]);
    }
    this.#files.set(destination, stringifyYaml(raw));
    return localName;
  }

  #rewriteCapabilities(raw: RawRecord, ownerSource: string): void {
    if (!('capabilities' in raw)) return;
    const references = raw.capabilities;
    if (typeof references === 'string') {
      raw.capabilities = this.#copyCapabilityReference(references, ownerSource);
      return;
    }
    if (!Array.isArray(references)) {
      throw dynamicReferenceError(references, 'capabilities');
    }
    raw.capabilities = references.map((reference) => {
      if (typeof reference !== 'string') {
        throw dynamicReferenceError(reference, 'capabilities');
      }
      return this.#copyCapabilityReference(reference, ownerSource);
    });
  }

  #copyCapabilityReference(ref: string, ownerSource: string): string {
    requireStaticReference(ref, 'capabilities');
    const context = { ...this.#context, workflowDir: dirname(ownerSource) };
    const host: WorkflowProviderOptionsResolutionHost = {
      rootDir: dirname(ownerSource),
      context,
    };
    const localName = this.#copyProviderOptionsReference(ref, dirname(ownerSource), host);
    const options = resolveWorkflowProviderOptionsWithHost(
      { extends: ref },
      dirname(ownerSource),
      {
        ...host,
        fileAccess: {
          exists: (path) => existsSync(path),
          realpath: (path) => realpathSync(path),
          isSymlink: (path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
          readText: (path) => {
            const content = this.#safeProviderOptionsContent.get(realpathSync(path));
            if (content === undefined) {
              throw new Error(`Workflow Maker refused unplanned provider-options resource "${path}"`);
            }
            return content;
          },
        },
      },
    );
    if (options === undefined) {
      throw new Error(`Workflow Maker capabilities "${ref}" resolved to no capability options`);
    }
    assertCapabilitySetOptions(ref, options);
    return localName;
  }

  #copyProviderOptionsReference(
    ref: string,
    currentDir: string,
    host: WorkflowProviderOptionsResolutionHost,
  ): string {
    const resolved = resolveProviderOptionsExtendsResource(ref, currentDir, host);
    const resource = readResourceAtPath(resolved.path, [resolved.allowedRoot], 'provider-options');
    if (resource === undefined) {
      throw new Error(`Workflow Maker could not resolve provider-options "${ref}"`);
    }
    if (this.#providerOptionsInProgress.has(resource.canonicalPath)) {
      throw new Error(`Workflow Maker detected a provider-options dependency cycle at ${resource.path}`);
    }
    const destination = this.#allocateDestination(resource, 'provider-options', basename(resource.path));
    const localName = basename(destination, extname(destination));
    if (this.#files.has(destination)) return localName;

    this.#providerOptionsInProgress.add(resource.canonicalPath);
    this.#safeProviderOptionsContent.set(resource.canonicalPath, resource.content);
    try {
      const raw = parseProviderOptionsDocument(resource.content, ref);
      if (raw.extends !== undefined) {
        raw.extends = this.#copyProviderOptionsReference(
          raw.extends,
          dirname(resource.path),
          {
            rootDir: resolved.nextRootDir,
            context: host.context,
            candidateDirs: resolved.candidateDirs ?? host.candidateDirs,
            scopedCandidateDirs: host.scopedCandidateDirs,
          },
        );
      }
      this.#files.set(destination, stringifyYaml(raw));
    } finally {
      this.#providerOptionsInProgress.delete(resource.canonicalPath);
    }
    return localName;
  }

  #copyWorkflowReference(ref: string, ownerSource: string, ownerDestination: string): string {
    return this.#copyWorkflowReferenceWithRaw(ref, ownerSource, ownerDestination).reference;
  }

  #copyWorkflowReferenceWithRaw(
    ref: string,
    ownerSource: string,
    ownerDestination: string,
  ): { readonly reference: string; readonly raw: RawRecord; readonly sourcePath: string } {
    requireStaticReference(ref, 'workflow');
    const resource = this.#resolveWorkflowReference(ref, ownerSource);
    const raw = parseRecord(resource.content, resource.path);
    const destination = this.#allocateDestination(resource, 'workflows', basename(resource.path));
    this.#planWorkflow(resource, destination, true);
    return {
      reference: relativeReference(
        dirname(join(this.#artifactRoot, ownerDestination)),
        join(this.#artifactRoot, destination),
      ),
      raw,
      sourcePath: resource.path,
    };
  }

  #resolveWorkflowReference(ref: string, ownerSource: string): SafeResource {
    const packageInfo = getPackageFromWorkflowDir(dirname(ownerSource), getRepertoireDir());
    const normalRoots = [
      ...(packageInfo === undefined ? [] : [
        join(getRepertoireDir(), `@${packageInfo.owner}`, packageInfo.repo, 'workflows'),
      ]),
      getProjectWorkflowsDir(this.#projectDir),
      getGlobalWorkflowsDir(),
      getBuiltinWorkflowsDir(this.#context.lang),
    ];
    if (isAbsolute(ref) || ref.startsWith('./') || ref.startsWith('../')) {
      const base = isAbsolute(ref) ? ref : resolve(dirname(ownerSource), ref);
      for (const candidate of yamlCandidates(base)) {
        const resource = readResourceAtPath(candidate, normalRoots, 'workflow');
        if (resource !== undefined) return resource;
      }
    } else if (ref.startsWith('@')) {
      const match = /^@([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
      if (match === null) throw new Error(`Invalid scoped workflow reference: ${ref}`);
      const root = join(getRepertoireDir(), `@${match[1]!}`, match[2]!, 'workflows');
      for (const candidate of yamlCandidates(join(root, match[3]!))) {
        const resource = readResourceAtPath(candidate, [root], 'workflow');
        if (resource !== undefined) return resource;
      }
    } else {
      const candidates = normalRoots.flatMap((root) => yamlCandidates(join(root, ref)).map((path) => ({ root, path })));
      const resource = readFirstResource(candidates, 'workflow');
      if (resource !== undefined) return resource;
    }
    throw new Error(`Workflow Maker could not resolve workflow "${ref}"`);
  }

  #rewriteFacetSections(
    raw: RawRecord,
    ownerSource: string,
    ownerDestination: string,
    trustedRoot?: string,
    dependencyRootsByType?: Readonly<Record<FacetType, readonly string[]>>,
  ): void {
    for (const [sectionName, facetType] of Object.entries(FACET_SECTIONS)) {
      const section = raw[sectionName];
      if (!isRecord(section)) continue;
      for (const [alias, value] of Object.entries(section)) {
        if (typeof value !== 'string') continue;
        if (!isExplicitFacetPath(value) && !isScopeRef(value)) continue;
        section[alias] = this.#rewriteFacetReferenceValue(
          value,
          facetType,
          ownerSource,
          ownerDestination,
          trustedRoot,
          true,
          true,
          dependencyRootsByType?.[facetType],
        );
      }
    }
  }

  #rewriteDirectStepFacets(
    step: RawRecord,
    ownerSource: string,
    ownerDestination: string,
    workflow: RawRecord,
  ): void {
    for (const [field, facetType] of Object.entries(STEP_FACET_FIELDS)) {
      if (!(field in step)) continue;
      const section = workflow[FACET_SECTION_BY_TYPE[facetType]];
      step[field] = this.#rewriteFacetField(
        step[field],
        facetType,
        ownerSource,
        ownerDestination,
        section,
        field === 'instruction',
      );
    }
  }

  #rewriteFacetField(
    value: unknown,
    facetType: FacetType,
    ownerSource: string,
    ownerDestination: string,
    localSection: unknown,
    allowUnresolvedBareLiteral = false,
  ): unknown {
    const rewrite = (entry: unknown): unknown => {
      if (typeof entry === 'string' && isRecord(localSection) && Object.hasOwn(localSection, entry)) {
        return entry;
      }
      return this.#rewriteFacetReferenceValue(
        entry,
        facetType,
        ownerSource,
        ownerDestination,
        undefined,
        true,
        allowUnresolvedBareLiteral,
      );
    };
    return Array.isArray(value) ? value.map(rewrite) : rewrite(value);
  }

  #rewriteTypedFacetReference(
    value: unknown,
    facetKind: unknown,
    ownerSource: string,
    ownerDestination: string,
    localWorkflow: RawRecord,
  ): unknown {
    const facetType = normalizeFacetType(facetKind);
    if (facetType === undefined) return value;
    return this.#rewriteFacetField(
      value,
      facetType,
      ownerSource,
      ownerDestination,
      localWorkflow[FACET_SECTION_BY_TYPE[facetType]],
    );
  }

  #rewriteFacetReferenceValue(
    value: unknown,
    facetType: unknown,
    ownerSource: string,
    ownerDestination: string,
    trustedRoot?: string,
    mustResolve = false,
    allowUnresolvedBareLiteral = false,
    dependencyRoots?: readonly string[],
  ): unknown {
    if (typeof value !== 'string') return value;
    const normalizedFacetType = normalizeFacetType(facetType);
    if (normalizedFacetType === undefined) return value;
    requireStaticReference(value, `${normalizedFacetType} facet`);
    const rewritten = this.#copyFacetReference(
      value,
      normalizedFacetType,
      ownerSource,
      ownerDestination,
      trustedRoot,
      dependencyRoots,
    );
    if (rewritten === undefined) {
      if (isScopeRef(value) || (mustResolve && !allowUnresolvedBareLiteral && !/\s/.test(value))) {
        throw new Error(`Workflow Maker could not resolve ${normalizedFacetType} facet "${value}"`);
      }
      return value;
    }
    return rewritten;
  }

  #copyFacetReference(
    ref: string,
    facetType: FacetType,
    ownerSource: string,
    ownerDestination: string,
    trustedRoot?: string,
    dependencyRoots?: readonly string[],
  ): string | undefined {
    const context = { ...this.#context, workflowDir: dirname(ownerSource) };
    let scopedRoot: string | undefined;
    if (isScopeRef(ref) && context.repertoireDir !== undefined) {
      const scope = parseScopeRef(ref);
      scopedRoot = getRepertoireFacetDir(scope.owner, scope.repo, facetType, context.repertoireDir);
    }
    const candidateRoots = uniquePaths([
      ...(trustedRoot === undefined ? [] : [trustedRoot]),
      ...(scopedRoot === undefined ? [] : [scopedRoot]),
      ...buildCandidateDirsWithPackage(facetType, context),
    ]);
    const looksLikePath = isExplicitFacetPath(ref);
    let resource: SafeResource | undefined;
    if (looksLikePath) {
      const candidate = isAbsolute(ref) ? ref : resolve(dirname(ownerSource), ref);
      resource = readResourceAtPath(candidate, candidateRoots, `${facetType} facet`);
    } else if (dependencyRoots !== undefined && !isScopeRef(ref)) {
      resource = readFirstResource(
        dependencyRoots.map((root) => ({ root, path: join(root, `${ref}.md`) })),
        `${facetType} facet`,
      );
    } else {
      const sourcePath = resolveFacetPath(ref, facetType, context);
      if (sourcePath !== undefined) {
        resource = readResourceAtPath(sourcePath, candidateRoots, `${facetType} facet`);
      }
    }
    if (resource === undefined) {
      if (looksLikePath) {
        throw new Error(`Workflow Maker could not resolve ${facetType} facet file "${ref}"`);
      }
      return undefined;
    }
    const destination = this.#allocateFacetDestination(resource, facetType);
    if (!this.#files.has(destination)) {
      this.#planFacet(
        resource,
        destination,
        facetType,
        context,
        uniquePaths([dirname(resource.path), ...(dependencyRoots ?? candidateRoots)]),
        dependencyRoots !== undefined,
      );
    }
    return relativeReference(
      dirname(join(this.#artifactRoot, ownerDestination)),
      join(this.#artifactRoot, destination),
    );
  }

  #allocateFacetDestination(resource: SafeResource, facetType: FacetType): string {
    const existing = this.#destinationsBySource.get(resource.canonicalPath);
    if (existing !== undefined) return existing;
    const directory = join('facets', facetType);
    const preferred = basename(resource.path);
    const extension = extname(preferred);
    const stem = basename(preferred, extension);
    let destination = join(directory, preferred);
    if (this.#sourcesByDestination.has(destination)) {
      const suffix = createHash('sha256').update(resource.canonicalPath).digest('hex').slice(0, 8);
      destination = join(directory, `${stem}-${suffix}${extension}`);
    }
    this.#rememberDestination(resource, destination);
    return destination;
  }

  #planFacet(
    resource: SafeResource,
    destination: string,
    facetType: FacetType,
    context: FacetResolutionContext,
    candidateRoots: readonly string[],
    restrictToCandidateRoots: boolean,
  ): void {
    if (this.#facetsInProgress.has(resource.canonicalPath)) {
      throw new Error(`Workflow Maker detected a facet dependency cycle at ${resource.path}`);
    }
    this.#facetsInProgress.add(resource.canonicalPath);
    try {
      let content = resource.content;
      const extendsMatches = [...content.matchAll(EXTENDS_LINE_PATTERN)];
      if (content.includes('{extends:') && extendsMatches.length !== 1) {
        throw new Error(`Workflow Maker requires exactly one valid facet extends directive in ${resource.path}`);
      }
      const extendsMatch = extendsMatches[0];
      if (extendsMatch !== undefined) {
        const parentName = (extendsMatch[1] ?? '').trim();
        if (!SAFE_WORKFLOW_NAME.test(parentName)) {
          throw new Error(`Invalid Workflow Maker facet extends reference "${parentName}"`);
        }
        const sourceLayer = candidateRoots.findIndex((root) => isPathInside(root, resource.path));
        const parentRoots = sourceLayer < 0 ? candidateRoots : candidateRoots.slice(sourceLayer);
        const parent = readFirstResource(
          parentRoots.map((root) => ({ root, path: join(root, `${parentName}.md`) })),
          `${facetType} facet extends`,
        );
        if (parent === undefined) {
          throw new Error(`Workflow Maker could not resolve facet extends parent "${parentName}"`);
        }
        const parentDestination = this.#allocateFacetDestination(parent, facetType);
        if (!this.#files.has(parentDestination)) {
          this.#planFacet(
            parent,
            parentDestination,
            facetType,
            context,
            parentRoots,
            restrictToCandidateRoots,
          );
        }
        const localParent = basename(parentDestination, extname(parentDestination));
        content = `${content.slice(0, extendsMatch.index)}{extends:${localParent}}${content.slice(
          (extendsMatch.index ?? 0) + extendsMatch[0].length,
        )}`;
      }
      this.#files.set(destination, content);
      const includeRoots = uniquePaths([
        ...candidateRoots.map(facetRootFromCandidateDir),
        ...(restrictToCandidateRoots ? [] : buildFacetsRoots({
          ...context,
          workflowDir: dirname(resource.path),
        })),
      ]);
      this.#planFacetIncludes(
        content,
        resource.path,
        includeRoots,
      );
    } finally {
      this.#facetsInProgress.delete(resource.canonicalPath);
    }
  }

  #planFacetIncludes(
    content: string,
    sourcePath: string,
    roots: readonly string[],
  ): void {
    for (const match of content.matchAll(INCLUDE_PATTERN)) {
      const facetType = match[1];
      const includeName = match[2];
      if (facetType === undefined || includeName === undefined) continue;
      if (includeName.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`Invalid Workflow Maker facet include in ${sourcePath}`);
      }
      const relativePartial = join('partials', facetType, `${includeName}.md`);
      const include = readFirstResource(
        roots.map((root) => ({ root, path: join(root, relativePartial) })),
        'facet include',
      );
      if (include === undefined) {
        throw new Error(`Workflow Maker could not resolve facet include "${facetType}/${includeName}"`);
      }
      const destination = join('facets', relativePartial);
      const existing = this.#sourcesByDestination.get(destination);
      if (existing !== undefined && existing !== include.canonicalPath) {
        throw new Error(`Workflow Maker cannot preserve colliding facet include "${facetType}/${includeName}"`);
      }
      this.#rememberDestination(include, destination);
      if (!this.#files.has(destination)) {
        this.#files.set(destination, include.content);
        this.#planFacetIncludes(
          include.content,
          include.path,
          roots,
        );
      }
    }
  }
}

function buildNewWorkflow(name: string): string {
  return stringifyYaml({
    name,
    description: 'Created with Workflow Maker.',
    initial_step: 'create',
    max_steps: 1,
    steps: [{
      name: 'create',
      instruction: 'Implement the requested workflow.',
      rules: [{ condition: 'completed', next: 'COMPLETE' }],
    }],
  });
}

export async function planWorkflowMakerArtifact(
  options: PlanWorkflowMakerArtifactOptions,
): Promise<WorkflowMakerArtifactPlan> {
  const projectDir = resolve(options.projectDir);
  const artifactRoot = selectArtifactRoot(projectDir, options.now ?? (() => new Date()));
  if (options.base.kind === 'new') {
    assertSafeWorkflowName(options.base.name);
    const relativePath = join('workflows', `${options.base.name}.yaml`);
    return {
      artifactRoot,
      rootWorkflowPath: join(artifactRoot, relativePath),
      workflowName: options.base.name,
      files: [{ relativePath, content: buildNewWorkflow(options.base.name) }],
    };
  }

  const sourcePath = resolve(options.base.workflow.path);
  const planner = new DependencyPlanner(projectDir, artifactRoot, sourcePath);
  const rootWorkflowPath = planner.planRootWorkflow(sourcePath, options.base.workflow.source);
  return {
    artifactRoot,
    rootWorkflowPath,
    workflowName: options.base.workflow.name,
    files: planner.files,
  };
}

export async function materializeWorkflowMakerArtifact(plan: WorkflowMakerArtifactPlan): Promise<void> {
  const parent = dirname(plan.artifactRoot);
  mkdirSync(parent, { recursive: true });
  mkdirSync(plan.artifactRoot);
  for (const directory of [
    'workflows',
    'steps',
    'facet-pools',
    'facets',
    'schemas',
    'assets',
    'companions',
    'provider-options',
  ]) {
    mkdirSync(join(plan.artifactRoot, directory));
  }
  for (const file of plan.files) {
    const destination = join(plan.artifactRoot, file.relativePath);
    const normalizedRoot = resolve(plan.artifactRoot);
    const normalizedDestination = resolve(destination);
    const boundary = relative(normalizedRoot, normalizedDestination);
    if (boundary === '..' || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
      throw new Error(`Workflow Maker artifact path escapes its root: ${file.relativePath}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content, { encoding: 'utf-8', flag: 'wx' });
  }
}
