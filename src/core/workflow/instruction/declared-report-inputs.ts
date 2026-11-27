import { reportInputEntries } from '../../models/workflow-report-input.js';
import type { WorkflowReportInput } from '../../models/workflow-types.js';
import { reportInputNames } from '../report-input-contract.js';
import { buildWorkflowStepParticipationIdentity } from '../workflow-step-participation-index.js';
import { basename } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import type { WorkflowCallResolver, WorkflowSharedRuntimeState } from '../types.js';
import {
  createReviewReportDiscoveryContext,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { snapshotWorkflowCallInvocationEvidence } from '../workflow-call-invocation-index.js';
import { buildWorkflowStackStepIterationIdentity } from '../step-iteration-identity.js';
import { parseWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { resolveReportReferenceDetailed } from './report-reference.js';
import type { DeclaredReportInputs } from './prepared-instruction.js';
import { CURRENT_REPORT_BODY_LIMIT } from './prepared-instruction.js';
import { pinReportContent } from '../report-writer.js';
import { collectWorkflowReportProducers } from '../workflow-resume-records.js';
import { parseWorkflowExecutionIdentity, serializeWorkflowExecutionIdentity } from '../workflow-execution-identity-codec.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('declared-report-inputs');

export interface DeclaredReportInputContext {
  readonly workflow: WorkflowConfig;
  readonly state: WorkflowState;
  readonly sharedRuntime: WorkflowSharedRuntimeState;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly reportDir: string;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
}

function logicalProducer(sourceName: string, reportPath: string): string {
  const parts = reportPath.split('/');
  const steps = [sourceName];
  let isFirstCallFrame = true;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] !== 'subworkflows') continue;
    const callStep = parseWorkflowCallNamespaceSegment(parts[index + 1]!)?.stepName;
    if (callStep === undefined) throw new Error(`Report input "${reportPath}" has an invalid producer identity`);
    if (!isFirstCallFrame || callStep !== sourceName) steps.push(callStep);
    isFirstCallFrame = false;
    index += 1;
  }
  return steps.join(' / ');
}

function hasSourceExecutionEvidence(source: WorkflowStep, context: DeclaredReportInputContext): boolean {
  const invocationEvidence = context.sharedRuntime.workflowCallInvocationEvidence;
  const participationIndex = context.sharedRuntime.workflowStepParticipationIndex;
  if (invocationEvidence === undefined || participationIndex === undefined) {
    throw new Error(`Report input evidence is unavailable for "${source.name}"`);
  }
  const sourceOccurrence = context.state.stepIterations.get(
    buildWorkflowStackStepIterationIdentity(
      context.workflow,
      source.name,
      context.resumeStackPrefix,
    ),
  );
  return sourceOccurrence !== undefined
    || context.state.stepOutputs.has(source.name)
    || context.state.restoredStepIterationNames.has(source.name)
    || source.kind === 'workflow_call' && invocationEvidence.index.get(
      context.workflow,
      source.name,
      context.resumeStackPrefix,
    ) !== undefined;
}

