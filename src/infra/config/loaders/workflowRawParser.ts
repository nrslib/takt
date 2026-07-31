import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { WorkflowConfig } from '../../../core/models/types.js';
import { ZodError } from 'zod';
import type { FacetResolutionContext } from './resource-resolver.js';
import type {
  WorkflowStepFragmentProvenance,
  WorkflowStepFragmentRulePathMapping,
} from './workflowStepFragmentResolver.js';
import { resolveWorkflowStepFragments } from './workflowStepFragmentResolver.js';
import {
  findFragmentProvenanceAtExactPath,
  findFragmentProvenanceForStep,
} from './workflowStepFragmentProvenance.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import { getWorkflowConfigErrorPath } from '../../../core/workflow/workflow-config-error.js';
import {
  formatWorkflowStepFragmentErrorContext,
  registerWorkflowStepFragmentErrorContext,
  translateWorkflowStepFragmentError,
} from './workflowStepFragmentErrorTranslator.js';
import { attachWorkflowConfigErrorTranslator } from '../../../shared/workflowConfigMetadata.js';
import {
  hasVisitedWorkflowErrorContext,
  markVisitedWorkflowErrorContext,
} from './workflowFragmentErrorVisitTracker.js';

interface RawWorkflowFragmentContext {
  readonly provenance: readonly WorkflowStepFragmentProvenance[];
  readonly rulePathMappings: readonly WorkflowStepFragmentRulePathMapping[];
}

const fragmentContextByRawWorkflow = new WeakMap<object, RawWorkflowFragmentContext>();

export interface WorkflowRawParserOptions {
  context?: FacetResolutionContext;
  workflowPath: string;
  trustInfo?: WorkflowTrustInfo;
}

export function parseWorkflowRaw(raw: unknown, options: WorkflowRawParserOptions): ReturnType<typeof WorkflowConfigRawSchema.parse> {
  const resolved = resolveWorkflowStepFragments(raw, options);
  try {
    const parsed = WorkflowConfigRawSchema.parse(resolved.raw);
    fragmentContextByRawWorkflow.set(parsed, {
      provenance: resolved.provenance,
      rulePathMappings: resolved.rulePathMappings,
    });
    return parsed;
  } catch (error) {
    if (!(error instanceof ZodError)) {
      throw error;
    }
    const remappedIssues = error.issues.map((issue) => remapZodIssue(issue, resolved.rulePathMappings));
    if (resolved.provenance.length === 0) {
      throw new ZodError(remappedIssues);
    }
    throw new ZodError(remappedIssues.map((issue) => {
      const provenance = isCallerRulePath(issue.path, resolved.rulePathMappings)
        ? undefined
        : findFragmentErrorProvenance(issue, resolved.provenance);
      if (!provenance) {
        return issue;
      }
      return {
        ...issue,
        message: `${issue.message} (${formatWorkflowStepFragmentErrorContext(options.workflowPath, provenance.source, provenance.workflowDefined)})`,
      };
    }));
  }
}

function remapZodIssue(
  issue: ZodError['issues'][number],
  mappings: readonly WorkflowStepFragmentRulePathMapping[],
): ZodError['issues'][number] {
  const originalPath = issue.path;
  const path = [...remapRulePath(originalPath, mappings)];
  if (issue.code !== 'invalid_union') {
    return { ...issue, path };
  }
  const errors = issue.errors.map((branch) => branch.map((nestedIssue) => {
    const nestedAbsolutePath = [...originalPath, ...nestedIssue.path];
    const remappedNestedPath = remapRulePath(nestedAbsolutePath, mappings);
    const nestedPath = startsWithPath(remappedNestedPath, path)
      ? remappedNestedPath.slice(path.length)
      : remappedNestedPath;
    return remapZodIssue(
      { ...nestedIssue, path: [...nestedPath] } as ZodError['issues'][number],
      [],
    );
  })) as typeof issue.errors;
  return {
    ...issue,
    path,
    errors,
  } as ZodError['issues'][number];
}

function remapRulePath(
  path: readonly PropertyKey[],
  mappings: readonly WorkflowStepFragmentRulePathMapping[],
): readonly PropertyKey[] {
  const mapping = mappings
    .filter((candidate) => startsWithPath(path, candidate.normalizedPath))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length)[0];
  return mapping === undefined
    ? path
    : [...mapping.callerPath, ...path.slice(mapping.normalizedPath.length)];
}

