import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const WORKFLOW_SOURCE_PATH = Symbol('workflowSourcePath');
const WORKFLOW_TRUST_INFO = Symbol('workflowTrustInfo');
const WORKFLOW_OPAQUE_REF = Symbol.for('takt.workflowOpaqueRef');
const WORKFLOW_BUNDLE_NODE_ID = Symbol.for('takt.workflowBundleNodeId');
const WORKFLOW_CONFIG_ERROR_TRANSLATOR = Symbol('workflowConfigErrorTranslator');
const WORKFLOW_RESOLVED_SECTIONS = Symbol('workflowResolvedSections');
type WorkflowConfigErrorTranslator = (workflow: object, error: unknown) => Error;
export interface WorkflowResolvedSectionContent {
  readonly content: string;
  readonly sourcePath?: string;
  readonly facetType?: string;
  readonly refName?: string;
}
export type WorkflowResolvedSections = Partial<Record<string, Record<string, WorkflowResolvedSectionContent>>>;
type WorkflowConfigWithSourcePath = object & {
  [WORKFLOW_SOURCE_PATH]?: string;
  [WORKFLOW_TRUST_INFO]?: object;
  [WORKFLOW_OPAQUE_REF]?: string;
  [WORKFLOW_BUNDLE_NODE_ID]?: string;
  [WORKFLOW_CONFIG_ERROR_TRANSLATOR]?: WorkflowConfigErrorTranslator;
  [WORKFLOW_RESOLVED_SECTIONS]?: WorkflowResolvedSections;
};

export function attachWorkflowSourcePath<T extends object>(workflow: T, sourcePath: string): T {
  Object.defineProperty(workflow, WORKFLOW_SOURCE_PATH, {
    value: resolve(sourcePath), writable: false, configurable: false, enumerable: false,
  });
  return workflow;
}

export function buildOpaqueWorkflowRef(sourcePath: string, trustInfo: { source: string }): string {
  const normalizedPath = resolve(sourcePath);
  const digest = createHash('sha256').update(normalizedPath).digest('hex');
  return `${trustInfo.source}:sha256:${digest}`;
}

export function attachWorkflowOpaqueRef<T extends object>(workflow: T, opaqueRef: string): T {
  Object.defineProperty(workflow, WORKFLOW_OPAQUE_REF, {
    value: opaqueRef, writable: false, configurable: false, enumerable: false,
  });
  return workflow;
}

export function getAttachedWorkflowOpaqueRef(workflow: object): string | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_OPAQUE_REF];
}

export function attachWorkflowBundleNodeId<T extends object>(workflow: T, nodeId: string): T {
  Object.defineProperty(workflow, WORKFLOW_BUNDLE_NODE_ID, {
    value: nodeId, writable: false, configurable: false, enumerable: false,
  });
  return workflow;
}

export function getAttachedWorkflowBundleNodeId(workflow: object): string | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_BUNDLE_NODE_ID];
}

export function getWorkflowSourcePath(workflow: object): string | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_SOURCE_PATH];
}

export function attachWorkflowResolvedSections<T extends object>(workflow: T, sections: WorkflowResolvedSections): T {
  Object.defineProperty(workflow, WORKFLOW_RESOLVED_SECTIONS, {
    value: sections, writable: false, configurable: false, enumerable: false,
  });
  return workflow;
}

export function getWorkflowResolvedSections(workflow: object): WorkflowResolvedSections | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_RESOLVED_SECTIONS];
}

export function attachWorkflowTrustInfo<T extends object, TrustInfo extends object>(workflow: T, trustInfo: TrustInfo): T {
  Object.defineProperty(workflow, WORKFLOW_TRUST_INFO, {
    value: freezeTrustInfo(trustInfo), writable: false, configurable: false, enumerable: false,
  });
  return workflow;
}

export function getAttachedWorkflowTrustInfo(workflow: object): object | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_TRUST_INFO];
}

export function attachWorkflowConfigErrorTranslator<T extends object>(
  workflow: T,
  translator: WorkflowConfigErrorTranslator,
): T {
  Object.defineProperty(workflow, WORKFLOW_CONFIG_ERROR_TRANSLATOR, {
    value: translator, writable: false, configurable: false, enumerable: false,
  });
  return workflow;
}

export function translateWorkflowConfigError(workflow: object, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_CONFIG_ERROR_TRANSLATOR]?.(workflow, normalized) ?? normalized;
}

export function inheritWorkflowConfigMetadata(source: object, target: object): void {
  if (source === target) return;
  for (const key of [
    WORKFLOW_SOURCE_PATH,
    WORKFLOW_TRUST_INFO,
    WORKFLOW_OPAQUE_REF,
    WORKFLOW_BUNDLE_NODE_ID,
    WORKFLOW_CONFIG_ERROR_TRANSLATOR,
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (Object.getOwnPropertyDescriptor(target, key)) continue;
    const value = key === WORKFLOW_CONFIG_ERROR_TRANSLATOR
      ? bindWorkflowConfigErrorTranslator(source, descriptor.value as WorkflowConfigErrorTranslator)
      : key === WORKFLOW_TRUST_INFO && descriptor.value !== undefined
        ? freezeTrustInfo(descriptor.value)
        : descriptor.value;
    Object.defineProperty(target, key, { ...descriptor, value });
  }
}

function bindWorkflowConfigErrorTranslator(
  source: object,
  translator: WorkflowConfigErrorTranslator,
): WorkflowConfigErrorTranslator {
  return (_workflow, error) => translator(source, error);
}

function freezeTrustInfo<T extends object>(trustInfo: T): T {
  return freezeTrustValue(trustInfo, new WeakMap<object, object>());
}

function freezeTrustValue<T>(value: T, copies: WeakMap<object, object>): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const existing = copies.get(value);
  if (existing !== undefined) {
    return existing as T;
  }
  const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  copies.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key as keyof typeof copy] = freezeTrustValue(entry, copies);
  }
  return Object.freeze(copy) as T;
}
