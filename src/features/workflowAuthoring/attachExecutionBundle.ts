import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import { readRunMetaBySlug } from '../../core/workflow/run/run-meta.js';
import {
  parseWorkflowCallInvocationIdentity,
  parseWorkflowExecutionIdentity,
  type WorkflowExecutionIdentity,
} from '../../core/workflow/workflow-execution-identity-codec.js';
import { getWorkflowReference } from '../../core/workflow/workflow-reference.js';
import { restoreWorkflowCallInvocationEvidence } from '../../core/workflow/workflow-call-invocation-index.js';
import { restoreWorkflowStepParticipationIndex } from '../../core/workflow/workflow-step-participation-index.js';
import { parseWorkflowCallNamespaceSegment } from '../../core/workflow/workflow-call-namespace.js';
import type { WorkflowStep } from '../../core/models/index.js';
import { getAllParallelSubSteps } from '../../core/models/index.js';
import { getWorkflowResumeFrameKind, isWorkflowCallStep } from '../../core/workflow/step-kind.js';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import { trimResumePointStackForWorkflow } from '../../core/workflow/run/resume-point.js';
import { isValidReportDirName } from '../../shared/utils/index.js';
import { loadWorkflowByIdentifier } from '../../infra/config/index.js';
import { invalidateGlobalConfigCache } from '../../infra/config/global/globalConfig.js';
import { withGlobalConfigDirOverride } from '../../infra/config/paths.js';
import { withResourcesDirOverride } from '../../infra/resources/index.js';
import { createWorkflowExecutionContext, createWorkflowCallResolver } from '../tasks/execute/workflowExecutionContext.js';
import {
  prepareWorkflowExecutionBundle,
  loadWorkflowExecutionBundle,
  publishWorkflowExecutionBundle,
} from '../tasks/execute/workflowExecutionBundle.js';

export interface AttachLegacyWorkflowExecutionBundleOptions {
  readonly projectDir: string;
  readonly runSlug: string;
  readonly sourceRoot: string;
  readonly rootWorkflow: string;
  readonly dryRun?: boolean;
}

export interface AttachLegacyWorkflowExecutionBundleResult {
  readonly runSlug: string;
  readonly workflowName: string;
  readonly rootWorkflowRef: string;
  readonly nodeCount: number;
  readonly published: boolean;
}

