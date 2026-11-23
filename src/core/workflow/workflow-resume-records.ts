import { getAllParallelSubSteps, type WorkflowConfig, type WorkflowResumePoint, type WorkflowResumePointEntry, type WorkflowStep } from '../models/types.js';
import type { WorkflowCallResolver } from './types.js';
import { createLogger } from '../../shared/utils/index.js';
import { parseWorkflowExecutionIdentity, serializeWorkflowExecutionIdentity } from './workflow-execution-identity-codec.js';
import { parseWorkflowCallNamespaceSegment } from './workflow-call-namespace.js';
import { buildWorkflowResumePointEntry, getWorkflowReference } from './workflow-reference.js';
import { getReportFiles } from './output-contract-files.js';
import { MAX_WORKFLOW_CALL_DEPTH } from './workflow-call-depth.js';
import { resolveReviewReportStepParticipation } from './review-report-participation.js';

const log = createLogger('workflow-resume-records');

export interface InheritedReportProducer {
  readonly identity: string;
  readonly savedIdentity: string;
  readonly reportName: string;
  readonly reportPath: string;
}

export interface ResumeRecordContext {
  readonly workflow: WorkflowConfig;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
}

function findStep(workflow: WorkflowConfig, name: string, parallelParent?: string): WorkflowStep | undefined {
  const steps = parallelParent === undefined ? workflow.steps
    : getAllParallelSubSteps(workflow.steps.find((step) => step.name === parallelParent)?.parallel ?? []);
  return steps.find((step) => step.name === name);
}

function resolveChild(context: ResumeRecordContext, workflow: WorkflowConfig, step: WorkflowStep): WorkflowConfig | undefined {
  if (step.kind !== 'workflow_call') return undefined;
  return context.workflowCallResolver?.({ parentWorkflow: workflow, step, projectCwd: context.projectCwd, lookupCwd: context.lookupCwd }) ?? undefined;
}