/** Resolve only the declared producer's completed execution and contracted reports. */
function resolveReportInputEntry(
  consumer: Pick<WorkflowStep, 'name' | 'inputReports'>,
  context: DeclaredReportInputContext,
  declaration: WorkflowReportInput,
  names: readonly string[],
): DeclaredReportInputs {
  const primary = context.workflow.steps.find((step) => step.name === declaration.fromStep);
  const source = primary !== undefined && declaration.fallbackFromStep !== undefined && !hasSourceExecutionEvidence(primary, context)
    ? context.workflow.steps.find((step) => step.name === declaration.fallbackFromStep)
    : primary;
  if (source === undefined) {
    throw new Error(`Report input source "${declaration.fromStep}" is not a step in this workflow`);
  }
  const invocationEvidence = context.sharedRuntime.workflowCallInvocationEvidence;
  const participationIndex = context.sharedRuntime.workflowStepParticipationIndex;
  if (invocationEvidence === undefined || participationIndex === undefined) {
    throw new Error(`Report input evidence is unavailable for "${declaration.fromStep}"`);
  }
  if (declaration.previousOnly === true) {
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(context.workflow), source.name, context.resumeStackPrefix);
    const store = context.sharedRuntime.reportExecutions;
    const completed = store?.executions(identity).filter((execution) => execution.completed).at(-1);
    let selectedExecution: string | undefined;
    const reports = names.map((report) => {
      const matching = Object.entries(completed?.reports ?? {})
        .filter(([name, version]) => basename(name) === report && version !== null)
        .map(([name]) => name);
      if (matching.length > 1) throw new Error(`Previous report input "${report}" from "${source.name}" is ambiguous`);
      const reportName = matching[0] ?? report;
      const fixed = completed === undefined ? undefined : store?.current(identity, reportName);
      if (fixed !== undefined) {
        if (completed !== undefined && !fixed.execution.id.endsWith(`/${completed.id}`)) {
          throw new Error(`Previous report inputs from "${source.name}" changed execution during resolution`);
        }
        if (selectedExecution !== undefined && fixed.execution.id !== selectedExecution) {
          throw new Error(`Previous report inputs from "${source.name}" changed execution during resolution`);
        }
        selectedExecution = fixed.execution.id;
      }
      return {
        reference: report,
        scope: 'declared-producer' as const,
        producer: source.name,
        content: fixed === undefined
          ? 'Previous completed report: 0 / 1; report=not supplied'
          : `Previous completed report: 1 / 1; execution=${fixed.execution.id}; path=\`${fixed.path}\`\n\n${fixed.content}`,
        ...(fixed === undefined ? {} : { path: fixed.path, execution: fixed.execution, origin: fixed.origin }),
        ...(declaration.history === undefined ? {} : { history: store?.history(identity, reportName, declaration.history.previous)
          ?? `History: 0 / ${declaration.history.previous} completed previous executions; execution history unavailable` }),
      };
    });
    return { declaredNames: names, reports };
  }
  if (declaration.optionalIfUnrun === true && !hasSourceExecutionEvidence(source, context)) {
    return {
      declaredNames: names,
      reports: [],
      unavailable: [{ producer: source.name, names }],
    };
  }
  const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(context.workflow), source.name, context.resumeStackPrefix);
  const store = context.sharedRuntime.reportExecutions;
  const invocation = source.kind === 'workflow_call'
    ? invocationEvidence.index.get(context.workflow, source.name, context.resumeStackPrefix) : undefined;
  if (source.kind === 'workflow_call'
    && invocation?.completed !== true) {
    if (store?.isInheritedProducer(identity)) {
      log.warn('Ignoring incomplete inherited workflow call report input', { step: source.name });
      return { declaredNames: names, reports: [] };
    }
    if (invocation !== undefined) throw new Error(`Report input from "${declaration.fromStep}" is incomplete: workflow_call_input_not_completed:${source.name}`);
  }
  const producers = store === undefined ? [] : collectWorkflowReportProducers(context, source, context.resumeStackPrefix,
    invocationEvidence.index.serialized());
  const inheritedNames = new Set(names.filter((name) => {
    const owners = producers.filter((producer) => basename(producer.reportName) === name);
    return owners.length === 0 ? store?.isInheritedProducer(identity) === true
      : owners.every((producer) => store?.isInheritedProducer(producer.identity) === true);
  }));
  const participations = new Set(participationIndex.snapshot().keys());
  // Resume matching already limits unqualified records to a unique parallel scope.
  for (const producer of producers) {
    const { parallel_parent: parallelParent, ...unqualified } = parseWorkflowExecutionIdentity(producer.identity)!;
    if (parallelParent !== undefined && participations.has(serializeWorkflowExecutionIdentity(unqualified))) {
      participations.add(producer.identity);
    }
  }
  const inheritedReports = [...inheritedNames].flatMap((name) => {
    const candidates = producers.filter((producer) => basename(producer.reportName) === name
      && participations.has(producer.identity));
    if (candidates.length !== 1) {
      log.warn(candidates.length === 0 ? 'Ignoring missing inherited report input' : 'Ignoring ambiguous inherited report input',
        { step: source.name, report: name, count: candidates.length });
      return [];
    }
    const candidate = candidates[0]!;
    const report = store!.readInherited(candidate.identity, candidate.reportName, declaration.history?.previous);
    if (report === undefined) {
      log.warn('Ignoring missing inherited report input', { step: source.name, report: name });
      return [];
    }
    return [{ ...report, reference: name, scope: 'declared-producer' as const, producer: source.name }];
  });
  if (inheritedNames.size === names.length && names.length > 0) return { declaredNames: names, reports: inheritedReports };
  const result = resolveWorkflowStepReportNamesWithDiagnostics(source, createReviewReportDiscoveryContext({
    reportExecutions: store,
    step: source,
    workflow: context.workflow,
    workflowCallResolver: context.workflowCallResolver,
    projectCwd: context.projectCwd,
    lookupCwd: context.lookupCwd,
    resumeStackPrefix: context.resumeStackPrefix,
    stepOutputNames: new Set(context.state.stepOutputs.keys()),
    restoredStepIterationNames: context.state.restoredStepIterationNames,
    workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(invocationEvidence),
    workflowStepParticipations: participationIndex.snapshot(),
    dynamicParallelSelections: context.state.dynamicParallelSelections,
    requireCompletedCalls: true,
  }));
  if (result.failures.length > 0) {
    throw new Error(`Report input from "${source.name}" is incomplete: ${result.failures.map((failure) => failure.reason).join('; ')}`);
  }
  const selected = declaration.reports === 'all'
    ? result.reportNames.filter((report) => !inheritedNames.has(basename(report)))
    : declaration.reports.filter((report) => !inheritedNames.has(basename(report))).map((report) => {
        const matches = result.reportNames.filter((name) => basename(name) === report);
        if (matches.length !== 1) {
          throw new Error(`Report input "${report}" from "${source.name}" has ${matches.length} matching completed reports`);
        }
        return matches[0]!;
      });
  if (selected.length === 0) {
    throw new Error(`Report input from "${source.name}" has no completed reports`);
  }
  let selectedExecution: string | undefined;
  const reports = selected.map((report) => {
    const fixed = store?.current(identity, report);
    if (fixed !== undefined) {
      if (selectedExecution !== undefined && fixed.execution.id !== selectedExecution) {
        throw new Error(`Report inputs from "${source.name}" changed execution during resolution`);
      }
      selectedExecution = fixed.execution.id;
    }
    const resolved = fixed === undefined ? resolveReportReferenceDetailed(context.reportDir, report, {
      stepName: consumer.name,
      reportsRootDir: context.reportDir,
    }) : undefined;
    if (resolved?.scope === 'missing') {
      throw new Error(`Report input "${report}" from "${source.name}" is missing`);
    }
    const content = fixed?.content ?? resolved!.content;
    const path = fixed?.path ?? (content.length > CURRENT_REPORT_BODY_LIMIT
      ? pinReportContent(context.reportDir, basename(report), content) : undefined);
    return {
      reference: basename(report),
      scope: 'declared-producer' as const,
      content,
      ...(fixed === undefined ? { legacyPublicBody: true as const } : {}),
      ...(fixed === undefined ? {} : { execution: fixed.execution, origin: fixed.origin }),
      ...(path === undefined ? {} : { path }),
      ...(declaration.history === undefined ? {} : { history: store?.history(identity, report, declaration.history.previous)
        ?? `History: 0 / ${declaration.history.previous} completed previous executions; execution history unavailable` }),
      producer: logicalProducer(source.name, report),
    };
  });
  const availableReports = [...inheritedReports, ...reports];
  return {
    declaredNames: [...inheritedNames, ...reports.map(({ reference }) => reference)],
    reports: availableReports,
  };
}

export function resolveDeclaredReportInputs(
  consumer: Pick<WorkflowStep, 'name' | 'inputReports'>,
  context: DeclaredReportInputContext,
): DeclaredReportInputs | undefined {
  if (consumer.inputReports === undefined) return undefined;
  const names = reportInputNames(context.workflow, consumer, context, (declaration) => {
    if (declaration.optionalIfUnrun !== true || declaration.reports === 'all') return false;
    const source = context.workflow.steps.find((step) => step.name === declaration.fromStep);
    return source?.kind === 'workflow_call' && !hasSourceExecutionEvidence(source, context);
  });
  const inputs = reportInputEntries(consumer.inputReports).map((entry, index) =>
    resolveReportInputEntry(consumer, context, entry, names[index]!));
  const unavailable = inputs.flatMap((input) => input.unavailable ?? []);
  return {
    declaredNames: inputs.flatMap((input) => input.declaredNames),
    reports: inputs.flatMap((input) => input.reports),
    ...(unavailable.length === 0 ? {} : { unavailable }),
  };
}