function isInsideOrSame(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function requireRegularPathInside(root: string, target: string, label: string): string {
  const resolvedRoot = realpathSync(root);
  const resolvedTarget = realpathSync(target);
  if (!isInsideOrSame(resolvedRoot, resolvedTarget)) throw new Error(`${label} must be inside historical source root`);
  const stat = lstatSync(resolvedTarget);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return resolvedTarget;
}

function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Legacy attach identity artifact is not a regular file: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function collectIdentityRefs(parsed: WorkflowExecutionIdentity, refs: Set<string>): void {
  refs.add(parsed.workflow);
  parsed.calls.forEach((call) => refs.add(call.workflow));
}

function collectHistoricalEvidence(meta: NonNullable<ReturnType<typeof readRunMetaBySlug>>): {
  readonly refs: Set<string>;
  readonly identities: Set<string>;
  readonly invocationTargets: ReadonlyMap<string, string>;
  readonly rootRef: string;
  readonly childByCall: Map<string, { readonly workflowName: string; readonly workflowRef: string }>;
} {
  const resumePoint = meta.resumePoint;
  if (resumePoint === undefined || resumePoint.stack.length === 0) {
    throw new Error('Legacy attach requires a historical resume stack with workflow_ref evidence');
  }
  const refs = new Set<string>();
  const identities = new Set<string>();
  const invocationTargets = new Map<string, string>();
  restoreWorkflowCallInvocationEvidence(resumePoint).index.validateResumePoint(resumePoint);
  restoreWorkflowStepParticipationIndex(resumePoint);
  const refsByWorkflowName = new Map<string, string>();
  for (const entry of resumePoint.stack) {
    refs.add(entry.workflow_ref);
    const existing = refsByWorkflowName.get(entry.workflow);
    if (existing !== undefined && existing !== entry.workflow_ref) {
      throw new Error(`Legacy run has conflicting workflow_ref evidence for "${entry.workflow}"`);
    }
    refsByWorkflowName.set(entry.workflow, entry.workflow_ref);
  }
  Object.entries(resumePoint.workflow_call_invocations).forEach(([identity, invocation]) => {
    identities.add(identity);
    const parsed = parseWorkflowCallInvocationIdentity(identity);
    if (parsed === undefined) throw new Error(`Legacy run contains invalid workflow-call invocation identity: ${identity}`);
    collectIdentityRefs(parsed, refs);
    const namespace = parseWorkflowCallNamespaceSegment(invocation.report_namespace_segment);
    if (namespace === undefined) throw new Error(`Legacy run has invalid workflow-call namespace for "${identity}"`);
    invocationTargets.set(identity, namespace.workflowName);
  });
  Object.keys(resumePoint.workflow_step_participations).forEach((identity) => {
    identities.add(identity);
    const parsed = parseWorkflowExecutionIdentity(identity);
    if (parsed === undefined) throw new Error(`Legacy run contains invalid workflow execution identity: ${identity}`);
    collectIdentityRefs(parsed, refs);
  });
  const childByCall = new Map<string, { workflowName: string; workflowRef: string }>();
  for (const [identity, invocation] of Object.entries(resumePoint.workflow_call_invocations)) {
    const parent = parseWorkflowCallInvocationIdentity(identity);
    if (parent === undefined) throw new Error(`Legacy run contains invalid workflow-call invocation identity: ${identity}`);
    const namespace = parseWorkflowCallNamespaceSegment(invocation.report_namespace_segment);
    if (namespace === undefined) throw new Error(`Legacy run has invalid workflow-call namespace for "${identity}"`);
    const matchingChildRefs = new Set<string>();
    for (const participationIdentity of Object.keys(resumePoint.workflow_step_participations)) {
      const participation = parseWorkflowExecutionIdentity(participationIdentity)!;
      const call = participation.calls.at(-1);
      if (call?.workflow === parent.workflow && call.step === parent.step) {
        matchingChildRefs.add(participation.workflow);
      }
    }
    for (let index = 0; index < resumePoint.stack.length - 1; index += 1) {
      const call = resumePoint.stack[index]!;
      const child = resumePoint.stack[index + 1]!;
      if (call.kind === 'workflow_call' && call.workflow_ref === parent.workflow && call.step === parent.step) {
        matchingChildRefs.add(child.workflow_ref);
      }
    }
    if (matchingChildRefs.size !== 1) {
      throw new Error(`Legacy workflow call "${parent.workflow}/${parent.step}" does not have one explainable child ref`);
    }
    const key = canonicalJson({ parentWorkflowRef: parent.workflow, step: parent.step });
    const child = { workflowName: namespace.workflowName, workflowRef: [...matchingChildRefs][0]! };
    const existing = childByCall.get(key);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(child)) {
      throw new Error(`Legacy workflow call "${parent.workflow}/${parent.step}" has conflicting child evidence`);
    }
    childByCall.set(key, child);
  }
  return {
    refs,
    identities,
    invocationTargets,
    rootRef: resumePoint.stack[0]!.workflow_ref,
    childByCall,
  };
}

function collectBundleRefs(objects: ReadonlyMap<string, string>): Set<string> {
  const refs = new Set<string>();
  for (const encoded of objects.values()) {
    const parsed = JSON.parse(encoded) as { originalWorkflowRef?: unknown };
    if (typeof parsed.originalWorkflowRef !== 'string' || parsed.originalWorkflowRef.length === 0) {
      throw new Error('Prepared legacy bundle has an invalid original workflow ref');
    }
    refs.add(parsed.originalWorkflowRef);
  }
  return refs;
}