/** Saved hashes describe the source definition; names and call positions select its records. */
export function matchWorkflowResumeRecords(source: WorkflowResumePoint, context: ResumeRecordContext): {
  readonly point: WorkflowResumePoint;
  readonly inheritedReports: readonly InheritedReportProducer[];
} {
  if (source.stack[0]?.workflow !== context.workflow.name) {
    log.warn('Ignoring inherited workflow records from a different workflow name');
    return { point: { ...source, workflow_call_invocations: {}, workflow_step_participations: {} }, inheritedReports: [] };
  }
  const names = new Map(source.stack.map((entry) => [entry.workflow_ref, entry.workflow]));
  names.set(getWorkflowReference(context.workflow), context.workflow.name);
  const locate = (identity: string): { identity: string; workflow: WorkflowConfig; calls: WorkflowResumePointEntry[]; parallelParent?: string } | undefined => {
    const parsed = parseWorkflowExecutionIdentity(identity);
    if (parsed === undefined) return undefined;
    let workflow = context.workflow;
    let parallelParent: string | undefined;
    const calls: WorkflowResumePointEntry[] = [];
    for (const call of parsed.calls) {
      const knownName = names.get(call.workflow);
      if (knownName !== undefined && knownName !== workflow.name) return undefined;
      const step = findStep(workflow, call.step, parallelParent);
      if (step === undefined) return undefined;
      calls.push(buildWorkflowResumePointEntry(workflow, call.step, call.kind, call.instance, undefined,
        call.kind === 'workflow_call' ? call.instance : undefined));
      if (call.kind === 'workflow_call') {
        const child = resolveChild(context, workflow, step);
        if (child === undefined) return undefined;
        workflow = child;
        parallelParent = undefined;
      } else if (call.kind === 'parallel') parallelParent = call.step;
    }
    const knownName = names.get(parsed.workflow);
    if (knownName !== undefined && knownName !== workflow.name) return undefined;
    const scope = parsed.parallel_parent ?? parallelParent;
    let legacyParallelParent: string | undefined;
    if (findStep(workflow, parsed.step, scope) === undefined) {
      if (scope !== undefined) return undefined;
      const parents = workflow.steps.filter((step) => step.parallel !== undefined
        && getAllParallelSubSteps(step.parallel).some((child) => child.name === parsed.step && child.kind !== 'workflow_call'));
      if (parents.length !== 1) return undefined;
      legacyParallelParent = parents[0]!.name;
    }
    return {
      identity: serializeWorkflowExecutionIdentity({ ...parsed, workflow: getWorkflowReference(workflow), calls: calls.map((entry) => ({
        workflow: entry.workflow_ref, step: entry.step, kind: entry.kind, instance: entry.call_instance ?? entry.occurrence,
      })) }),
      workflow, calls, ...(legacyParallelParent === undefined ? {} : { parallelParent: legacyParallelParent }),
    };
  };
  function match<T>(records: Record<string, T>, equivalent: (left: T, right: T) => boolean): Map<string, { record: T; savedIdentity: string }> {
    const matched = new Map<string, { record: T; savedIdentity: string }>();
    const conflicts = new Set<string>();
    for (const [identity, record] of Object.entries(records)) {
      const target = locate(identity);
      if (target === undefined) {
        log.warn('Ignoring unmatched inherited workflow record', { identity });
        continue;
      }
      if (conflicts.has(target.identity)) continue;
      const existing = matched.get(target.identity);
      if (existing !== undefined && !equivalent(existing.record, record)) {
        log.warn('Ignoring conflicting inherited workflow records', { identity: target.identity });
        matched.delete(target.identity);
        conflicts.add(target.identity);
      } else if (existing === undefined) matched.set(target.identity, { record, savedIdentity: identity });
    }
    return matched;
  }
  const invocations = match(source.workflow_call_invocations, (left, right) =>
    left.call_instance === right.call_instance && left.completed === right.completed
      && left.report_namespace_segment === right.report_namespace_segment);
  const activeInvocations = new Map(source.stack.flatMap((entry, index) => {
    if (entry.kind !== 'workflow_call') return [];
    const identity = serializeWorkflowExecutionIdentity({ workflow: entry.workflow_ref, step: entry.step,
      calls: source.stack.slice(0, index).map((frame) => ({ workflow: frame.workflow_ref, step: frame.step,
        kind: frame.kind, instance: frame.call_instance ?? frame.occurrence })),
    });
    const target = locate(identity);
    return target === undefined ? [] : [[target.identity, entry.call_instance] as const];
  }));
  for (const [identity, { record }] of invocations) {
    const parsed = parseWorkflowExecutionIdentity(identity)!;
    const target = locate(identity)!;
    const step = findStep(target.workflow, parsed.step, target.calls.at(-1)?.kind === 'parallel' ? target.calls.at(-1)!.step : undefined);
    const child = step === undefined ? undefined : resolveChild(context, target.workflow, step);
    const namespace = parseWorkflowCallNamespaceSegment(record.report_namespace_segment);
    if (namespace?.stepName !== parsed.step || namespace.iteration !== record.call_instance || child === undefined || namespace.workflowName !== child.name
      || activeInvocations.has(identity) && activeInvocations.get(identity) !== record.call_instance) {
      log.warn('Ignoring unmatched inherited workflow invocation', { identity });
      invocations.delete(identity);
    }
  }
  const namespaces = new Map<string, string[]>();
  for (const [identity, { record }] of invocations) {
    const owners = namespaces.get(record.report_namespace_segment) ?? [];
    owners.push(identity);
    namespaces.set(record.report_namespace_segment, owners);
  }
  for (const [namespace, owners] of namespaces) {
    if (owners.length < 2) continue;
    log.warn('Ignoring inherited invocations with a conflicting report namespace', { namespace });
    for (const identity of owners) invocations.delete(identity);
  }
  const reportDirectory = (identity: string): string[] | undefined => {
    const parsed = parseWorkflowExecutionIdentity(identity)!;
    const directory: string[] = [];
    for (let index = 0; index < parsed.calls.length; index++) {
      const call = parsed.calls[index]!;
      if (call.kind !== 'workflow_call') continue;
      const owner = serializeWorkflowExecutionIdentity({ workflow: call.workflow, step: call.step, calls: parsed.calls.slice(0, index) });
      const invocation = invocations.get(owner)?.record;
      if (invocation === undefined || invocation.call_instance !== call.instance) return undefined;
      directory.push('subworkflows', invocation.report_namespace_segment);
    }
    return directory;
  };
  const orderedInvocations = [...invocations.keys()].sort((left, right) =>
    parseWorkflowExecutionIdentity(left)!.calls.length - parseWorkflowExecutionIdentity(right)!.calls.length);
  for (const identity of orderedInvocations) {
    if (reportDirectory(identity) !== undefined) continue;
    log.warn('Ignoring inherited invocation without a matching parent call', { identity });
    invocations.delete(identity);
  }
  const sameReports = (left: { report_names: readonly string[] }, right: { report_names: readonly string[] }): boolean => {
    const leftNames = new Set(left.report_names);
    const rightNames = new Set(right.report_names);
    return leftNames.size === rightNames.size && [...leftNames].every((name) => rightNames.has(name));
  };
  const participations = match(source.workflow_step_participations, sameReports);
  const producerIdentity = (identity: string): string => {
    const parallelParent = locate(identity)!.parallelParent;
    return parallelParent === undefined ? identity
      : serializeWorkflowExecutionIdentity({ ...parseWorkflowExecutionIdentity(identity)!, parallel_parent: parallelParent });
  };
  for (const identity of [...participations.keys()]) {
    const qualified = producerIdentity(identity);
    if (qualified === identity || !participations.has(qualified)) continue;
    if (!sameReports(participations.get(identity)!.record, participations.get(qualified)!.record)) {
      log.warn('Ignoring conflicting inherited parallel participation records', { identity: qualified });
      participations.delete(qualified);
    }
    participations.delete(identity);
  }
  const inheritedReports: InheritedReportProducer[] = [];
  for (const [identity, { record, savedIdentity }] of participations) {
    const directory = reportDirectory(identity);
    if (directory === undefined) {
      log.warn('Ignoring inherited participation without a matching parent call', { identity });
      participations.delete(identity);
      continue;
    }
    for (const reportName of record.report_names) inheritedReports.push({
      identity: producerIdentity(identity), savedIdentity, reportName, reportPath: [...directory, reportName].join('/'),
    });
  }
  let workflow = context.workflow;
  let parallelParent: string | undefined;
  const stack = source.stack.map((entry) => {
    if (entry.workflow === workflow.name && entry.workflow_ref !== getWorkflowReference(workflow)) {
      log.warn('Saved workflow reference differs from current workflow', { workflow: workflow.name, saved: entry.workflow_ref, current: getWorkflowReference(workflow) });
    }
    const current = { ...entry, workflow_ref: getWorkflowReference(workflow) };
    const step = findStep(workflow, entry.step, parallelParent);
    if (step !== undefined) workflow = resolveChild(context, workflow, step) ?? workflow;
    parallelParent = entry.kind === 'parallel' ? entry.step : undefined;
    return current;
  });
  return {
    point: { ...source, stack,
      workflow_call_invocations: Object.fromEntries([...invocations].map(([key, value]) => [key, { ...value.record }])),
      workflow_step_participations: Object.fromEntries([...participations].map(([key, value]) => [key, { report_names: [...value.record.report_names] }])),
    }, inheritedReports,
  };
}

