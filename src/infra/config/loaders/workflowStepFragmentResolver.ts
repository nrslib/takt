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
  formatPropertyPath,
  getOwnValue,
  isPlainObject,
  isRecord,
  readStepFragment,
  type RawRecord,
  workflowError,
} from './workflowStepFragmentReader.js';
import {
  collectFragmentProvenance,
  isPathWithin,
  withoutOverriddenProvenance,
  type WorkflowStepFragmentProvenance,
} from './workflowStepFragmentProvenance.js';
import {
  bindStepFragmentParams,
  getBoundStepFragmentSource,
  getWorkflowParamDeclarations,
  type FragmentParamDeclaration,
} from './workflowStepFragmentParams.js';
import { assertWorkflowCallTrustBoundaries } from './workflowStepFragmentTrust.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
import { WorkflowRuleSchema } from '../../../core/models/workflow-schemas.js';

export type { WorkflowStepFragmentProvenance } from './workflowStepFragmentProvenance.js';

export interface WorkflowStepFragmentResolution {
  raw: unknown;
  provenance: readonly WorkflowStepFragmentProvenance[];
  dependencies: readonly WorkflowStepFragmentDependency[];
  rulePathMappings: readonly WorkflowStepFragmentRulePathMapping[];
}

export interface WorkflowStepFragmentRulePathMapping {
  readonly normalizedPath: readonly PropertyKey[];
  readonly callerPath: readonly PropertyKey[];
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

interface InternalWorkflowStepFragmentResolverOptions extends WorkflowStepFragmentResolverOptions {
  outerParams: ReadonlyMap<string, FragmentParamDeclaration>;
  rulePathMappings: WorkflowStepFragmentRulePathMapping[];
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

type ConcreteCallerLocation = 'top-level' | 'parallel-child';

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

function isNonEmptyRulesArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function assertNonEmptyRulesArray(
  value: unknown,
  workflowPath: string,
  rulesPath: readonly PropertyKey[],
): void {
  if (!isNonEmptyRulesArray(value)) {
    throw workflowError(
      workflowPath,
      `must define a non-empty rules array at ${formatPropertyPath(rulesPath)}`,
    );
  }
  for (const [index, rule] of value.entries()) {
    const parsed = WorkflowRuleSchema.safeParse(rule);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    const issuePath = issue === undefined
      ? [...rulesPath, index]
      : [...rulesPath, index, ...issue.path];
    throw workflowError(
      workflowPath,
      `invalid rule at ${formatPropertyPath(issuePath)}: ${issue?.message ?? 'invalid rule definition'}`,
    );
  }
}

function assertRawRuleSpec(
  value: unknown,
  workflowPath: string,
  rulesPath: readonly PropertyKey[],
): void {
  if (Array.isArray(value)) {
    assertNonEmptyRulesArray(value, workflowPath, rulesPath);
    return;
  }
  if (!isPlainObject(value)) {
    throw workflowError(
      workflowPath,
      `step using a fragment must define a non-empty rules array or rule tree at ${formatPropertyPath(rulesPath)}`,
    );
  }
  const keys = Object.keys(value);
  const unknownKey = keys.find((key) => key !== 'self' && key !== 'parallel');
  if (unknownKey !== undefined) {
    throw workflowError(
      workflowPath,
      `rule tree at ${formatPropertyPath(rulesPath)} contains unknown property "${unknownKey}"`,
    );
  }
  const self = getOwnValue(value, 'self');
  assertNonEmptyRulesArray(self, workflowPath, [...rulesPath, 'self']);
  const parallel = getOwnValue(value, 'parallel');
  if (!isPlainObject(parallel) || Object.keys(parallel).length === 0) {
    throw workflowError(
      workflowPath,
      `rule tree must define at least one parallel child at ${formatPropertyPath([...rulesPath, 'parallel'])}`,
    );
  }
  for (const [childName, childRules] of Object.entries(parallel)) {
    assertNonEmptyRulesArray(childRules, workflowPath, [...rulesPath, 'parallel', childName]);
  }
}

function assertConcreteFragmentCallersDefineRules(
  value: unknown,
  workflowPath: string,
  stepPath: readonly PropertyKey[],
  callerLocation: ConcreteCallerLocation,
): void {
  if (!isRecord(value)) return;
  const uses = getOwnValue(value, 'uses');
  if (typeof uses === 'string' && uses.trim().length > 0) {
    const rules = getOwnValue(value, 'rules');
    if (callerLocation === 'parallel-child') {
      assertNonEmptyRulesArray(rules, workflowPath, [...stepPath, 'rules']);
    } else {
      assertRawRuleSpec(rules, workflowPath, [...stepPath, 'rules']);
    }
  }
  const parallel = getOwnValue(value, 'parallel');
  if (!Array.isArray(parallel)) return;
  for (const [index, subStep] of parallel.entries()) {
    assertConcreteFragmentCallersDefineRules(
      subStep,
      workflowPath,
      [...stepPath, 'parallel', index],
      'parallel-child',
    );
  }
}

function normalizeConcreteFragmentCallerRules(
  value: RawRecord,
  ruleSpec: unknown,
  workflowPath: string,
  stepPath: readonly PropertyKey[],
  callerRulesPath: readonly PropertyKey[],
  ref: string,
  rulePathMappings: WorkflowStepFragmentRulePathMapping[],
  callerLocation: ConcreteCallerLocation,
): RawRecord {
  const normalizedRulesPath = [...stepPath, 'rules'];
  const normalizeRulesArray = (): RawRecord => {
    if (!isNonEmptyRulesArray(ruleSpec)) {
      throw workflowError(
        workflowPath,
        `step using fragment "${ref}" must define a non-empty rules array at ${formatPropertyPath(callerRulesPath)}`,
      );
    }
    for (const index of ruleSpec.keys()) {
      rulePathMappings.push({
        normalizedPath: [...normalizedRulesPath, index],
        callerPath: [...callerRulesPath, index],
      });
    }
    return { ...value, rules: ruleSpec };
  };
  if (callerLocation === 'parallel-child') return normalizeRulesArray();
  const parallel = getOwnValue(value, 'parallel');
  if (!Array.isArray(parallel)) return normalizeRulesArray();
  if (!isPlainObject(ruleSpec)) {
    throw workflowError(
      workflowPath,
      `step using fragment "${ref}" resolves to a parallel step, so ${formatPropertyPath(callerRulesPath)} must be a rule tree`,
    );
  }
  const self = getOwnValue(ruleSpec, 'self');
  const childRuleSpecs = getOwnValue(ruleSpec, 'parallel');
  if (!isNonEmptyRulesArray(self) || !isPlainObject(childRuleSpecs)) {
    throw workflowError(workflowPath, `invalid rule tree at ${formatPropertyPath(callerRulesPath)}`);
  }
  for (const index of self.keys()) {
    rulePathMappings.push({
      normalizedPath: [...normalizedRulesPath, index],
      callerPath: [...callerRulesPath, 'self', index],
    });
  }
  const childNames = new Set<string>();
  const normalizedParallel = parallel.map((child, index) => {
    const childPath = [...stepPath, 'parallel', index];
    if (!isRecord(child)) {
      throw workflowError(
        workflowPath,
        `parallel child at ${formatPropertyPath(childPath)} must be an object`,
      );
    }
    const childName = getOwnValue(child, 'name');
    if (typeof childName !== 'string' || childName.trim().length === 0) {
      throw workflowError(
        workflowPath,
        `parallel child at ${formatPropertyPath([...childPath, 'name'])} must define an explicit non-empty name for rule-tree matching`,
      );
    }
    if (childNames.has(childName)) {
      throw workflowError(
        workflowPath,
        `parallel step using fragment "${ref}" contains duplicate child name "${childName}" at ${formatPropertyPath(childPath)}`,
      );
    }
    childNames.add(childName);
    if (!Object.hasOwn(childRuleSpecs, childName)) {
      throw workflowError(
        workflowPath,
        `rule tree at ${formatPropertyPath([...callerRulesPath, 'parallel'])} is missing child "${childName}"`,
      );
    }
    const childRules = childRuleSpecs[childName];
    if (!isNonEmptyRulesArray(childRules)) {
      throw workflowError(
        workflowPath,
        `rule tree must define a non-empty rules array at ${formatPropertyPath([...callerRulesPath, 'parallel', childName])}`,
      );
    }
    for (const ruleIndex of childRules.keys()) {
      rulePathMappings.push({
        normalizedPath: [...childPath, 'rules', ruleIndex],
        callerPath: [...callerRulesPath, 'parallel', childName, ruleIndex],
      });
    }
    return { ...child, rules: childRules };
  });
  const unknownChild = Object.keys(childRuleSpecs).find((childName) => !childNames.has(childName));
  if (unknownChild !== undefined) {
    throw workflowError(
      workflowPath,
      `rule tree at ${formatPropertyPath([...callerRulesPath, 'parallel'])} references unknown child "${unknownChild}"`,
    );
  }
  return { ...value, parallel: normalizedParallel, rules: self };
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
  options: InternalWorkflowStepFragmentResolverOptions,
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
    const result = expandStep(
      subStep,
      scope,
      stack,
      nextReferenceCount,
      options,
      [...stepPath, 'parallel', index],
      true,
      true,
      'parallel-child',
    );
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
  options: InternalWorkflowStepFragmentResolverOptions,
  stepPath: readonly PropertyKey[],
  concrete: boolean,
  expandParallelChildren = true,
  callerLocation: ConcreteCallerLocation = 'top-level',
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
  const rawFragment = readStepFragment(resolved.path, options.workflowPath, uses);
  const callerSource = getBoundStepFragmentSource(value);
  const boundFragment = bindStepFragmentParams(rawFragment, value, {
    callerPath: callerSource?.path ?? stepPath,
    callerSourcePath: callerSource?.sourcePath ?? options.workflowPath,
    fragmentPath: resolved.path,
    outerParams: options.outerParams,
    workflowPath: options.workflowPath,
  });
  const fragment = boundFragment.value;
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
  const boundPaths = boundFragment.boundPaths.map((path) => [...stepPath, ...path]);
  const fragmentProvenance = [
    ...(fragmentUses === undefined
      ? expandedBase.provenance
      : withoutOverriddenProvenance(expandedBase.provenance, expandedBase.value, fragmentInline, stepPath)),
    ...collectFragmentProvenance(fragmentInline, uses, resolved.path, stepPath),
  ].filter((entry) => !boundPaths.some((path) => isPathWithin(entry.stepPath, path)));
  const callerRuleSpec = getOwnValue(value, 'rules');
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
  delete inlineStep.rules;
  delete inlineStep.with;
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
  const namedExpandedValue = generatedName
    ? { ...expanded.value, name: usesName(uses) }
    : expanded.value;
  const expandedValue = concrete && stack.length === 0
    ? normalizeConcreteFragmentCallerRules(
      namedExpandedValue,
      callerRuleSpec,
      options.workflowPath,
      stepPath,
      [...stepPath, 'rules'],
      uses,
      options.rulePathMappings,
      callerLocation,
    )
    : namedExpandedValue;
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
      rulePathMappings: Object.freeze([]),
    };
  }
  const rawSteps = getOwnValue(raw, 'steps');
  if (!Array.isArray(rawSteps)) {
    return {
      raw,
      provenance: Object.freeze([]),
      dependencies: Object.freeze([]),
      rulePathMappings: Object.freeze([]),
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
  const rulePathMappings: WorkflowStepFragmentRulePathMapping[] = [];
  const internalOptions: InternalWorkflowStepFragmentResolverOptions = {
    ...options,
    outerParams: getWorkflowParamDeclarations(raw),
    rulePathMappings,
  };
  const steps: unknown[] = [];
  for (const [index, step] of rawSteps.entries()) {
    assertConcreteFragmentCallersDefineRules(step, options.workflowPath, ['steps', index], 'top-level');
    const result = expandStep(step, scope, [], referenceCount, internalOptions, ['steps', index], true);
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
    rulePathMappings: Object.freeze([...rulePathMappings]),
  };
}
