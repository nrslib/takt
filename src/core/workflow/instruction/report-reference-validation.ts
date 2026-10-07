import type { WorkflowConfig, WorkflowStep } from '../../models/types.js';
import { getAllParallelSubSteps } from '../../models/types.js';
import { classifyReportRelativePath, reportPathRejectionMessage } from '../../models/reserved-report-names.js';
import { COMPLETE_STEP, ABORT_STEP } from '../constants.js';
import type { WorkflowCallResolver } from '../types.js';
import { extractReportReferences } from './report-reference.js';
import { findReportInScopes } from './report-reference-scope.js';
import { getAttachedWorkflowBundleNodeId, getWorkflowSourcePath } from '../../../shared/workflowConfigMetadata.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { createLogger } from '../../../shared/utils/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { loopJudgeStepName } from '../loop-judge-step.js';
import type { ReportReferenceConsumer } from './prepared-instruction.js';

const log = createLogger('report-reference-validation');

export interface ReportReferenceDiagnostic {
  readonly level: 'error' | 'warning';
  readonly message: string;
  readonly runtimeCheck?: {
    readonly consumer: ReportReferenceConsumer;
    readonly reference: string;
    readonly message: string;
  };
}

interface ReportReferenceValidationContext {
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly callerCandidates?: readonly WorkflowConfig[];
}

function workflowIdentity(workflow: WorkflowConfig): string {
  return getAttachedWorkflowBundleNodeId(workflow) ?? getWorkflowSourcePath(workflow) ?? workflow.name;
}

/** Forward routing edges: step name -> step names it can transition to. */
function buildRoutingEdges(workflow: WorkflowConfig, stepNames: Set<string>): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (to === COMPLETE_STEP || to === ABORT_STEP || !stepNames.has(to)) {
      return;
    }
    const targets = edges.get(from) ?? new Set<string>();
    targets.add(to);
    edges.set(from, targets);
  };
  for (const step of workflow.steps) {
    for (const rule of step.rules ?? []) {
      if (rule.next !== undefined) {
        addEdge(step.name, rule.next);
      }
    }
  }
  for (const monitor of workflow.loopMonitors ?? []) {
    // judge は cycle が threshold 回完走した後にしか発火しない。cycle の
    // 途中ステップからエッジを張ると「cycle 後半の producer を通らない偽の
    // 早期経路」が生まれ dominator 判定が偽陽性になる（boundary requirement）。
    // cycle 最後のステップからのみ張る — 最後のステップの AVAIL には
    // cycle 前半の成果物が通常の rules エッジ経由で伝播している。
    const lastCycleStep = monitor.cycle[monitor.cycle.length - 1];
    if (lastCycleStep === undefined) {
      continue;
    }
    for (const rule of monitor.judge.rules) {
      addEdge(lastCycleStep, rule.next);
    }
  }
  return edges;
}

function collectContractReportNames(step: WorkflowStep, into: Set<string>, guaranteedOnly: boolean): void {
  for (const contract of step.outputContracts ?? []) {
    into.add(contract.name);
  }
  const parallel = step.parallel;
  if (parallel === undefined) return;
  let participants: readonly WorkflowStep[];
  if (!guaranteedOnly || Array.isArray(parallel)) {
    participants = getAllParallelSubSteps(parallel);
  } else if (parallel.fixed.length > 0) {
    participants = parallel.fixed;
  } else {
    // 空の実効参加者は実行時に拒否されるため、単独 pool は必ず選ばれる。
    participants = parallel.pool.length === 1 ? parallel.pool : [];
  }
  for (const subStep of participants) {
    collectContractReportNames(subStep, into, guaranteedOnly);
  }
}

function intersectGuaranteedReports(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((name) => b.has(name)));
}

function reportSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const name of a) {
    if (!b.has(name)) {
      return false;
    }
  }
  return true;
}

