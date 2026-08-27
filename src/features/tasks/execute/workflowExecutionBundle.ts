import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { WorkflowCallArgValueRawSchema } from '../../../core/models/index.js';
import type {
  AgentWorkflowStep,
  WorkflowCallArgValue,
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowStep,
  McpServerConfig,
} from '../../../core/models/index.js';
import { getAllParallelSubSteps, isDynamicParallelSubSteps } from '../../../core/models/index.js';
import type { WorkflowCallResolver } from '../../../core/workflow/types.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { findWorkflowStepLocation } from '../../../core/workflow/workflow-step-location.js';
import { getWorkflowReference } from '../../../core/workflow/workflow-reference.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import {
  attachWorkflowBundleNodeId,
  attachWorkflowOpaqueRef,
  getAttachedWorkflowBundleNodeId,
} from '../../../shared/workflowConfigMetadata.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { isSensitiveKeyName } from '../../../shared/utils/sensitiveText.js';
import { extractPersonaName } from '../../../agents/persona-spec.js';
import { loadAgentPrompt, loadCustomAgents } from '../../../infra/config/loaders/agentLoader.js';

const BUNDLE_VERSION = 1;
const RESOURCE_REF_PREFIX = 'bundle-resource:sha256:';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Inspection must not turn a persisted run into an unbounded JSON parser.
 * These limits are deliberately per-file so a normal bundle may still contain
 * many nodes/resources while a single manifest/object cannot exhaust memory.
 */
export const MAX_WORKFLOW_BUNDLE_MANIFEST_BYTES = 1 * 1024 * 1024;
export const MAX_WORKFLOW_BUNDLE_OBJECT_BYTES = 4 * 1024 * 1024;
/**
 * Resource descriptors are validated before a full execution loader allocates
 * their contents.  The metadata-only reader uses the same bounds while it
 * intentionally never reads resource bytes.
 */
export const MAX_WORKFLOW_BUNDLE_RESOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKFLOW_BUNDLE_RESOURCES_BYTES = 64 * 1024 * 1024;
const OPEN_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type StepPath = readonly (string | number)[];

interface BundleCallEdge {
  readonly stepPath: StepPath;
  readonly childNodeId: string;
  readonly call: string;
  readonly args: Readonly<Record<string, WorkflowCallArgValue>>;
}

interface BundleNodeObject {
  readonly version: 1;
  readonly nodeId: string;
  readonly originalWorkflowRef: string;
  readonly binding: JsonValue;
  readonly config: JsonValue;
  readonly calls: readonly BundleCallEdge[];
}

interface BundleManifest {
  readonly version: 1;
  readonly root: {
    readonly nodeId: string;
    readonly workflowName: string;
    readonly originalWorkflowRef: string;
  };
  readonly nodes: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, {
    readonly kind: 'prompt' | 'arpeggio-source';
    readonly size: number;
  }>>;
}

interface PreparedNode {
  readonly nodeId: string;
  readonly original: WorkflowConfig;
  readonly originalWorkflowRef: string;
  readonly config: WorkflowConfig;
  readonly binding: JsonValue;
}

const MCP_ENV_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;
const MCP_ENV_REFERENCE_GLOBAL_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/gu;
const MCP_FLAG_NAME_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MCP_CREDENTIAL_FLAG_NAMES = new Set([
  'access-key',
  'access-token',
  'api-key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'header',
  'headers',
  'key',
  'password',
  'passphrase',
  'pass-phrase',
  'private-key',
  'proxy-authorization',
  'refresh-token',
  'secret',
  'session-id',
  'set-cookie',
  'token',
  'user',
  'proxy-user',
]);
const MCP_CREDENTIAL_FLAG_SUFFIXES = [
  '-apikey',
  '-auth',
  '-authorization',
  '-bearer',
  '-cookie',
  '-cookies',
  '-credential',
  '-credentials',
  '-header',
  '-headers',
  '-key',
  '-pass-phrase',
  '-passphrase',
  '-password',
  '-secret',
  '-session-id',
  '-token',
] as const;
const MCP_CREDENTIAL_KEY_NAMES = new Set([
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'header',
  'headers',
  'key',
  'password',
  'passphrase',
  'pass-phrase',
  'secret',
  'session-id',
  'set-cookie',
  'token',
]);
const MCP_CREDENTIAL_KEY_SUFFIXES = [
  '-apikey',
  '-api-key',
  '-auth',
  '-auth-header',
  '-authorization',
  '-authorization-header',
  '-bearer',
  '-cookie',
  '-cookies',
  '-credential',
  '-credentials',
  '-key',
  '-pass-phrase',
  '-passphrase',
  '-password',
  '-secret',
  '-session-id',
  '-token',
] as const;

function normalizeMcpFlagName(flag: string): string {
  return flag.replace(/^-+/u, '').replaceAll('_', '-').toLowerCase();
}

