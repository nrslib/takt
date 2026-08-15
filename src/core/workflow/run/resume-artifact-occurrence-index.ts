import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { parseWorkflowCallInvocationIdentity } from '../workflow-execution-identity-codec.js';
import type { ResumeReportSnapshotManifest } from './resume-report-snapshot.js';
import { parseWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';

function logicalCallSiteKey(
  workflowReference: string,
  stepName: string,
  workflowCallPath: readonly Pick<WorkflowResumePointEntry, 'workflow_ref' | 'step' | 'kind'>[],
): string {
  return JSON.stringify({
    workflow: workflowReference,
    step: stepName,
    calls: workflowCallPath.map((entry) => ({
      workflow: entry.workflow_ref,
      step: entry.step,
      kind: entry.kind,
    })),
  });
}

function invocationLogicalCallSiteKey(identity: string): string | undefined {
  const parsed = parseWorkflowCallInvocationIdentity(identity);
  if (parsed === undefined) return undefined;
  return JSON.stringify({
    workflow: parsed.workflow,
    step: parsed.step,
    calls: parsed.calls.map((call) => ({
      workflow: call.workflow,
      step: call.step,
      kind: call.kind,
    })),
  });
}

function namespaceSignature(stepName: string, workflowName: string, siteDigest?: string): string {
  return JSON.stringify([stepName, workflowName, siteDigest]);
}

function legacyNamespaceSignature(stepName: string, workflowName: string): string {
  return JSON.stringify([stepName, workflowName]);
}

export class ResumeArtifactOccurrenceIndex {
  readonly #maxByCallSite = new Map<string, number>();
  readonly #artifactNamespacePaths = new Set<string>();

  constructor(
    manifest: ResumeReportSnapshotManifest | undefined,
    sourceResumePoint: WorkflowResumePoint | undefined,
    onWarning: (message: string) => void,
  ) {
    const callSitesByNamespace = new Map<string, string>();
    const callSitesBySignature = new Map<string, Set<string>>();
    const callSitesByLegacySignature = new Map<string, Set<string>>();
    const warnedAmbiguousLegacyNamespaces = new Set<string>();
    for (const [identity, record] of Object.entries(
      sourceResumePoint?.workflow_call_invocations ?? {},
    )) {
      const callSite = invocationLogicalCallSiteKey(identity);
      const namespace = parseWorkflowCallNamespaceSegment(record.report_namespace_segment);
      if (callSite === undefined || namespace === undefined || namespace.iteration === '*') continue;
      callSitesByNamespace.set(record.report_namespace_segment, callSite);
      const signature = namespaceSignature(
        namespace.stepName,
        namespace.workflowName,
        namespace.siteDigest,
      );
      const callSites = callSitesBySignature.get(signature) ?? new Set<string>();
      callSites.add(callSite);
      callSitesBySignature.set(signature, callSites);
      const legacySignature = legacyNamespaceSignature(
        namespace.stepName,
        namespace.workflowName,
      );
      const legacyCallSites = callSitesByLegacySignature.get(legacySignature) ?? new Set<string>();
      legacyCallSites.add(callSite);
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
          } else if (legacyCandidates !== undefined && legacyCandidates.size > 1) {
            if (!warnedAmbiguousLegacyNamespaces.has(namespaceSegment)) {
              onWarning(
                `Excluded legacy workflow-call artifact namespace "${namespaceSegment}" from resume occurrence restoration because its logical call-site is ambiguous`,
              );
              warnedAmbiguousLegacyNamespaces.add(namespaceSegment);
            }
          }
        }
        if (callSite === undefined) continue;
        this.#maxByCallSite.set(
          callSite,
          Math.max(this.#maxByCallSite.get(callSite) ?? 0, parsed.iteration),
        );
      }
    }
  }

  getMaxOccurrence(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
  ): number | undefined {
    return this.#maxByCallSite.get(logicalCallSiteKey(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath,
    ));
  }

  hasArtifactNamespacePath(namespacePath: readonly string[]): boolean {
    return this.#artifactNamespacePaths.has(JSON.stringify(namespacePath));
  }
}