function computeGuaranteedReportsByStep(
  initialStep: string,
  edges: Map<string, Set<string>>,
  producedByStep: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const available = new Map<string, Set<string>>([[initialStep, new Set<string>()]]);
  const queue = [initialStep];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const availableHere = available.get(current) ?? new Set<string>();
    const availableAfter = new Set([...availableHere, ...(producedByStep.get(current) ?? [])]);
    for (const next of edges.get(current) ?? []) {
      const known = available.get(next);
      if (known === undefined) {
        available.set(next, new Set(availableAfter));
        queue.push(next);
        continue;
      }
      const merged = intersectGuaranteedReports(known, availableAfter);
      if (!reportSetsEqual(merged, known)) {
        available.set(next, merged);
        queue.push(next);
      }
    }
  }
  return available;
}

interface ReportAvailability {
  readonly produced: Map<string, Set<string>>;
  readonly guaranteed: Map<string, Set<string>>;
  readonly allProduced: Set<string>;
  readonly optionalProduced: Map<string, Set<string>>;
  readonly optionalBefore: Map<string, Set<string>>;
}

function computePossibleReportsByStep(
  initialStep: string,
  edges: Map<string, Set<string>>,
  produced: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const available = new Map<string, Set<string>>([[initialStep, new Set()]]);
  const queue = [initialStep];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const after = new Set([...available.get(current)!, ...(produced.get(current) ?? [])]);
    for (const next of edges.get(current) ?? []) {
      const known = available.get(next);
      const merged = new Set([...(known ?? []), ...after]);
      if (known === undefined || !reportSetsEqual(known, merged)) {
        available.set(next, merged);
        queue.push(next);
      }
    }
  }
  return available;
}

function analyzeAvailability(workflow: WorkflowConfig): ReportAvailability {
  const produced = new Map<string, Set<string>>();
  const allProduced = new Set<string>();
  const optionalProduced = new Map<string, Set<string>>();
  for (const step of workflow.steps) {
    const names = new Set<string>();
    collectContractReportNames(step, names, true);
    collectContractReportNames(step, allProduced, false);
    const possible = new Set<string>();
    collectContractReportNames(step, possible, false);
    optionalProduced.set(step.name, new Set([...possible].filter((name) => !names.has(name))));
    produced.set(step.name, names);
  }
  const edges = buildRoutingEdges(workflow, new Set(workflow.steps.map((step) => step.name)));
  return {
    produced,
    guaranteed: computeGuaranteedReportsByStep(workflow.initialStep, edges, produced),
    allProduced,
    optionalProduced,
    optionalBefore: computePossibleReportsByStep(workflow.initialStep, edges, optionalProduced),
  };
}

interface WorkflowNode {
  readonly workflow: WorkflowConfig;
  readonly availability: ReportAvailability;
  readonly calls: CallEdge[];
  readonly parents: Set<WorkflowNode>;
}

interface CallEdge {
  readonly name: string;
  readonly stepPath: readonly string[];
  readonly reportsBeforeCall: ReadonlySet<string>;
  readonly optionalBeforeCall: ReadonlySet<string>;
  readonly child: WorkflowNode;
}

interface AncestorReportScope {
  readonly guaranteed: ReadonlySet<string>;
  readonly allProduced: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
}