function isMcpCredentialFlag(flag: string): boolean {
  // Only the standard compact credential aliases are protected. Generic
  // short options such as -k, -p, -t, and -A are command-specific. Curl's
  // -uVALUE/-UVALUE forms are intentionally parsed as compact credentials;
  // this makes -url unavoidably ambiguous with -u + "rl".
  if (/^-[^-]/u.test(flag)) return flag === '-H' || flag === '-u' || flag === '-U';
  const normalized = normalizeMcpFlagName(flag);
  return MCP_CREDENTIAL_FLAG_NAMES.has(normalized)
    || MCP_CREDENTIAL_FLAG_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function normalizeMcpKeyName(key: string): string {
  return key.trim().replaceAll('_', '-').toLowerCase();
}

function isMcpCredentialKey(key: string): boolean {
  const normalized = normalizeMcpKeyName(key);
  return isSensitiveKeyName(normalized)
    || MCP_CREDENTIAL_KEY_NAMES.has(normalized)
    || MCP_CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function parseMcpFlag(argument: string): { readonly name: string; readonly inlineValue?: string } | undefined {
  if (!argument.startsWith('-') || argument === '-' || argument === '--') return undefined;
  if (argument.startsWith('-H') && argument.length > 2 && argument[2] !== '=' && argument[2] !== ':') {
    return { name: '-H', inlineValue: argument.slice(2) };
  }
  if (argument.startsWith('-u') && argument.length > 2 && argument[2] !== '=' && argument[2] !== ':') {
    return { name: '-u', inlineValue: argument.slice(2) };
  }
  if (argument.startsWith('-U') && argument.length > 2 && argument[2] !== '=' && argument[2] !== ':') {
    return { name: '-U', inlineValue: argument.slice(2) };
  }
  const separatorIndex = argument.search(/[=:]/u);
  const name = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
  if (!MCP_FLAG_NAME_PATTERN.test(name)) return undefined;
  return separatorIndex === -1
    ? { name }
    : { name, inlineValue: argument.slice(separatorIndex + 1) };
}

function requireMcpEnvironmentReference(value: string, label: string): void {
  if (MCP_ENV_REFERENCE_PATTERN.test(value)) return;
  throw new Error(
    `Central workflow bundle rejects unsafe MCP value at ${label}; only a complete environment reference is allowed`,
  );
}

function assertCentralMcpArgumentSafety(
  args: readonly string[] | undefined,
  label: string,
): void {
  if (args === undefined) return;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const flag = parseMcpFlag(argument);
    if (flag === undefined || !isMcpCredentialFlag(flag.name)) continue;
    if (flag.inlineValue !== undefined) {
      requireMcpEnvironmentReference(flag.inlineValue, `${label}.args[${index}]`);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Central workflow bundle rejects MCP argument ${argument} without an environment reference`);
    }
    requireMcpEnvironmentReference(value, `${label}.args[${index + 1}]`);
    index += 1;
  }
}

function assertCentralMcpUrlSafety(value: string, label: string): void {
  if (MCP_ENV_REFERENCE_PATTERN.test(value)) return;
  let parsed: URL;
  try {
    parsed = new URL(value.replace(MCP_ENV_REFERENCE_GLOBAL_PATTERN, 'env-reference'));
  } catch {
    throw new Error(`Central workflow bundle rejects invalid MCP URL at ${label}`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`Central workflow bundle rejects MCP URL credentials at ${label}`);
  }
  for (const [key] of parsed.searchParams) {
    if (isMcpCredentialKey(key)) {
      throw new Error(`Central workflow bundle rejects unsafe MCP URL at ${label}; credential-bearing query is unsupported`);
    }
  }
  const fragment = parsed.hash.slice(1);
  if (fragment !== '') {
    const fragmentParts = [fragment];
    for (const match of fragment.matchAll(/[?#]([^?#]*)/gu)) {
      if (match[1] !== undefined) fragmentParts.push(match[1]);
    }
    const hasCredentialBearingFragment = fragmentParts.some((part) => {
      const fragmentParams = new URLSearchParams(part);
      const fragmentKey = part.split(/[=&?#:]/u, 1)[0] ?? '';
      return [...fragmentParams.keys()].some((key) => isMcpCredentialKey(key))
        || isMcpCredentialKey(fragmentKey);
    });
    if (hasCredentialBearingFragment) {
      throw new Error(`Central workflow bundle rejects unsafe MCP URL at ${label}; credential-bearing fragment is unsupported`);
    }
  }
}

function assertCentralMcpServerValueSafety(
  server: McpServerConfig,
  label: string,
): void {
  if ('command' in server) {
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (isMcpCredentialKey(key)) {
        requireMcpEnvironmentReference(value, `${label}.env.${key}`);
      }
    }
    assertCentralMcpArgumentSafety(server.args, label);
    return;
  }

  const remote = server as Extract<McpServerConfig, { readonly url: string }>;
  assertCentralMcpUrlSafety(remote.url, `${label}.url`);
  for (const [key, value] of Object.entries(remote.headers ?? {})) {
    if (isMcpCredentialKey(key)) {
      requireMcpEnvironmentReference(value, `${label}.headers.${key}`);
    }
  }
}

/**
 * Central runs persist a portable workflow bundle below the state root. Legacy
 * Credential-bearing MCP values may carry only complete environment references
 * across that durable boundary. Ordinary environment/header values and URL
 * metadata remain portable; credential-bearing URL parts are rejected.
 */
function assertCentralWorkflowBundleCredentialSafety(
  workflow: WorkflowConfig,
): void {
  walkSteps(workflow.steps, (step) => {
    if (step.kind === 'system' || step.kind === 'workflow_call' || step.mcpServers === undefined) return;
    for (const [name, server] of Object.entries(step.mcpServers)) {
      assertCentralMcpServerValueSafety(server, `step "${step.name}".mcpServers.${name}`);
    }
  });
}

export interface PreparedWorkflowExecutionBundle {
  readonly manifest: BundleManifest;
  readonly objects: ReadonlyMap<string, string>;
  readonly resources: ReadonlyMap<string, Buffer>;
}

export interface LoadedWorkflowExecutionBundle {
  readonly manifest: BundleManifest;
  readonly rootWorkflow: WorkflowConfig;
  /** Every verified node config, including parallel/fixed/pool children. */
  readonly workflows: readonly WorkflowConfig[];
  readonly workflowCallResolver: WorkflowCallResolver;
  readonly prepared: PreparedWorkflowExecutionBundle;
  readonly resourceRoot: string;
}

export interface LoadedWorkflowExecutionBundleMetadata {
  readonly manifest: BundleManifest;
  readonly rootWorkflow: WorkflowConfig;
  /** Every verified node config, including parallel/fixed/pool children. */
  readonly workflows: readonly WorkflowConfig[];
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function toJsonValue(value: unknown, path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Workflow bundle value is not finite at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) throw new Error(`Workflow bundle array contains undefined at ${path}[${index}]`);
      return toJsonValue(entry, `${path}[${index}]`);
    });
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error(`Workflow bundle value is not JSON-compatible at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Workflow bundle value is not a plain object at ${path}`);
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) result[key] = toJsonValue(entry, `${path}.${key}`);
  }
  return result;
}

function resourceRef(hash: string): string {
  return `${RESOURCE_REF_PREFIX}${hash}`;
}

function parseResourceRef(value: string): string | undefined {
  if (!value.startsWith(RESOURCE_REF_PREFIX)) return undefined;
  return requireSha256(value.slice(RESOURCE_REF_PREFIX.length), 'Workflow bundle resource reference');
}

function addResource(
  resources: Map<string, Buffer>,
  resourceKinds: Map<string, BundleManifest['resources'][string]['kind']>,
  content: string | Buffer,
  kind: BundleManifest['resources'][string]['kind'],
): string {
  const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf-8');
  const hash = sha256(bytes);
  const existingKind = resourceKinds.get(hash);
  if (existingKind !== undefined && existingKind !== kind) {
    throw new Error(`Workflow bundle resource ${hash} has conflicting kinds`);
  }
  resources.set(hash, bytes);
  resourceKinds.set(hash, kind);
  return resourceRef(hash);
}

function resolvePersonaPrompt(
  persona: string | undefined,
  personaPath: string | undefined,
  customAgents: ReturnType<typeof loadCustomAgents>,
  projectCwd: string,
): string | undefined {
  if (personaPath !== undefined) return readFileSync(personaPath, 'utf-8');
  if (persona === undefined) return undefined;
  const custom = customAgents.get(extractPersonaName(persona));
  return custom === undefined ? persona : loadAgentPrompt(custom, projectCwd);
}

function materializePersona(
  owner: { persona?: string; personaPath?: string },
  customAgents: ReturnType<typeof loadCustomAgents>,
  projectCwd: string,
  resources: Map<string, Buffer>,
  resourceKinds: Map<string, BundleManifest['resources'][string]['kind']>,
): void {
  const prompt = resolvePersonaPrompt(owner.persona, owner.personaPath, customAgents, projectCwd);
  if (prompt === undefined) return;
  owner.personaPath = addResource(resources, resourceKinds, prompt, 'prompt');
}

interface SelectorOwner {
  readonly selector: { persona?: string; personaPath?: string };
  readonly label: string;
}

function getSelectorOwners(step: WorkflowStep): readonly SelectorOwner[] {
  if (step.kind === 'system' || step.kind === 'workflow_call') return [];
  const owners: SelectorOwner[] = [];
  if (step.dynamicFacets?.selector !== undefined) {
    owners.push({
      selector: step.dynamicFacets.selector,
      label: `dynamic facet selector for step "${step.name}"`,
    });
  }
  if (step.parallel !== undefined && isDynamicParallelSubSteps(step.parallel)
    && step.parallel.selection.selector !== undefined) {
    owners.push({
      selector: step.parallel.selection.selector,
      label: `dynamic parallel selector for step "${step.name}"`,
    });
  }
  return owners;
}

function materializeAgentStep(
  step: AgentWorkflowStep,
  customAgents: ReturnType<typeof loadCustomAgents>,
  projectCwd: string,
  resources: Map<string, Buffer>,
  resourceKinds: Map<string, BundleManifest['resources'][string]['kind']>,
): void {
  materializePersona(step, customAgents, projectCwd, resources, resourceKinds);
  for (const { selector } of getSelectorOwners(step)) {
    materializePersona(selector, customAgents, projectCwd, resources, resourceKinds);
  }
  if (step.teamLeader !== undefined) {
    materializePersona(step.teamLeader, customAgents, projectCwd, resources, resourceKinds);
    const partOwner = {
      persona: step.teamLeader.partPersona,
      personaPath: step.teamLeader.partPersonaPath,
    };
    materializePersona(partOwner, customAgents, projectCwd, resources, resourceKinds);
    step.teamLeader.partPersonaPath = partOwner.personaPath;
  }
  if (step.arpeggio !== undefined) {
    if (step.arpeggio.source !== 'csv') {
      throw new Error(`Workflow bundle does not support custom arpeggio source "${step.arpeggio.source}"`);
    }
    const sourcePath = addResource(
      resources,
      resourceKinds,
      readFileSync(step.arpeggio.sourcePath),
      'arpeggio-source',
    );
    const templatePath = addResource(
      resources,
      resourceKinds,
      readFileSync(step.arpeggio.templatePath),
      'prompt',
    );
    const merge = step.arpeggio.merge.file === undefined
      ? step.arpeggio.merge
      : {
          ...step.arpeggio.merge,
          inlineJs: readFileSync(step.arpeggio.merge.file, 'utf-8'),
          file: undefined,
        };
    step.arpeggio = {
      ...step.arpeggio,
      sourcePath,
      templatePath,
      merge,
    };
  }
}

function walkSteps(steps: readonly WorkflowStep[], visit: (step: WorkflowStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.parallel !== undefined) walkSteps(getAllParallelSubSteps(step.parallel), visit);
  }
}

function materializeWorkflowConfig(
  workflow: WorkflowConfig,
  customAgents: ReturnType<typeof loadCustomAgents>,
  projectCwd: string,
  resources: Map<string, Buffer>,
  resourceKinds: Map<string, BundleManifest['resources'][string]['kind']>,
): WorkflowConfig {
  const cloned = structuredClone(workflow);
  walkSteps(cloned.steps, (step) => {
    if (step.kind === undefined || step.kind === 'agent') {
      materializeAgentStep(step, customAgents, projectCwd, resources, resourceKinds);
    }
  });
  for (const monitor of cloned.loopMonitors ?? []) {
    materializePersona(monitor.judge, customAgents, projectCwd, resources, resourceKinds);
  }
  return cloned;
}

function buildBinding(step: WorkflowCallStep | undefined): JsonValue {
  return step === undefined
    ? { root: true }
    : toJsonValue({ call: step.call, args: step.args ?? {} });
}

function buildNodeId(originalWorkflowRef: string, config: unknown, binding: JsonValue): string {
  return sha256(canonicalJson({
    originalWorkflowRef,
    config: toJsonValue(config),
    binding,
  }));
}

function collectWorkflowCalls(config: WorkflowConfig): Array<{ step: WorkflowCallStep; stepPath: StepPath }> {
  const calls: Array<{ step: WorkflowCallStep; stepPath: StepPath }> = [];
  walkSteps(config.steps, (step) => {
    if (!isWorkflowCallStep(step)) return;
    const stepPath = findWorkflowStepLocation(config, step);
    if (stepPath === undefined) throw new Error(`Workflow bundle could not locate call step "${step.name}"`);
    if (stepPath.some((part) => typeof part !== 'string' && typeof part !== 'number')) {
      throw new Error(`Workflow bundle call step "${step.name}" has an unsupported path`);
    }
    calls.push({ step, stepPath: stepPath as StepPath });
  });
  return calls;
}

export function prepareWorkflowExecutionBundle(input: {
  readonly rootWorkflow: WorkflowConfig;
  readonly workflowCallResolver: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
  /** Reject durable legacy MCP credential literals for central state runs. */
  readonly centralExecution?: boolean;
  readonly rootWorkflowRefOverride?: string;
  readonly workflowRefResolver?: (
    workflow: WorkflowConfig,
    context: undefined | {
      readonly parentWorkflowRef: string;
      readonly step: WorkflowCallStep;
    },
  ) => string | undefined;
}): PreparedWorkflowExecutionBundle {
  const resources = new Map<string, Buffer>();
  const resourceKinds = new Map<string, BundleManifest['resources'][string]['kind']>();
  const customAgents = loadCustomAgents();
  const preparedById = new Map<string, PreparedNode>();
  const objects = new Map<string, string>();
  const objectHashByNodeId = new Map<string, string>();

  const prepareNode = (
    original: WorkflowConfig,
    binding: JsonValue,
    workflowRefOverride?: string,
    context?: { readonly parentWorkflowRef: string; readonly step: WorkflowCallStep },
  ): PreparedNode => {
    if (input.centralExecution) {
      assertCentralWorkflowBundleCredentialSafety(original);
    }
    const originalWorkflowRef = workflowRefOverride
      ?? input.workflowRefResolver?.(original, context)
      ?? getWorkflowReference(original);
    const config = materializeWorkflowConfig(
      original,
      customAgents,
      input.projectCwd,
      resources,
      resourceKinds,
    );
    const nodeId = buildNodeId(originalWorkflowRef, config, binding);
    const existing = preparedById.get(nodeId);
    if (existing !== undefined) return existing;
    const prepared = { nodeId, original, originalWorkflowRef, config, binding };
    preparedById.set(nodeId, prepared);
    return prepared;
  };

  const root = prepareNode(
    input.rootWorkflow,
    buildBinding(undefined),
    input.rootWorkflowRefOverride,
  );
  const queue: PreparedNode[] = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]!;
    const materializedCalls = collectWorkflowCalls(node.config);
    const originalCalls = collectWorkflowCalls(node.original);
    if (materializedCalls.length !== originalCalls.length) {
      throw new Error(`Workflow bundle call topology changed while materializing "${node.config.name}"`);
    }
    const calls: BundleCallEdge[] = [];
    for (let callIndex = 0; callIndex < originalCalls.length; callIndex += 1) {
      const originalCall = originalCalls[callIndex]!;
      const materializedCall = materializedCalls[callIndex]!;
      if (canonicalJson(originalCall.stepPath) !== canonicalJson(materializedCall.stepPath)) {
        throw new Error(`Workflow bundle call topology is unstable in "${node.config.name}"`);
      }
      const child = input.workflowCallResolver({
        parentWorkflow: node.original,
        step: originalCall.step,
        projectCwd: input.projectCwd,
        lookupCwd: input.lookupCwd,
      });
      if (child === null) {
        throw new Error(`Workflow bundle could not resolve call "${node.config.name}/${originalCall.step.name}"`);
      }
      const preparedChild = prepareNode(child, buildBinding(originalCall.step), undefined, {
        parentWorkflowRef: node.originalWorkflowRef,
        step: originalCall.step,
      });
      if (!objectHashByNodeId.has(preparedChild.nodeId) && !queue.includes(preparedChild)) queue.push(preparedChild);
      calls.push({
        stepPath: materializedCall.stepPath,
        childNodeId: preparedChild.nodeId,
        call: originalCall.step.call,
        args: structuredClone(originalCall.step.args ?? {}),
      });
    }
    const object: BundleNodeObject = {
      version: 1,
      nodeId: node.nodeId,
      originalWorkflowRef: node.originalWorkflowRef,
      binding: node.binding,
      config: toJsonValue(node.config),
      calls,
    };
    const encoded = canonicalJson(object);
    const objectHash = sha256(encoded);
    objects.set(objectHash, encoded);
    objectHashByNodeId.set(node.nodeId, objectHash);
  }

  const manifest: BundleManifest = {
    version: BUNDLE_VERSION,
    root: {
      nodeId: root.nodeId,
      workflowName: root.config.name,
      originalWorkflowRef: root.originalWorkflowRef,
    },
    nodes: Object.fromEntries([...objectHashByNodeId].sort(([left], [right]) => left.localeCompare(right))),
    resources: Object.fromEntries([...resources].sort(([left], [right]) => left.localeCompare(right)).map(([hash, bytes]) => [
      hash,
      { kind: resourceKinds.get(hash)!, size: bytes.length },
    ])),
  };
  return { manifest, objects, resources };
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

function readBoundedFile(path: string, label: string, maxBytes: number, encoding: BufferEncoding): string {
  assertRegularFile(path, label);
  const size = lstatSync(path).size;
  if (size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return readFileSync(path, encoding);
}

interface VerifiedWorkflowBundleResource {
  readonly size: number;
  readonly bytes?: Buffer;
}

/**
 * Validate a resource through one bounded file descriptor. The descriptor
 * metadata is checked against the descriptor before any Buffer is allocated;
 * the post-read stat and digest checks close the remaining replacement and
 * content races without ever reading an unbounded file into memory.
 */
function readVerifiedWorkflowBundleResource(
  path: string,
  label: string,
  expectedHash: string,
  expectedSize: number,
  currentTotalBytes: number,
  loadResources: boolean,
): VerifiedWorkflowBundleResource {
  if (expectedSize > MAX_WORKFLOW_BUNDLE_RESOURCE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_WORKFLOW_BUNDLE_RESOURCE_BYTES}-byte limit`);
  }
  assertRegularFile(path, label);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | OPEN_NOFOLLOW);
    const before = fstatSync(fileDescriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    if (!Number.isSafeInteger(before.size)) {
      throw new Error(`${label} has an invalid size: ${path}`);
    }
    if (before.size > MAX_WORKFLOW_BUNDLE_RESOURCE_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_WORKFLOW_BUNDLE_RESOURCE_BYTES}-byte limit`);
    }
    if (before.size !== expectedSize) {
      throw new Error(`${label} size does not match its manifest descriptor`);
    }
    const totalBytes = currentTotalBytes + before.size;
    if (totalBytes > MAX_WORKFLOW_BUNDLE_RESOURCES_BYTES) {
      throw new Error(`Workflow bundle resources exceed the ${MAX_WORKFLOW_BUNDLE_RESOURCES_BYTES}-byte limit`);
    }
    if (!loadResources) return { size: before.size };

    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(fileDescriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while it was being read`);
      offset += bytesRead;
    }
    const after = fstatSync(fileDescriptor);
    if (!after.isFile() || after.size !== before.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    if (sha256(bytes) !== expectedHash) {
      throw new Error(`${label} failed integrity validation`);
    }
    return { size: before.size, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file: ${path}`);
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function assertRegularDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory: ${path}`);
}

