import { realpathSync } from 'node:fs';
import type { FacetResolutionContext } from './resource-resolver.js';
import {
  getStepFragmentLookupDirs,
  resolveStepFragment,
  type ResolvedStepFragment,
  type ScopedStepFragmentCandidateDirs,
  type StepFragmentLookupScope,
} from './stepFragmentLookupDirectories.js';
import {
  assertSafeStepFragmentObject,
  getOwnValue,
  isPlainObject,
  isRecord,
  readStepFragment,
  type RawRecord,
  workflowError,
} from './workflowStepFragmentReader.js';
import {
  collectFragmentProvenance,
  withoutOverriddenProvenance,
  type WorkflowStepFragmentProvenance,
} from './workflowStepFragmentProvenance.js';
import { assertWorkflowCallTrustBoundaries } from './workflowStepFragmentTrust.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';

export type { WorkflowStepFragmentProvenance } from './workflowStepFragmentProvenance.js';

export interface WorkflowStepFragmentResolution {
  raw: unknown;
  provenance: readonly WorkflowStepFragmentProvenance[];
  dependencies: readonly WorkflowStepFragmentDependency[];
}

export interface WorkflowStepFragmentDependency {
  readonly ref: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}

export interface WorkflowStepFragmentResolverOptions {
  candidateDirs?: readonly string[];
  scopedCandidateDirs?: ScopedStepFragmentCandidateDirs;
  context?: FacetResolutionContext;
  workflowPath: string;
  trustInfo?: WorkflowTrustInfo;
  nestedCandidateDirs?: (fragment: ResolvedStepFragment) => readonly string[] | undefined;
}

interface ExpandedStep {
  value: unknown;
  provenance: readonly WorkflowStepFragmentProvenance[];
  dependencies: readonly WorkflowStepFragmentDependency[];
  referenceCount: number;
  parallelContext?: ParallelExpansionContext;
}

interface ParallelExpansionContext {
  scope: StepFragmentLookupScope;
  stack: readonly FragmentStackEntry[];
}

interface FragmentStackEntry {
  ref: string;
  sourcePath: string;
  realPath: string;
}

const MAX_STEP_FRAGMENT_DEPTH = 64;
const MAX_STEP_FRAGMENT_REFERENCES = 512;

function mergeStepValues(base: RawRecord, override: RawRecord): RawRecord {
  const result: RawRecord = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    if (overrideValue === undefined) continue;
    const baseValue = getOwnValue(base, key);
    result[key] = isPlainObject(baseValue) && isPlainObject(overrideValue)
      ? mergeStepValues(baseValue, overrideValue)
      : overrideValue;
  }
  return result;
}

function removeUses(step: RawRecord): RawRecord {
  const inline = { ...step };
  delete inline.uses;
  return inline;
}

function usesName(ref: string): string {
  const segments = ref.split('/');
  return segments[segments.length - 1]!;
}

function containingFragmentOrigin(stack: readonly FragmentStackEntry[]): string {
  const containingFragment = stack.at(-1);
  return containingFragment
    ? ` from step fragment "${containingFragment.ref}" at ${containingFragment.sourcePath}`
    : '';
}

function createDependency(ref: string, resolved: ResolvedStepFragment): WorkflowStepFragmentDependency {
  return Object.freeze({
    ref,
    sourcePath: resolved.path,
    sourceRoot: resolved.candidateDir,
  });
}

function expandParallel(
  step: RawRecord,
  scope: StepFragmentLookupScope,
  stack: readonly FragmentStackEntry[],
  referenceCount: number,
  options: WorkflowStepFragmentResolverOptions,
  stepPath: readonly PropertyKey[],
): ExpandedStep {
  const parallel = getOwnValue(step, 'parallel');
  if (!Array.isArray(parallel)) {
    return { value: { ...step }, provenance: [], dependencies: [], referenceCount };
  }
  let nextReferenceCount = referenceCount;
  const provenance: WorkflowStepFragmentProvenance[] = [];
  const dependencies: WorkflowStepFragmentDependency[] = [];
  const expanded: unknown[] = [];
  for (const [index, subStep] of parallel.entries()) {
    const result = expandStep(subStep, scope, stack, nextReferenceCount, options, [...stepPath, 'parallel', index], true);
    nextReferenceCount = result.referenceCount;
    provenance.push(...result.provenance);
    dependencies.push(...result.dependencies);
    expanded.push(result.value);
  }
  return { value: { ...step, parallel: expanded }, provenance, dependencies, referenceCount: nextReferenceCount };
}