function validateReferences(
  diagnostics: ReportReferenceDiagnostic[],
  node: WorkflowNode,
  ancestors: readonly AncestorReportScope[],
  path: readonly string[],
  callPath: ReportReferenceConsumer['callPath'],
): void {
  const { workflow, availability } = node;
  const validateInstruction = (
    instruction: string | undefined,
    location: string,
    current: ReadonlySet<string>,
    optional: ReadonlySet<string>,
    consumerStepPath: readonly string[] | undefined,
  ): void => {
    for (const raw of new Set(extractReportReferences(instruction))) {
      const reference = raw.trim();
      const classification = classifyReportRelativePath(reference);
      const context = path.length === 0 ? '' : ` (call path: ${path.join(' -> ')})`;
      if (classification.kind !== 'public') {
        diagnostics.push({
          level: 'error',
          message: `${location} references an invalid report: ${reportPathRejectionMessage(reference)}.${context}`,
        });
        continue;
      }
      const name = classification.normalizedPath;
      const producer = findReportInScopes(
        () => current.has(name) ? current : undefined,
        () => undefined,
        ancestors.map((scope) => () => scope.guaranteed.has(name) ? scope.guaranteed : undefined),
      );
      if (producer !== undefined) continue;
      const detail = availability.allProduced.has(name) || ancestors.some((scope) => scope.allProduced.has(name))
        ? 'the workflow can reach that step before any step producing the report has run.'
        : 'no step\'s output_contracts produce that report.';
      diagnostics.push({
        level: 'warning',
        ...(consumerStepPath !== undefined && (optional.has(name) || ancestors.some((scope) => scope.optional.has(name))) ? {
          runtimeCheck: {
            reference: name,
            message: `${location} references {report:${name}} but the report is missing in this run.${context}`,
            consumer: { workflowRef: getWorkflowReference(workflow), callPath, stepPath: consumerStepPath },
          },
        } : {}),
        message: `${location} references {report:${name}} but ${detail} `
          + 'At runtime, a missing {report:} reference is replaced with an explicit missing-report sentence. '
          + 'Point the reference at a report produced by an earlier step, or move/rename the output contract.'
          + context,
      });
    }
  };
  const validateStep = (step: WorkflowStep, current: ReadonlySet<string>, optional: ReadonlySet<string>, stepPath: readonly string[]): void => {
    const resolvesInstruction = (step.kind === undefined || step.kind === 'agent')
      && step.parallel === undefined && step.arpeggio === undefined;
    validateInstruction(step.instruction, `step "${step.name}"`, current, optional, resolvesInstruction ? stepPath : undefined);
    for (const subStep of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) {
      validateStep(subStep, current, optional, [...stepPath, subStep.name]);
    }
  };
  for (const step of workflow.steps) {
    const current = availability.guaranteed.get(step.name);
    if (current !== undefined) validateStep(step, current, availability.optionalBefore.get(step.name)!, [step.name]);
  }
  for (const monitor of workflow.loopMonitors ?? []) {
    const cycleSteps = monitor.cycle.filter((name) => availability.guaranteed.has(name));
    if (cycleSteps.length === 0) continue;
    const current = new Set(cycleSteps.flatMap((name) => [
      ...availability.guaranteed.get(name)!,
      ...(availability.produced.get(name) ?? []),
    ]));
    validateInstruction(
      monitor.judge.instruction,
      `loop monitor judge for cycle [${monitor.cycle.join(' -> ')}]`,
      current,
      new Set(cycleSteps.flatMap((name) => [
        ...availability.optionalBefore.get(name)!,
        ...(availability.optionalProduced.get(name) ?? []),
      ])),
      [loopJudgeStepName(monitor.cycle)],
    );
  }
}