function validateFullResumeStack(
  prepared: ReturnType<typeof prepareWorkflowExecutionBundle>,
  resumePoint: NonNullable<NonNullable<ReturnType<typeof readRunMetaBySlug>>['resumePoint']>,
  identities: ReadonlySet<string>,
  invocationTargets: ReadonlyMap<string, string>,
): void {
  const validationRoot = mkdtempSync(join(tmpdir(), 'takt-legacy-bundle-validation-'));
  try {
    const validationPaths = buildRunPaths(validationRoot, 'validation-run');
    publishWorkflowExecutionBundle(validationPaths, prepared);
    const loaded = loadWorkflowExecutionBundle(validationPaths);
    const resolved = trimResumePointStackForWorkflow({
      workflow: loaded.rootWorkflow,
      resumePoint,
      resolveWorkflowCall: (parentWorkflow, step) => loaded.workflowCallResolver({
        parentWorkflow,
        step,
        projectCwd: validationRoot,
        lookupCwd: validationRoot,
      }),
    });
    if (resolved === undefined || canonicalJson(resolved.stack) !== canonicalJson(resumePoint.stack)) {
      throw new Error('Legacy resume stack cannot be preserved without trimming by the supplied source graph');
    }
    for (const identity of identities) {
      const parsed = invocationTargets.has(identity)
        ? parseWorkflowCallInvocationIdentity(identity)
        : parseWorkflowExecutionIdentity(identity);
      if (parsed === undefined) {
        throw new Error(`Historical identity is invalid: ${identity}`);
      }
      let currentWorkflow = loaded.rootWorkflow;
      let candidateSteps: readonly WorkflowStep[] = currentWorkflow.steps;
      for (const frame of parsed.calls) {
        if (getWorkflowReference(currentWorkflow) !== frame.workflow) {
          throw new Error(`Historical identity call path does not match supplied graph: ${identity}`);
        }
        const matches = candidateSteps.filter((step) => step.name === frame.step);
        if (matches.length !== 1 || getWorkflowResumeFrameKind(matches[0]!) !== frame.kind) {
          throw new Error(`Historical identity call step does not exist in supplied graph: ${identity}`);
        }
        const step = matches[0]!;
        if (isWorkflowCallStep(step)) {
          const child = loaded.workflowCallResolver({
            parentWorkflow: currentWorkflow,
            step,
            projectCwd: validationRoot,
            lookupCwd: validationRoot,
          });
          if (child === null) throw new Error(`Historical identity child is missing from supplied graph: ${identity}`);
          currentWorkflow = child;
          candidateSteps = child.steps;
        } else if (step.parallel !== undefined && getAllParallelSubSteps(step.parallel).length > 0) {
          candidateSteps = getAllParallelSubSteps(step.parallel);
        } else {
          throw new Error(`Historical identity call path terminates before its target: ${identity}`);
        }
      }
      const targetSteps = parsed.parallel_parent === undefined
        ? candidateSteps.filter((step) => step.name === parsed.step)
        : (() => {
            const parallelParents = currentWorkflow.steps.filter(
              (step) => step.name === parsed.parallel_parent,
            );
            if (parallelParents.length !== 1 || parallelParents[0]?.parallel === undefined) {
              throw new Error(`Historical identity parallel parent does not exist in supplied graph: ${identity}`);
            }
            return getAllParallelSubSteps(parallelParents[0].parallel)
              .filter((step) => step.name === parsed.step);
          })();
      if (getWorkflowReference(currentWorkflow) !== parsed.workflow || targetSteps.length !== 1) {
        throw new Error(`Historical identity target does not exist in supplied graph: ${identity}`);
      }
      const target = targetSteps[0]!;
      const expectedChildName = invocationTargets.get(identity);
      if (expectedChildName !== undefined) {
        if (!isWorkflowCallStep(target)) {
          throw new Error(`Historical invocation target is not a workflow_call: ${identity}`);
        }
        const child = loaded.workflowCallResolver({
          parentWorkflow: currentWorkflow,
          step: target,
          projectCwd: validationRoot,
          lookupCwd: validationRoot,
        });
        if (child === null || child.name !== expectedChildName) {
          throw new Error(`Historical invocation child does not match its namespace evidence: ${identity}`);
        }
      }
    }
  } finally {
    rmSync(validationRoot, { recursive: true, force: true });
  }
}