export interface WorkflowReportProducer {
  readonly identity: string;
  readonly reportName: string;
}

export function collectWorkflowReportProducers(
  context: ResumeRecordContext,
  source: WorkflowStep,
  prefix: readonly WorkflowResumePointEntry[],
  invocations: WorkflowResumePoint['workflow_call_invocations'],
): readonly WorkflowReportProducer[] {
  const collect = (workflow: WorkflowConfig, step: WorkflowStep, calls: readonly WorkflowResumePointEntry[], parallelParent?: string): WorkflowReportProducer[] => {
    if (calls.length > MAX_WORKFLOW_CALL_DEPTH) return [];
    const identity = serializeWorkflowExecutionIdentity({ workflow: getWorkflowReference(workflow), step: step.name,
      calls: calls.map((entry) => ({ workflow: entry.workflow_ref, step: entry.step, kind: entry.kind, instance: entry.call_instance ?? entry.occurrence })),
      ...(parallelParent === undefined ? {} : { parallel_parent: parallelParent }),
    });
    const reports = getReportFiles(step.outputContracts).map((reportName) => ({ identity, reportName }));
    if (step.parallel !== undefined) reports.push(...getAllParallelSubSteps(step.parallel).flatMap((child) => collect(workflow, child, calls, step.name)));
    if (step.kind === 'workflow_call') {
      const child = resolveChild(context, workflow, step);
      const participation = resolveReviewReportStepParticipation(step, workflow, calls, {
        activeWorkflowReference: getWorkflowReference(workflow), stepOutputNames: new Set(), restoredStepIterationNames: new Set(),
        workflowCallInvocations: { kind: 'exact', records: new Map(Object.entries(invocations)) },
        workflowStepParticipations: new Map(), dynamicParallelSelections: new Map(),
      }, parallelParent);
      const call = participation.kind === 'participated' ? participation.workflowCallReport : undefined;
      if (child !== undefined && call?.invocation.completed === true) {
        const instance = call.invocation.call_instance;
        const next = [...call.resumeStackPrefix, buildWorkflowResumePointEntry(workflow, step.name, 'workflow_call', instance, undefined, instance)];
        reports.push(...child.steps.flatMap((childStep) => collect(child, childStep, next)));
      }
    }
    return reports;
  };
  return collect(context.workflow, source, prefix);
}