function writePreparedBundle(bundleRoot: string, prepared: PreparedWorkflowExecutionBundle): void {
  mkdirSync(join(bundleRoot, 'objects'), { recursive: true, mode: 0o700 });
  mkdirSync(join(bundleRoot, 'resources'), { recursive: true, mode: 0o700 });
  for (const [hash, encoded] of prepared.objects) {
    writeFileSync(join(bundleRoot, 'objects', `${hash}.json`), `${encoded}\n`, { mode: 0o600 });
  }
  for (const [hash, bytes] of prepared.resources) {
    writeFileSync(join(bundleRoot, 'resources', hash), bytes, { mode: 0o600 });
  }
  const manifest = canonicalJson(prepared.manifest);
  writeFileSync(join(bundleRoot, 'manifest.json'), `${manifest}\n`, { mode: 0o600 });
  writeFileSync(join(bundleRoot, 'manifest.sha256'), `${sha256(manifest)}\n`, { mode: 0o600 });
}

export function publishWorkflowExecutionBundle(
  runPaths: RunPaths,
  prepared: PreparedWorkflowExecutionBundle,
): void {
  if (existsSync(runPaths.workflowBundleAbs)) {
    throw new Error(`Workflow execution bundle already exists for run "${runPaths.slug}"`);
  }
  mkdirSync(dirname(runPaths.workflowBundleAbs), { recursive: true });
  const temporary = mkdtempSync(join(dirname(runPaths.workflowBundleAbs), '.workflow-bundle-'));
  try {
    writePreparedBundle(temporary, prepared);
    renameSync(temporary, runPaths.workflowBundleAbs);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} has unknown or missing fields`);
}

function parseManifest(value: unknown): BundleManifest {
  const raw = requireRecord(value, 'Workflow bundle manifest');
  requireExactKeys(raw, ['version', 'root', 'nodes', 'resources'], 'Workflow bundle manifest');
  if (raw.version !== BUNDLE_VERSION) throw new Error('Unsupported workflow bundle version');
  const root = requireRecord(raw.root, 'Workflow bundle root');
  requireExactKeys(root, ['nodeId', 'workflowName', 'originalWorkflowRef'], 'Workflow bundle root');
  const nodesRaw = requireRecord(raw.nodes, 'Workflow bundle nodes');
  const resourcesRaw = requireRecord(raw.resources, 'Workflow bundle resources');
  const nodes: Record<string, string> = {};
  for (const [nodeId, objectHash] of Object.entries(nodesRaw)) {
    nodes[requireSha256(nodeId, 'Workflow bundle node id')] = requireSha256(objectHash, 'Workflow bundle object hash');
  }
  const resources: Record<string, BundleManifest['resources'][string]> = {};
  for (const [hash, entryValue] of Object.entries(resourcesRaw)) {
    const entry = requireRecord(entryValue, `Workflow bundle resource ${hash}`);
    requireExactKeys(entry, ['kind', 'size'], `Workflow bundle resource ${hash}`);
    if (!['prompt', 'arpeggio-source'].includes(entry.kind as string)) {
      throw new Error(`Workflow bundle resource ${hash} has invalid kind`);
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw new Error(`Workflow bundle resource ${hash} has invalid size`);
    }
    resources[requireSha256(hash, 'Workflow bundle resource hash')] = {
      kind: entry.kind as BundleManifest['resources'][string]['kind'],
      size: entry.size as number,
    };
  }
  const workflowName = root.workflowName;
  const originalWorkflowRef = root.originalWorkflowRef;
  if (typeof workflowName !== 'string' || workflowName.length === 0) throw new Error('Workflow bundle root name is invalid');
  if (typeof originalWorkflowRef !== 'string' || originalWorkflowRef.length === 0) throw new Error('Workflow bundle root ref is invalid');
  return {
    version: 1,
    root: { nodeId: requireSha256(root.nodeId, 'Workflow bundle root node id'), workflowName, originalWorkflowRef },
    nodes,
    resources,
  };
}

function parseNode(value: unknown): BundleNodeObject {
  const raw = requireRecord(value, 'Workflow bundle node');
  requireExactKeys(raw, ['version', 'nodeId', 'originalWorkflowRef', 'binding', 'config', 'calls'], 'Workflow bundle node');
  if (raw.version !== 1) throw new Error('Unsupported workflow bundle node version');
  if (typeof raw.originalWorkflowRef !== 'string' || raw.originalWorkflowRef.length === 0) {
    throw new Error('Workflow bundle node originalWorkflowRef is invalid');
  }
  const config = requireRecord(raw.config, 'Workflow bundle workflow config');
  if (typeof config.name !== 'string' || !Array.isArray(config.steps) || typeof config.initialStep !== 'string') {
    throw new Error('Workflow bundle workflow config is invalid');
  }
  if (!Array.isArray(raw.calls)) throw new Error('Workflow bundle calls must be an array');
  const calls = raw.calls.map((value, index): BundleCallEdge => {
    const edge = requireRecord(value, `Workflow bundle call[${index}]`);
    requireExactKeys(edge, ['stepPath', 'childNodeId', 'call', 'args'], `Workflow bundle call[${index}]`);
    if (!Array.isArray(edge.stepPath) || edge.stepPath.some((part) => typeof part !== 'string' && !Number.isSafeInteger(part))) {
      throw new Error(`Workflow bundle call[${index}] stepPath is invalid`);
    }
    if (typeof edge.call !== 'string' || edge.call.length === 0) throw new Error(`Workflow bundle call[${index}] call is invalid`);
    const args = structuredClone(requireRecord(edge.args, `Workflow bundle call[${index}] args`));
    for (const [key, argument] of Object.entries(args)) {
      const parsed = WorkflowCallArgValueRawSchema.safeParse(argument);
      if (!parsed.success) {
        throw new Error(`Workflow bundle call[${index}] argument "${key}" is invalid`);
      }
      args[key] = parsed.data;
    }
    return {
      stepPath: edge.stepPath as (string | number)[],
      childNodeId: requireSha256(edge.childNodeId, `Workflow bundle call[${index}] child node id`),
      call: edge.call,
      args: args as Record<string, WorkflowCallArgValue>,
    };
  });
  return {
    version: 1,
    nodeId: requireSha256(raw.nodeId, 'Workflow bundle node id'),
    originalWorkflowRef: raw.originalWorkflowRef,
    binding: toJsonValue(raw.binding),
    config: toJsonValue(config),
    calls,
  };
}

function rebindResourcePath(
  value: unknown,
  key: string,
  expectedKind: BundleManifest['resources'][string]['kind'],
  manifest: BundleManifest,
  resourceRoot: string,
  usedResources: Set<string>,
): string {
  if (typeof value !== 'string') throw new Error(`Workflow bundle ${key} must be a resource reference`);
  const hash = parseResourceRef(value);
  if (hash === undefined || manifest.resources[hash]?.kind !== expectedKind) {
    throw new Error(`Workflow bundle ${key} does not reference a declared ${expectedKind} resource`);
  }
  usedResources.add(hash);
  return join(resourceRoot, hash);
}

function rebindWorkflowResourcePaths(
  config: WorkflowConfig,
  manifest: BundleManifest,
  resourceRoot: string,
  usedResources: Set<string>,
): void {
  const rebindPersona = (owner: { personaPath?: string }): void => {
    if (owner.personaPath === undefined) return;
    owner.personaPath = rebindResourcePath(
      owner.personaPath,
      'personaPath',
      'prompt',
      manifest,
      resourceRoot,
      usedResources,
    );
  };
  walkSteps(config.steps, (step) => {
    if (step.kind !== undefined && step.kind !== 'agent') return;
    rebindPersona(step);
    for (const { selector } of getSelectorOwners(step)) {
      rebindPersona(selector);
    }
    if (step.teamLeader !== undefined) {
      rebindPersona(step.teamLeader);
      if (step.teamLeader.partPersonaPath !== undefined) {
        step.teamLeader.partPersonaPath = rebindResourcePath(
          step.teamLeader.partPersonaPath,
          'partPersonaPath',
          'prompt',
          manifest,
          resourceRoot,
          usedResources,
        );
      }
    }
    if (step.arpeggio !== undefined) {
      const sourcePath = rebindResourcePath(
        step.arpeggio.sourcePath,
        'sourcePath',
        'arpeggio-source',
        manifest,
        resourceRoot,
        usedResources,
      );
      const templatePath = rebindResourcePath(
        step.arpeggio.templatePath,
        'templatePath',
        'prompt',
        manifest,
        resourceRoot,
        usedResources,
      );
      step.arpeggio = { ...step.arpeggio, sourcePath, templatePath };
    }
  });
  for (const monitor of config.loopMonitors ?? []) rebindPersona(monitor.judge);
}

function validateMaterializedWorkflow(config: WorkflowConfig): void {
  const requireMaterializedPersona = (
    owner: { persona?: string; personaPath?: string },
    label: string,
  ): void => {
    if ((owner.persona !== undefined || owner.personaPath !== undefined)
      && owner.personaPath === undefined) {
      throw new Error(`Workflow bundle ${label} is missing its materialized persona resource`);
    }
  };
  walkSteps(config.steps, (step) => {
    if (step.kind !== undefined && step.kind !== 'agent') return;
    requireMaterializedPersona(step, `step "${step.name}"`);
    for (const { selector, label } of getSelectorOwners(step)) {
      requireMaterializedPersona(selector, label);
    }
    if (step.teamLeader !== undefined) {
      requireMaterializedPersona(step.teamLeader, `team leader "${step.name}"`);
      if (step.teamLeader.partPersona !== undefined && step.teamLeader.partPersonaPath === undefined) {
        throw new Error(`Workflow bundle team leader "${step.name}" is missing its part persona resource`);
      }
    }
    if (step.arpeggio?.source !== undefined && step.arpeggio.source !== 'csv') {
      throw new Error(`Workflow bundle contains unsupported arpeggio source "${step.arpeggio.source}"`);
    }
    if (step.arpeggio?.merge.file !== undefined) {
      throw new Error('Workflow bundle contains a live arpeggio merge file reference');
    }
  });
  for (const [index, monitor] of (config.loopMonitors ?? []).entries()) {
    requireMaterializedPersona(monitor.judge, `loop monitor ${index + 1} judge`);
  }
}

function pathKey(path: StepPath): string {
  return canonicalJson(path);
}

function loadWorkflowExecutionBundleInternal(
  runPaths: RunPaths,
  loadResources: boolean,
): LoadedWorkflowExecutionBundle {
  if (!existsSync(runPaths.workflowBundleAbs)) throw new Error(`Workflow execution bundle is missing for run "${runPaths.slug}"`);
  assertRegularDirectory(runPaths.workflowBundleAbs, 'Workflow execution bundle root');
  assertRegularDirectory(runPaths.workflowBundleObjectsAbs, 'Workflow execution bundle objects');
  assertRegularDirectory(runPaths.workflowBundleResourcesAbs, 'Workflow execution bundle resources');
  const expectedRootEntries = ['manifest.json', 'manifest.sha256', 'objects', 'resources'];
  if (canonicalJson(readdirSync(runPaths.workflowBundleAbs).sort()) !== canonicalJson(expectedRootEntries)) {
    throw new Error('Workflow execution bundle root contains unknown or missing entries');
  }
  assertRegularFile(runPaths.workflowBundleManifestAbs, 'Workflow bundle manifest');
  assertRegularFile(runPaths.workflowBundleManifestHashAbs, 'Workflow bundle manifest hash');
  const manifestRaw = readBoundedFile(
    runPaths.workflowBundleManifestAbs,
    'Workflow bundle manifest',
    MAX_WORKFLOW_BUNDLE_MANIFEST_BYTES,
    'utf-8',
  );
  const manifestParsed = JSON.parse(manifestRaw) as unknown;
  const manifestText = canonicalJson(manifestParsed);
  if (manifestRaw !== `${manifestText}\n`) throw new Error('Workflow execution bundle manifest is not canonical JSON');
  const manifestHashRaw = readBoundedFile(
    runPaths.workflowBundleManifestHashAbs,
    'Workflow bundle manifest hash',
    128,
    'utf-8',
  );
  const expectedManifestHash = requireSha256(manifestHashRaw.trim(), 'Workflow bundle manifest hash');
  if (manifestHashRaw !== `${expectedManifestHash}\n`) throw new Error('Workflow execution bundle manifest hash file is not canonical');
  if (sha256(manifestText) !== expectedManifestHash) {
    throw new Error('Workflow execution bundle manifest hash mismatch');
  }
  const manifest = parseManifest(manifestParsed);
  const expectedObjectFiles = new Set(Object.values(manifest.nodes).map((hash) => `${hash}.json`));
  const actualObjectFiles = new Set(readdirSync(runPaths.workflowBundleObjectsAbs));
  if (canonicalJson([...actualObjectFiles].sort()) !== canonicalJson([...expectedObjectFiles].sort())) {
    throw new Error('Workflow execution bundle object set does not match manifest');
  }
  const expectedResourceFiles = new Set(Object.keys(manifest.resources));
  const actualResourceFiles = new Set(readdirSync(runPaths.workflowBundleResourcesAbs));
  if (canonicalJson([...actualResourceFiles].sort()) !== canonicalJson([...expectedResourceFiles].sort())) {
    throw new Error('Workflow execution bundle resource set does not match manifest');
  }
  const resources = new Map<string, Buffer>();
  let resourceBytes = 0;
  for (const [hash, descriptor] of Object.entries(manifest.resources)) {
    const path = join(runPaths.workflowBundleResourcesAbs, hash);
    const verified = readVerifiedWorkflowBundleResource(
      path,
      `Workflow bundle resource ${hash}`,
      hash,
      descriptor.size,
      resourceBytes,
      loadResources,
    );
    resourceBytes += verified.size;
    if (verified.bytes !== undefined) resources.set(hash, verified.bytes);
  }
  const nodes = new Map<string, { object: BundleNodeObject; config: WorkflowConfig }>();
  const objects = new Map<string, string>();
  const usedResources = new Set<string>();
  for (const [nodeId, objectHash] of Object.entries(manifest.nodes)) {
    const path = join(runPaths.workflowBundleObjectsAbs, `${objectHash}.json`);
    const raw = readBoundedFile(
      path,
      `Workflow bundle object ${objectHash}`,
      MAX_WORKFLOW_BUNDLE_OBJECT_BYTES,
      'utf-8',
    );
    const parsed = JSON.parse(raw) as unknown;
    const encoded = canonicalJson(parsed);
    if (raw !== `${encoded}\n`) throw new Error(`Workflow bundle object ${objectHash} is not canonical JSON`);
    if (sha256(encoded) !== objectHash) throw new Error(`Workflow bundle object ${objectHash} failed integrity validation`);
    const object = parseNode(parsed);
    if (object.nodeId !== nodeId) throw new Error(`Workflow bundle node ${nodeId} has mismatched identity`);
    if (buildNodeId(object.originalWorkflowRef, object.config, object.binding) !== nodeId) {
      throw new Error(`Workflow bundle node ${nodeId} failed logical identity validation`);
    }
    const config = structuredClone(object.config) as unknown as WorkflowConfig;
    rebindWorkflowResourcePaths(
      config,
      manifest,
      runPaths.workflowBundleResourcesAbs,
      usedResources,
    );
    validateMaterializedWorkflow(config);
    attachWorkflowOpaqueRef(config, object.originalWorkflowRef);
    attachWorkflowBundleNodeId(config, nodeId);
    nodes.set(nodeId, { object, config });
    objects.set(objectHash, encoded);
  }
  if (canonicalJson([...usedResources].sort()) !== canonicalJson(Object.keys(manifest.resources).sort())) {
    throw new Error('Workflow execution bundle contains unused resources');
  }
  const root = nodes.get(manifest.root.nodeId);
  if (root === undefined || root.config.name !== manifest.root.workflowName || getWorkflowReference(root.config) !== manifest.root.originalWorkflowRef) {
    throw new Error('Workflow execution bundle root identity is invalid');
  }
  if (canonicalJson(root.object.binding) !== canonicalJson(buildBinding(undefined))) {
    throw new Error('Workflow execution bundle root binding is invalid');
  }
  for (const [nodeId, node] of nodes) {
    const calls = collectWorkflowCalls(node.config);
    if (calls.length !== node.object.calls.length) throw new Error(`Workflow bundle node ${nodeId} does not cover every workflow_call`);
    const callsByPath = new Map(calls.map((call) => [pathKey(call.stepPath), call]));
    const expectedPaths = new Set(callsByPath.keys());
    const actualPaths = new Set(node.object.calls.map(({ stepPath }) => pathKey(stepPath)));
    if (canonicalJson([...expectedPaths].sort()) !== canonicalJson([...actualPaths].sort())) {
      throw new Error(`Workflow bundle node ${nodeId} call mapping is incomplete`);
    }
    for (const edge of node.object.calls) {
      const call = callsByPath.get(pathKey(edge.stepPath))!;
      if (edge.call !== call.step.call || canonicalJson(edge.args) !== canonicalJson(call.step.args ?? {})) {
        throw new Error(`Workflow bundle node ${nodeId} call edge does not match its workflow config`);
      }
      const child = nodes.get(edge.childNodeId);
      if (child === undefined) throw new Error(`Workflow bundle node ${nodeId} references missing child ${edge.childNodeId}`);
      if (canonicalJson(child.object.binding) !== canonicalJson(buildBinding(call.step))) {
        throw new Error(`Workflow bundle child ${edge.childNodeId} has mismatched call binding`);
      }
    }
  }
  const reachable = new Set<string>();
  const pending = [manifest.root.nodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of nodes.get(nodeId)!.object.calls) pending.push(edge.childNodeId);
  }
  if (reachable.size !== nodes.size) {
    throw new Error('Workflow execution bundle contains unreachable nodes');
  }
  const workflowCallResolver: WorkflowCallResolver = ({ parentWorkflow, step }) => {
    const nodeId = getAttachedWorkflowBundleNodeId(parentWorkflow);
    if (nodeId === undefined) throw new Error('Workflow bundle resolver received an unbound parent workflow');
    const node = nodes.get(nodeId)!;
    const stepPath = findWorkflowStepLocation(parentWorkflow, step);
    if (stepPath === undefined) throw new Error(`Workflow bundle resolver could not locate step "${step.name}"`);
    if (stepPath.some((part) => typeof part !== 'string' && typeof part !== 'number')) {
      throw new Error(`Workflow bundle resolver found an unsupported path for step "${step.name}"`);
    }
    const edge = node.object.calls.find((candidate) => pathKey(candidate.stepPath) === pathKey(stepPath as StepPath));
    if (edge === undefined) throw new Error(`Workflow bundle has no child for step "${step.name}"`);
    return nodes.get(edge.childNodeId)!.config;
  };
  return {
    manifest,
    rootWorkflow: root.config,
    workflows: [...nodes.values()].map(({ config }) => config),
    workflowCallResolver,
    prepared: { manifest, objects, resources },
    resourceRoot: runPaths.workflowBundleResourcesAbs,
  };
}

export function loadWorkflowExecutionBundle(runPaths: RunPaths): LoadedWorkflowExecutionBundle {
  return loadWorkflowExecutionBundleInternal(runPaths, true);
}

/**
 * Validate the persisted bundle identity and workflow graph for read-only
 * inspection without materializing any prompt/arpeggio resource bytes.
 */
export function loadWorkflowExecutionBundleMetadata(
  runPaths: RunPaths,
): LoadedWorkflowExecutionBundleMetadata {
  const loaded = loadWorkflowExecutionBundleInternal(runPaths, false);
  return {
    manifest: loaded.manifest,
    rootWorkflow: loaded.rootWorkflow,
    workflows: loaded.workflows,
  };
}

/**
 * Read-only consumers such as the Web UI intentionally fail closed when a
 * legacy, missing, or corrupted bundle cannot pass the same validation used
 * by execution.  Execution callers should continue using the throwing loader
 * so corruption remains visible at the execution boundary.
 */
export function tryLoadWorkflowExecutionBundle(
  runPaths: RunPaths,
): LoadedWorkflowExecutionBundle | undefined {
  try {
    return loadWorkflowExecutionBundle(runPaths);
  } catch {
    return undefined;
  }
}

export function tryLoadWorkflowExecutionBundleMetadata(
  runPaths: RunPaths,
): LoadedWorkflowExecutionBundleMetadata | undefined {
  try {
    return loadWorkflowExecutionBundleMetadata(runPaths);
  } catch {
    return undefined;
  }
}