export function validateWorkflowReportReferences(
  workflow: WorkflowConfig,
  workflowCallResolver: WorkflowCallResolver,
  context: ReportReferenceValidationContext,
): ReportReferenceDiagnostic[] {
  const diagnostics: ReportReferenceDiagnostic[] = [];
  const targetSource = workflowIdentity(workflow);
  const nodes = new Map<string, WorkflowNode>();
  const expand = (config: WorkflowConfig, strict: boolean, invocation: string): WorkflowNode => {
    const key = getAttachedWorkflowBundleNodeId(config)
      ?? canonicalJson({ source: workflowIdentity(config), invocation });
    const known = nodes.get(key);
    if (known !== undefined) return known;
    const node: WorkflowNode = {
      workflow: config, availability: analyzeAvailability(config), calls: [], parents: new Set(),
    };
    nodes.set(key, node);
    const collectCalls = (step: WorkflowStep, current: ReadonlySet<string>, optional: ReadonlySet<string>, stepPath: readonly string[]): void => {
      if (step.kind === 'workflow_call') {
        const resolveCall = (): void => {
          const child = workflowCallResolver({ parentWorkflow: config, step, projectCwd: context.projectCwd, lookupCwd: context.lookupCwd });
          // Missing targets establish no producer; their diagnostics belong to the caller validation.
          if (child === null) return;
          const childNode = expand(child, strict, canonicalJson(step.args ?? {}));
          node.calls.push({ name: step.name, stepPath, reportsBeforeCall: current, optionalBeforeCall: optional, child: childNode });
          childNode.parents.add(node);
        };
        if (strict) {
          resolveCall();
        } else {
          // Discovery failures cannot establish an ancestor or a producer.
          try {
            resolveCall();
          } catch (error) {
            log.debug('Cannot resolve potential report-reference caller', {
              workflow: config.name, step: step.name, error: getErrorMessage(error),
            });
          }
        }
      }
      for (const subStep of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) {
        collectCalls(subStep, current, optional, [...stepPath, subStep.name]);
      }
    };
    for (const step of config.steps) {
      const current = node.availability.guaranteed.get(step.name);
      if (current !== undefined) collectCalls(step, current, node.availability.optionalBefore.get(step.name)!, [step.name]);
    }
    return node;
  };
  const selected = expand(workflow, true, 'discovery');
  if (context.callerCandidates !== undefined) {
    for (const candidate of context.callerCandidates) expand(candidate, false, 'discovery');
  }
  const matches = [...nodes.values()].filter((node) => workflowIdentity(node.workflow) === targetSource);
  const calledMatches = matches.filter((node) => node.parents.size > 0);
  const relevant = new Set<WorkflowNode>();
  const includeAncestors = (node: WorkflowNode): void => {
    if (relevant.has(node)) return;
    relevant.add(node);
    for (const parent of node.parents) includeAncestors(parent);
  };
  for (const node of calledMatches.length > 0 ? calledMatches : [selected]) includeAncestors(node);
  const calledSources = new Set([...nodes.values()]
    .filter((node) => node.parents.size > 0)
    .map((node) => workflowIdentity(node.workflow)));
  const roots = context.callerCandidates === undefined ? [selected] : [...relevant].filter((node) => {
    if ([...node.parents].some((parent) => relevant.has(parent))) return false;
    // A callable discovery definition is not an invocation when its callers are known.
    return node.workflow.subworkflow?.callable !== true
      || !calledSources.has(workflowIdentity(node.workflow));
  });
  const visit = (
    node: WorkflowNode,
    ancestors: readonly AncestorReportScope[],
    path: readonly string[],
    callPath: ReportReferenceConsumer['callPath'],
    consumingTarget: boolean,
    active: ReadonlySet<WorkflowNode>,
  ): void => {
    if (active.has(node)) throw new Error(`Configuration error: recursive workflow_call cycle detected at workflow "${node.workflow.name}"`);
    const selectedHere = consumingTarget || workflowIdentity(node.workflow) === targetSource;
    if (selectedHere) validateReferences(diagnostics, node, ancestors, path, callPath);
    const nextActive = new Set([...active, node]);
    for (const call of node.calls) {
      if (!selectedHere && !relevant.has(call.child)) continue;
      visit(
        call.child,
        [{ guaranteed: call.reportsBeforeCall, allProduced: node.availability.allProduced, optional: call.optionalBeforeCall }, ...ancestors],
        [...path, `${node.workflow.name}:${call.name}`],
        [...callPath, ...call.stepPath.map((step) => ({ workflowRef: getWorkflowReference(node.workflow), step }))],
        selectedHere,
        nextActive,
      );
    }
  };
  if (roots.length === 0) throw new Error('Configuration error: recursive workflow_call caller graph has no root');
  for (const root of roots) visit(root, [], [], [], false, new Set());
  return diagnostics;
}