export function attachLegacyWorkflowExecutionBundle(
  options: AttachLegacyWorkflowExecutionBundleOptions,
): AttachLegacyWorkflowExecutionBundleResult {
  if (!isValidReportDirName(options.runSlug)) throw new Error(`Invalid legacy run slug: ${options.runSlug}`);
  const runPaths = buildRunPaths(options.projectDir, options.runSlug);
  const meta = readRunMetaBySlug(options.projectDir, options.runSlug);
  if (meta === null) throw new Error(`Legacy run "${options.runSlug}" does not exist or has invalid metadata`);
  if (existsSync(runPaths.workflowBundleAbs)) throw new Error(`Workflow execution bundle already exists for run "${options.runSlug}"`);
  const sourceRoot = realpathSync(options.sourceRoot);
  const rootWorkflowPath = requireRegularPathInside(
    sourceRoot,
    isAbsolute(options.rootWorkflow) ? options.rootWorkflow : join(sourceRoot, options.rootWorkflow),
    'Historical root workflow',
  );
  const historicalBuiltins = join(sourceRoot, 'builtins');
  if (!existsSync(historicalBuiltins) || !lstatSync(historicalBuiltins).isDirectory()) {
    throw new Error(`Historical source root is missing builtins: ${historicalBuiltins}`);
  }
  const evidence = collectHistoricalEvidence(meta);
  const identityBefore = {
    meta: hashFile(runPaths.metaAbs),
    operationJournal: hashFile(buildRunPaths(
      options.projectDir,
      meta.operationJournalRunSlug ?? options.runSlug,
    ).operationJournalAbs),
    operationJournalRunSlug: meta.operationJournalRunSlug,
    operationClaimToken: meta.operationClaimToken,
  };
  invalidateGlobalConfigCache();
  let prepared: ReturnType<typeof prepareWorkflowExecutionBundle>;
  try {
    prepared = withResourcesDirOverride(historicalBuiltins, () =>
      withGlobalConfigDirOverride(join(sourceRoot, '.takt-historical-global'), () => {
        invalidateGlobalConfigCache();
        const rootWorkflow = loadWorkflowByIdentifier(rootWorkflowPath, sourceRoot, { lookupCwd: sourceRoot });
        if (rootWorkflow === null) throw new Error(`Historical root workflow could not be loaded: ${rootWorkflowPath}`);
        if (rootWorkflow.name !== meta.workflow) {
          throw new Error(`Historical root workflow name "${rootWorkflow.name}" does not match run metadata "${meta.workflow}"`);
        }
        const computedRootRef = getWorkflowReference(rootWorkflow);
        const movedHistoricalRoot = computedRootRef !== evidence.rootRef;
        const historicalRefBySourceRef = new Map<string, string>([[computedRootRef, evidence.rootRef]]);
        const sourceRefByHistoricalRef = new Map<string, string>([[evidence.rootRef, computedRootRef]]);
        const bindHistoricalRef = (workflow: typeof rootWorkflow, historicalRef: string): string => {
          const sourceRef = getWorkflowReference(workflow);
          const existingHistorical = historicalRefBySourceRef.get(sourceRef);
          const existingSource = sourceRefByHistoricalRef.get(historicalRef);
          if ((existingHistorical !== undefined && existingHistorical !== historicalRef)
            || (existingSource !== undefined && existingSource !== sourceRef)) {
            throw new Error(
              `Historical workflow_ref "${historicalRef}" is ambiguous across supplied source graph entities`,
            );
          }
          historicalRefBySourceRef.set(sourceRef, historicalRef);
          sourceRefByHistoricalRef.set(historicalRef, sourceRef);
          return historicalRef;
        };
        const workflowRefResolver = (
          workflow: typeof rootWorkflow,
          context: undefined | { readonly parentWorkflowRef: string; readonly step: { readonly name: string } },
        ): string | undefined => {
          if (context !== undefined) {
            const exactChild = evidence.childByCall.get(canonicalJson({
              parentWorkflowRef: context.parentWorkflowRef,
              step: context.step.name,
            }));
            const namedChildren = [...evidence.childByCall.values()]
              .filter((candidate) => candidate.workflowName === workflow.name);
            const child = exactChild ?? (namedChildren.length === 1 ? namedChildren[0] : undefined);
            if (child !== undefined) {
              if (child.workflowName !== workflow.name) {
                throw new Error(
                  `Historical child workflow "${workflow.name}" does not match invocation evidence "${child.workflowName}"`,
                );
              }
              return bindHistoricalRef(workflow, child.workflowRef);
            }
          }
          if (movedHistoricalRoot) {
            throw new Error(
              `Historical source location differs from the original run and workflow_ref for "${workflow.name}" cannot be restored`,
            );
          }
          return undefined;
        };
        return prepareWorkflowExecutionBundle({
          rootWorkflow,
          workflowCallResolver: createWorkflowCallResolver(createWorkflowExecutionContext(rootWorkflow, sourceRoot)),
          projectCwd: sourceRoot,
          lookupCwd: sourceRoot,
          rootWorkflowRefOverride: evidence.rootRef,
          workflowRefResolver,
        });
      }));
  } finally {
    invalidateGlobalConfigCache();
  }
  const bundleRefs = collectBundleRefs(prepared.objects);
  for (const historicalRef of evidence.refs) {
    if (!bundleRefs.has(historicalRef)) {
      throw new Error(`Historical workflow_ref "${historicalRef}" is not explained by the supplied source graph`);
    }
  }
  validateFullResumeStack(
    prepared,
    meta.resumePoint!,
    evidence.identities,
    evidence.invocationTargets,
  );
  const identityAfterPreparation = {
    meta: hashFile(runPaths.metaAbs),
    operationJournal: hashFile(buildRunPaths(
      options.projectDir,
      meta.operationJournalRunSlug ?? options.runSlug,
    ).operationJournalAbs),
    operationJournalRunSlug: readRunMetaBySlug(options.projectDir, options.runSlug)?.operationJournalRunSlug,
    operationClaimToken: readRunMetaBySlug(options.projectDir, options.runSlug)?.operationClaimToken,
  };
  if (JSON.stringify(identityAfterPreparation) !== JSON.stringify(identityBefore)) {
    throw new Error('Legacy attach changed run lifecycle or operation identity');
  }
  if (options.dryRun !== true) publishWorkflowExecutionBundle(runPaths, prepared);
  return {
    runSlug: options.runSlug,
    workflowName: meta.workflow,
    rootWorkflowRef: evidence.rootRef,
    nodeCount: Object.keys(prepared.manifest.nodes).length,
    published: options.dryRun !== true,
  };
}
