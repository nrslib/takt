import { reportInputEntries } from '../../models/workflow-report-input.js';
import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import { getAllParallelSubSteps } from '../../models/types.js';
import type { WorkflowReportInput } from '../../models/workflow-types.js';
import { classifyReportRelativePath } from '../../models/reserved-report-names.js';
import type { WorkflowCallResolver } from '../types.js';
import { extractReportReferences } from '../instruction/report-reference.js';
import {
  createReviewReportDiscoveryContext,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { buildWorkflowCallInvocationIdentity } from '../workflow-call-invocation-index.js';
import { getResumePointWorkflowReference, getWorkflowReference } from '../workflow-reference.js';
import { buildRunPaths, buildRunPathsFromRunsDirectory } from './run-paths.js';
import {
  readResumeReportSnapshotManifest,
  type ResumeReportSnapshotConsumerEntry,
} from './resume-report-snapshot.js';
import { buildResumeReportConsumerKeyFromStack } from './resume-report-consumer.js';

interface BuildResumeReportSnapshotConsumerOptions {
  readonly cwd: string;
  readonly runsDirectory?: string;
  readonly projectCwd: string;
  readonly sourceRunSlug: string;
  readonly workflow: WorkflowConfig;
  readonly resumePoint: WorkflowResumePoint;
  readonly workflowCallResolver?: WorkflowCallResolver;
}

function declaredReportEntryNames(
  workflow: WorkflowConfig,
  declaration: WorkflowReportInput,
  options: BuildResumeReportSnapshotConsumerOptions,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
): readonly string[] {
  if (declaration.reports !== 'all') return declaration.reports;
  const source = workflow.steps.find((step) => step.name === declaration.fromStep);
  if (source === undefined) return [];
  const discovered = resolveWorkflowStepReportNamesWithDiagnostics(source, createReviewReportDiscoveryContext({
    step: source,
    workflow,
    workflowCallResolver: options.workflowCallResolver,
    projectCwd: options.projectCwd,
    lookupCwd: options.cwd,
    resumeStackPrefix,
    stepOutputNames: new Set(),
    restoredStepIterationNames: new Set(),
    workflowCallInvocations: {
      kind: 'exact',
      records: new Map(Object.entries(options.resumePoint.workflow_call_invocations)),
    },
    workflowStepParticipations: new Map(Object.entries(options.resumePoint.workflow_step_participations)),
    requireCompletedCalls: true,
  }));
  return discovered.failures.length === 0
    ? [...new Set(discovered.reportNames.map((name) => basename(name)))]
    : [];
}
function declaredReportNames(workflow: WorkflowConfig, declaration: WorkflowStep['inputReports'], options: BuildResumeReportSnapshotConsumerOptions, prefix: readonly WorkflowResumePointEntry[]): readonly string[] {
  return reportInputEntries(declaration).flatMap((entry) => declaredReportEntryNames(workflow, entry, options, prefix));
}


function findWorkflowStep(workflow: WorkflowConfig, name: string): WorkflowStep | undefined {
  for (const step of workflow.steps) {
    if (step.name === name) return step;
    const child = step.parallel === undefined
      ? undefined
      : getAllParallelSubSteps(step.parallel).find((candidate) => candidate.name === name);
    if (child !== undefined) return child;
  }
  return undefined;
}

function namespaceParents(directory: string): string[] {
  if (directory.length === 0) {
    return [''];
  }
  const components = directory.split('/');
  const parents: string[] = [];
  for (let length = components.length; length >= 0; length -= 2) {
    parents.push(components.slice(0, length).join('/'));
  }
  return parents;
}

function resolveReferencePath(
  reportsRoot: string,
  reportDirectories: readonly string[],
  reference: string,
): string | undefined {
  for (const reportDirectory of reportDirectories) {
    for (const directory of namespaceParents(reportDirectory)) {
      const candidate = directory.length === 0 ? reference : `${directory}/${reference}`;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(join(reportsRoot, ...candidate.split('/')));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          continue;
        }
        throw error;
      }
      if (stat.isFile() && !stat.isSymbolicLink()) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveResumeLocation(options: BuildResumeReportSnapshotConsumerOptions): {
  readonly activeStep: WorkflowConfig['steps'][number];
  readonly reportDirectory: string;
  readonly declaredNames: ReadonlySet<string>;
} | undefined {
  const stack = options.resumePoint.stack;
  const activeEntry = stack.at(-1);
  if (activeEntry === undefined) {
    return undefined;
  }
  let workflow = options.workflow;
  const namespace: string[] = [];
  const declaredNames = new Set<string>();
  for (let index = 0; index < stack.length - 1; index += 1) {
    const entry = stack[index]!;
    if (getResumePointWorkflowReference(entry) !== getWorkflowReference(workflow)) {
      return undefined;
    }
    const step = findWorkflowStep(workflow, entry.step);
    for (const name of declaredReportNames(workflow, step?.inputReports, options, stack.slice(0, index))) declaredNames.add(name);
    if (entry.kind !== 'workflow_call') {
      continue;
    }
    if (step?.kind !== 'workflow_call') {
      return undefined;
    }
    const identity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(workflow),
      step.name,
      stack.slice(0, index),
    );
    const invocation = options.resumePoint.workflow_call_invocations[identity];
    if (invocation === undefined) {
      return undefined;
    }
    namespace.push('subworkflows', invocation.report_namespace_segment);
    const child = options.workflowCallResolver?.({
      parentWorkflow: workflow,
      step,
      projectCwd: options.projectCwd,
      lookupCwd: options.cwd,
    });
    if (child === undefined || child === null) {
      return undefined;
    }
    workflow = child;
  }
  if (getResumePointWorkflowReference(activeEntry) !== getWorkflowReference(workflow)) {
    return undefined;
  }
  const activeStep = findWorkflowStep(workflow, activeEntry.step);
  for (const name of declaredReportNames(workflow, activeStep?.inputReports, options, stack.slice(0, -1))) declaredNames.add(name);
  return activeStep === undefined
    ? undefined
    : { activeStep, reportDirectory: namespace.join('/'), declaredNames };
}

export function buildResumeReportSnapshotConsumerEntry(
  options: BuildResumeReportSnapshotConsumerOptions,
): ResumeReportSnapshotConsumerEntry | undefined {
  const consumerKey = buildResumeReportConsumerKeyFromStack(options.resumePoint.stack);
  const location = resolveResumeLocation(options);
  if (consumerKey === undefined || location === undefined) {
    return undefined;
  }
  const inheritedConsumer = readResumeReportSnapshotManifest(options.cwd, options.sourceRunSlug, options.runsDirectory)
    ?.resumeReportConsumers
    ?.find((consumer) => consumer.consumerKey === consumerKey);
  const reportDirectories = [...new Set([
    location.reportDirectory,
    ...(inheritedConsumer?.reportDirectories ?? []),
  ])];
  const reportsRoot = (options.runsDirectory === undefined
    ? buildRunPaths(options.cwd, options.sourceRunSlug)
    : buildRunPathsFromRunsDirectory(options.runsDirectory, options.sourceRunSlug)).reportsRootAbs;
  const references = [...new Set(extractReportReferences(location.activeStep.instruction)
    .map((reference) => reference.trim()))]
    .flatMap((reference) => {
      const classification = classifyReportRelativePath(reference);
      if (classification.kind !== 'public') {
        return [];
      }
      if (location.declaredNames.has(classification.normalizedPath)) return [];
      const path = resolveReferencePath(reportsRoot, reportDirectories, classification.normalizedPath);
      return path === undefined ? [] : [{ reference: classification.normalizedPath, path }];
    });
  return { consumerKey, reportDirectories, references };
}