function expandStep(
  value: unknown,
  scope: StepFragmentLookupScope,
  stack: readonly FragmentStackEntry[],
  referenceCount: number,
  options: WorkflowStepFragmentResolverOptions,
  stepPath: readonly PropertyKey[],
  concrete: boolean,
  expandParallelChildren = true,
): ExpandedStep {
  if (!isRecord(value)) return { value, provenance: [], dependencies: [], referenceCount };
  const uses = getOwnValue(value, 'uses');
  if (uses === undefined) {
    const stepOutsideParallel = { ...value };
    delete stepOutsideParallel.parallel;
    assertSafeStepFragmentObject(stepOutsideParallel, options.workflowPath, 'workflow step');
    if (expandParallelChildren) {
      return expandParallel(value, scope, stack, referenceCount, options, stepPath);
    }
    return {
      value: { ...value },
      provenance: [],
      dependencies: [],
      referenceCount,
      parallelContext: Array.isArray(getOwnValue(value, 'parallel')) ? { scope, stack } : undefined,
    };
  }
  if (typeof uses !== 'string' || uses.trim().length === 0) {
    throw workflowError(options.workflowPath, `step fragment uses must be a non-empty string${containingFragmentOrigin(stack)}`);
  }
  if (stack.length >= MAX_STEP_FRAGMENT_DEPTH) {
    throw workflowError(options.workflowPath, `step fragment "${uses}" exceeds maximum expansion depth of ${MAX_STEP_FRAGMENT_DEPTH}${containingFragmentOrigin(stack)}`);
  }
  let resolved;
  try {
    resolved = resolveStepFragment(uses, scope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const origin = containingFragmentOrigin(stack);
    throw workflowError(options.workflowPath, `failed to resolve step fragment "${uses}"${origin}: ${message}`);
  }
  if (!resolved) {
    const origin = containingFragmentOrigin(stack);
    const candidateDirs = getStepFragmentLookupDirs(uses, scope);
    throw workflowError(options.workflowPath, `step fragment "${uses}"${origin} was not found (searched: ${candidateDirs.length > 0 ? candidateDirs.join(', ') : 'steps roots'})`);
  }
  if (referenceCount >= MAX_STEP_FRAGMENT_REFERENCES) {
    throw workflowError(options.workflowPath, `step fragment "${uses}" at ${resolved.path} exceeds maximum expansion count of ${MAX_STEP_FRAGMENT_REFERENCES}${containingFragmentOrigin(stack)}`);
  }
  let realPath: string;
  try {
    realPath = realpathSync(resolved.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw workflowError(options.workflowPath, `failed to access step fragment "${uses}" at ${resolved.path}: ${message}`);
  }
  if (stack.some((entry) => entry.realPath === realPath)) {
    throw workflowError(options.workflowPath, `circular step fragment reference "${uses}": ${[...stack.map((entry) => entry.sourcePath), resolved.path].join(' -> ')}`);
  }
  const fragment = readStepFragment(resolved.path, options.workflowPath, uses);
  const fragmentScope: StepFragmentLookupScope = {
    context: options.context,
    candidateDirs: options.nestedCandidateDirs?.(resolved) ?? resolved.candidateDirs,
    scopedCandidateDirs: scope.scopedCandidateDirs,
  };
  const fragmentStack = [...stack, { ref: uses, sourcePath: resolved.path, realPath }];
  const expandedBase = expandStep(
    fragment,
    fragmentScope,
    fragmentStack,
    referenceCount + 1,
    options,
    stepPath,
    false,
    false,
  );
  if (!isRecord(expandedBase.value)) {
    throw workflowError(options.workflowPath, `step fragment "${uses}" at ${resolved.path} must resolve to one step object`);
  }
  const fragmentInline = removeUses(fragment);
  const fragmentUses = getOwnValue(fragment, 'uses');
  const fragmentValue = expandedBase.value;
  const fragmentProvenance = [
    ...(fragmentUses === undefined
      ? expandedBase.provenance
      : withoutOverriddenProvenance(expandedBase.provenance, expandedBase.value, fragmentInline, stepPath)),
    ...collectFragmentProvenance(fragmentInline, uses, resolved.path, stepPath),
  ];
  const inlineStep = removeUses(value);
  try {
    assertSafeStepFragmentObject(inlineStep, options.workflowPath, `step using fragment "${uses}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw workflowError(
      options.workflowPath,
      `${message} (from step fragment "${uses}" at ${resolved.path})`,
    );
  }
  const merged = mergeStepValues(fragmentValue, inlineStep);
  const fragmentParallelContext = getOwnValue(fragmentInline, 'parallel') === undefined
    ? expandedBase.parallelContext
    : { scope: fragmentScope, stack: fragmentStack };
  const parallelContext = getOwnValue(inlineStep, 'parallel') === undefined
    ? fragmentParallelContext
    : { scope, stack };
  const expanded = parallelContext === undefined
    ? { value: merged, provenance: [], dependencies: [], referenceCount: expandedBase.referenceCount }
    : expandParallel(
      merged,
      parallelContext.scope,
      parallelContext.stack,
      expandedBase.referenceCount,
      options,
      stepPath,
    );
  if (!isRecord(expanded.value)) throw workflowError(options.workflowPath, `step using fragment "${uses}" must be an object`);
  const provenance = [
    ...withoutOverriddenProvenance(fragmentProvenance, fragmentValue, inlineStep, stepPath),
    ...expanded.provenance,
  ];
  const dependencies = [
    createDependency(uses, resolved),
    ...expandedBase.dependencies,
    ...expanded.dependencies,
  ];
  const generatedName = concrete && getOwnValue(expanded.value, 'name') === undefined;
  const expandedValue = generatedName
    ? { ...expanded.value, name: usesName(uses) }
    : expanded.value;
  if (concrete && getWorkflowStepKind(expandedValue) === 'system') {
    throw workflowError(options.workflowPath, `step fragment "${uses}" at ${resolved.path} resolves to unsupported kind "system"`);
  }
  return {
    value: expandedValue,
    provenance: generatedName
      ? [...provenance, { stepPath: [...stepPath, 'name'], ref: uses, sourcePath: resolved.path }]
      : provenance,
    dependencies,
    referenceCount: expanded.referenceCount,
  };
}

export function resolveWorkflowStepFragments(raw: unknown, options: WorkflowStepFragmentResolverOptions): WorkflowStepFragmentResolution {
  if (!isRecord(raw)) {
    return {
      raw,
      provenance: Object.freeze([]),
      dependencies: Object.freeze([]),
    };
  }
  const rawSteps = getOwnValue(raw, 'steps');
  if (!Array.isArray(rawSteps)) {
    return {
      raw,
      provenance: Object.freeze([]),
      dependencies: Object.freeze([]),
    };
  }
  const workflowOutsideSteps = { ...raw };
  delete workflowOutsideSteps.steps;
  assertSafeStepFragmentObject(workflowOutsideSteps, options.workflowPath, 'workflow');
  const scope: StepFragmentLookupScope = {
    context: options.context,
    candidateDirs: options.candidateDirs,
    scopedCandidateDirs: options.scopedCandidateDirs,
  };
  let referenceCount = 0;
  const provenance: WorkflowStepFragmentProvenance[] = [];
  const dependencies: WorkflowStepFragmentDependency[] = [];
  const steps: unknown[] = [];
  for (const [index, step] of rawSteps.entries()) {
    const result = expandStep(step, scope, [], referenceCount, options, ['steps', index], true);
    referenceCount = result.referenceCount;
    provenance.push(...result.provenance);
    dependencies.push(...result.dependencies);
    steps.push(result.value);
  }
  const expanded = { ...raw, steps };
  assertWorkflowCallTrustBoundaries(expanded, options, provenance);
  return {
    raw: expanded,
    provenance: Object.freeze([...provenance]),
    dependencies: Object.freeze([...dependencies]),
  };
}