function startsWithPath(
  path: readonly PropertyKey[],
  prefix: readonly PropertyKey[],
): boolean {
  return prefix.length <= path.length
    && prefix.every((entry, index) => entry === path[index]);
}

function isCallerRulePath(
  path: readonly PropertyKey[],
  mappings: readonly WorkflowStepFragmentRulePathMapping[],
): boolean {
  return mappings.some((mapping) => startsWithPath(path, mapping.callerPath));
}

function isNormalizedRulePath(
  path: readonly PropertyKey[],
  mappings: readonly WorkflowStepFragmentRulePathMapping[],
): boolean {
  return mappings.some((mapping) => startsWithPath(path, mapping.normalizedPath));
}

export function annotateWorkflowFragmentError(
  error: unknown,
  raw: object,
  workflowPath: string,
  sourcePath?: readonly PropertyKey[],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && hasVisitedWorkflowErrorContext(error, 'raw', workflowPath)) {
    return error;
  }
  const context = fragmentContextByRawWorkflow.get(raw);
  const provenance = context?.provenance ?? [];
  const errorPath = sourcePath ?? getWorkflowConfigErrorPath(error);
  if (errorPath !== undefined && isNormalizedRulePath(errorPath, context?.rulePathMappings ?? [])) {
    return error instanceof Error ? error : new Error(message);
  }
  const exactSource = errorPath === undefined
    ? undefined
    : findFragmentProvenanceAtExactPath(provenance, errorPath);
  const source = exactSource
    ?? (errorPath === undefined ? undefined : findFragmentProvenanceForStep(provenance, errorPath));
  if (!source) {
    return error instanceof Error ? error : new Error(message);
  }
  const details = formatWorkflowStepFragmentErrorContext(workflowPath, source, exactSource === undefined);
  const annotated = new Error(`${message} (${details})`, { cause: error instanceof Error ? error : undefined });
  markVisitedWorkflowErrorContext(error instanceof Error ? error : undefined, annotated, 'raw', workflowPath);
  return annotated;
}

export function registerWorkflowFragmentErrorSource(
  workflow: object,
  raw: object,
  workflowPath: string,
): void {
  registerWorkflowStepFragmentErrorContext(
    workflow,
    fragmentContextByRawWorkflow.get(raw)?.provenance ?? [],
    raw,
    workflowPath,
    fragmentContextByRawWorkflow.get(raw)?.rulePathMappings ?? [],
  );
  attachWorkflowConfigErrorTranslator(
    workflow,
    (target, error) => translateWorkflowStepFragmentError(target as WorkflowConfig, error),
  );
}

export function annotateWorkflowConfigFragmentError(error: unknown, workflow: object): Error {
  return translateWorkflowStepFragmentError(workflow as WorkflowConfig, error);
}

function findFragmentErrorProvenance(
  issue: ZodError['issues'][number],
  provenance: readonly WorkflowStepFragmentProvenance[],
) : { source: WorkflowStepFragmentProvenance; workflowDefined: boolean } | undefined {
  const unionPath = findCommonUnionIssuePath(issue);
  if (unionPath !== undefined) {
    const exactSource = findFragmentProvenanceAtExactPath(provenance, unionPath);
    const source = exactSource ?? findFragmentProvenanceForStep(provenance, unionPath);
    return source === undefined
      ? undefined
      : { source, workflowDefined: exactSource === undefined };
  }
  const issuePath = issue.path;
  const exactSource = findFragmentProvenanceAtExactPath(provenance, issuePath);
  const source = exactSource ?? findFragmentProvenanceForStep(provenance, issuePath);
  if (!source) {
    return undefined;
  }
  return { source, workflowDefined: exactSource === undefined };
}

function findCommonUnionIssuePath(
  issue: ZodError['issues'][number],
): readonly PropertyKey[] | undefined {
  if (issue.code !== 'invalid_union' || issue.errors.length === 0) {
    return undefined;
  }
  const pathsByBranch = issue.errors.map((branch) => branch.map((nested) => nested.path));
  const commonPath = pathsByBranch[0]?.find((candidate) =>
    pathsByBranch.slice(1).every((branch) =>
      branch.some((path) =>
        path.length === candidate.length
        && path.every((part, index) => part === candidate[index]))));
  return commonPath === undefined ? undefined : [...issue.path, ...commonPath];
}
