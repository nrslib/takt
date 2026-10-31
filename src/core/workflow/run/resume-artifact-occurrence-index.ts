import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import {
  parseWorkflowCallInvocationIdentity,
  serializeWorkflowExecutionIdentity,
} from '../workflow-execution-identity-codec.js';
import type { ResumeReportSnapshotManifest } from './resume-report-snapshot.js';
import { parseWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';
import { getWorkflowReference } from '../workflow-reference.js';

function logicalCallSiteKey(
  workflow: string,
  stepName: string,
  workflowCallPath: readonly { workflow: string; step: string; kind: WorkflowResumePointEntry['kind'] }[],
): string {
  return JSON.stringify({
    workflow,
    step: stepName,
    calls: workflowCallPath.map((entry) => ({
      workflow: entry.workflow,
      step: entry.step,
      kind: entry.kind,
    })),
  });
}

function invocationCallSiteKeys(
  identity: string,
  workflowNamesByReference: ReadonlyMap<string, string>,
): { reference: string; workflowName: string } | undefined {
  const parsed = parseWorkflowCallInvocationIdentity(identity);
  if (parsed === undefined) return undefined;
  const workflowName = (reference: string) => workflowNamesByReference.get(reference) ?? reference;
  return {
    reference: logicalCallSiteKey(parsed.workflow, parsed.step, parsed.calls),
    workflowName: logicalCallSiteKey(
      workflowName(parsed.workflow),
      parsed.step,
      parsed.calls.map((call) => ({ ...call, workflow: workflowName(call.workflow) })),
    ),
  };
}

function namespaceSignature(stepName: string, workflowName: string, siteDigest?: string): string {
  return JSON.stringify([stepName, workflowName, siteDigest]);
}

function legacyNamespaceSignature(stepName: string, workflowName: string): string {
  return JSON.stringify([stepName, workflowName]);
}

export class ResumeArtifactOccurrenceIndex {
  readonly #maxByCallSite = new Map<string, number>();
  readonly #maxByWorkflowNameCallSite = new Map<string, number>();
  readonly #artifactNamespacePaths = new Set<string>();

  constructor(
    manifest: ResumeReportSnapshotManifest | undefined,
    sourceResumePoint: WorkflowResumePoint | undefined,
  ) {
    const workflowNamesByReference = new Map(
      sourceResumePoint?.stack.map((entry) => [entry.workflow_ref, entry.workflow]),
    );
    const invocations = sourceResumePoint?.workflow_call_invocations ?? {};
    for (const identity of Object.keys(invocations)) {
      const parsed = parseWorkflowCallInvocationIdentity(identity);
      const parentCall = parsed === undefined
        ? undefined
        : [...parsed.calls].reverse().find((call) => call.kind === 'workflow_call');
      if (parsed === undefined || parentCall === undefined) continue;
      const parentIdentity = serializeWorkflowExecutionIdentity({
        workflow: parentCall.workflow,
        step: parentCall.step,
        calls: parsed.calls.slice(0, parsed.calls.indexOf(parentCall)),
      });
      const parentRecord = invocations[parentIdentity];
      if (parentRecord === undefined) continue;
      const parentNamespace = parseWorkflowCallNamespaceSegment(
        parentRecord.report_namespace_segment,
      );
      if (parentNamespace !== undefined) {
        workflowNamesByReference.set(parsed.workflow, parentNamespace.workflowName);
      }
    }
    const workflowNameByCallSite = new Map<string, string>();
    const uniqueCallSitesByWorkflowName = new Map<string, string | null>();
    const callSitesByNamespace = new Map<string, string>();
    const callSitesBySignature = new Map<string, Set<string>>();
    const callSitesByLegacySignature = new Map<string, Set<string>>();
    for (const [identity, record] of Object.entries(invocations)) {
      const keys = invocationCallSiteKeys(identity, workflowNamesByReference);
      const namespace = parseWorkflowCallNamespaceSegment(record.report_namespace_segment);
      if (keys === undefined || namespace === undefined || namespace.iteration === '*') continue;
      workflowNameByCallSite.set(keys.reference, keys.workflowName);
      const uniqueCallSite = uniqueCallSitesByWorkflowName.get(keys.workflowName);
      uniqueCallSitesByWorkflowName.set(
        keys.workflowName,
        uniqueCallSite === undefined || uniqueCallSite === keys.reference ? keys.reference : null,
      );
      callSitesByNamespace.set(record.report_namespace_segment, keys.reference);
      const signature = namespaceSignature(
        namespace.stepName,
        namespace.workflowName,
        namespace.siteDigest,
      );
      const callSites = callSitesBySignature.get(signature) ?? new Set<string>();
      callSites.add(keys.reference);
      callSitesBySignature.set(signature, callSites);
      const legacySignature = legacyNamespaceSignature(
        namespace.stepName,
        namespace.workflowName,
      );
      const legacyCallSites = callSitesByLegacySignature.get(legacySignature) ?? new Set<string>();
      legacyCallSites.add(keys.reference);
      callSitesByLegacySignature.set(legacySignature, legacyCallSites);
    }

    for (const file of manifest?.files ?? []) {
      const segments = file.path.split('/');
      for (let index = 0; index + 1 < segments.length; index += 1) {
        if (segments[index] !== 'subworkflows') continue;
        const namespaceSegment = segments[index + 1]!;
        const parsed = parseWorkflowCallNamespaceSegment(namespaceSegment);
        if (parsed === undefined || parsed.iteration === '*') continue;
        this.#artifactNamespacePaths.add(JSON.stringify(segments.slice(0, index + 2)));
        const signature = namespaceSignature(
          parsed.stepName,
          parsed.workflowName,
          parsed.siteDigest,
        );
        const candidates = callSitesBySignature.get(signature);
        let callSite = callSitesByNamespace.get(namespaceSegment)
          ?? (candidates?.size === 1 ? [...candidates][0] : undefined);
        if (callSite === undefined) {
          const legacyCandidates = callSitesByLegacySignature.get(
            legacyNamespaceSignature(parsed.stepName, parsed.workflowName),
          );
          if (legacyCandidates?.size === 1) {
            callSite = [...legacyCandidates][0];
          }
        }
        if (callSite === undefined) continue;
        this.#maxByCallSite.set(
          callSite,
          Math.max(this.#maxByCallSite.get(callSite) ?? 0, parsed.iteration),
        );
        const workflowNameCallSite = workflowNameByCallSite.get(callSite)!;
        if (uniqueCallSitesByWorkflowName.get(workflowNameCallSite) === callSite) {
          this.#maxByWorkflowNameCallSite.set(
            workflowNameCallSite,
            Math.max(this.#maxByWorkflowNameCallSite.get(workflowNameCallSite) ?? 0, parsed.iteration),
          );
        }
      }
    }
  }

  getMaxOccurrence(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
  ): number | undefined {
    const exact = this.#maxByCallSite.get(logicalCallSiteKey(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath.map((entry) => ({ ...entry, workflow: entry.workflow_ref })),
    ));
    if (exact !== undefined) return exact;
    return this.#maxByWorkflowNameCallSite.get(logicalCallSiteKey(
      workflow.name,
      stepName,
      workflowCallPath,
    ));
  }

  hasArtifactNamespacePath(namespacePath: readonly string[]): boolean {
    return this.#artifactNamespacePaths.has(JSON.stringify(namespacePath));
  }
}
