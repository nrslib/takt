import { dirname, relative, resolve } from 'node:path';
import {
  getBuiltinFacetDir,
  getGlobalFacetDir,
  getProjectFacetDir,
  getRepertoireDir,
  loadGlobalConfig,
  loadProjectConfig,
  resolveWorkflowConfigValue,
  resolveWorkflowSelector,
  type SelectorProviderOverrides,
} from '../../infra/config/index.js';
import {
  inspectWorkflowFile,
  resolveWorkflowDoctorTargets,
  type WorkflowDoctorReport,
} from '../../infra/config/loaders/workflowDoctor.js';
import { reportHasErrors, validateWorkflowRuntimeContract } from './doctor.js';
import {
  resolveRefToContentWithSource,
  type FacetResolutionContext,
  type ResolvedFacetContent,
} from '../../infra/config/loaders/resource-resolver.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../../infra/config/runtime-provider/provider-environment.js';
import { applyRuntimeProviderOverride } from '../../infra/config/runtime-provider/override.js';
import type { CompiledProviderEnvironment } from '../../infra/config/runtime-provider/environment.js';
import { resolveWorkflowCallTarget } from '../../infra/config/loaders/workflowCallResolver.js';
import {
  getWorkflowResolvedSectionMap,
  getWorkflowSourcePath,
} from '../../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowReference } from '../../core/workflow/workflow-reference.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import { createTeamLeaderPlanningStep } from '../../core/workflow/engine/team-leader-common.js';
import { resolveStepProviderModel, type StepProviderModelOutput } from '../../core/workflow/provider-resolution.js';
import {
  applyAutoRoutingStrategyOverride,
  resolveDeterministicAutoRoutingProviderInfo,
} from '../../core/workflow/auto-routing/resolver.js';
import { withWorkflowTargetContext } from '../../core/workflow/provider-target-resolution.js';
import {
  DEFAULT_PROVIDER_PERMISSION_PROFILES,
  resolveStepPermissionModeWithSource,
} from '../../core/workflow/permission-profile-resolution.js';
import {
  resolveSelectorPermissionMode,
  type SelectorPermissionSource,
} from '../../core/workflow/selector-permission-resolution.js';
import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type TeamLeaderConfig,
  type WorkflowStep,
} from '../../core/models/index.js';
import { getWorkflowStepKind } from '../../core/models/workflow-step-kind.js';
import type { ProviderResolutionSource } from '../../core/workflow/provider-options-trace.js';
import { redactProviderOptions } from '../../core/workflow/providerOptionsRedaction.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { error, header, info, success, warn } from '../../shared/ui/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../shared/utils/index.js';

const DISPLAY_DEPTH_LIMIT = MAX_WORKFLOW_CALL_DEPTH;

interface DisplayFacet {
  ref: string;
  path?: string;
  source: 'builtin' | 'project' | 'global' | 'fragment';
}

interface RuntimeDisplayContext {
  readonly workflow: WorkflowConfig;
  readonly projectDir: string;
  readonly lookupCwd: string;
  readonly workflowDir: string;
  readonly facetContext: FacetResolutionContext;
  readonly providerEnvironment: CompiledProviderEnvironment;
  readonly projectConfig: ReturnType<typeof loadProjectConfig>;
  readonly globalConfig: ReturnType<typeof loadGlobalConfig>;
  readonly selectorOverrides: SelectorProviderOverrides | undefined;
}

interface ResolvedProviderDisplay {
  readonly provider: string | undefined;
  readonly providerSource: ProviderResolutionSource | undefined;
  readonly model: string | undefined;
  readonly modelSource: ProviderResolutionSource | undefined;
  readonly permissionValue: string;
  readonly permissionSource: ProviderResolutionSource;
}

type WorkflowCallPlanEdge =
  | { readonly note: string }
  | { readonly child: InspectPlanNode };

type WorkflowCallPlanResult =
  | { readonly edge: WorkflowCallPlanEdge }
  | { readonly diagnostic: string };

interface InspectPlanNode {
  readonly workflow: WorkflowConfig;
  readonly context: RuntimeDisplayContext;
  readonly providerDisplays: Map<WorkflowStep, ResolvedProviderDisplay>;
  readonly callEdges: Map<WorkflowStep, WorkflowCallPlanEdge>;
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const path = relative(resolve(rootPath), resolve(targetPath));
  return path === '' || (!path.startsWith('..') && !path.includes('/..'));
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return sanitizeTerminalText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return sanitizeTerminalText(JSON.stringify(value) ?? String(value));
}

function printScalar(indent: string, key: string, value: unknown): void {
  info(`${indent}${sanitizeTerminalText(key)}: ${formatValue(value)}`);
}

function isInlinePersona(ref: string | undefined, path: string | undefined): boolean {
  return ref !== undefined && path === undefined && /\s/.test(ref);
}

function sourceForPath(
  path: string | undefined,
  facetType: 'personas' | 'instructions' | 'policies' | 'knowledge' | 'output-contracts',
  context: FacetResolutionContext,
): DisplayFacet['source'] {
  if (path === undefined) {
    return 'fragment';
  }
  if (context.projectDir && isPathInside(getProjectFacetDir(context.projectDir, facetType), path)) {
    return 'project';
  }
  if (isPathInside(getGlobalFacetDir(facetType), path)) {
    return 'global';
  }
  if (isPathInside(getBuiltinFacetDir(context.lang, facetType), path)) {
    return 'builtin';
  }
  return 'fragment';
}

function toDisplayFacet(
  content: ResolvedFacetContent | undefined,
  fallbackRef: string,
  facetType: 'personas' | 'instructions' | 'policies' | 'knowledge' | 'output-contracts',
  context: FacetResolutionContext,
): DisplayFacet {
  const isInline = content?.sourcePath === undefined
    && content?.literalContent === true;
  return {
    ref: isInline ? 'inline' : content?.refName ?? fallbackRef,
    ...(content?.sourcePath === undefined ? {} : { path: content.sourcePath }),
    source: sourceForPath(content?.sourcePath, facetType, context),
  };
}

function resolveFacetReference(
  ref: string,
  workflow: WorkflowConfig,
  context: RuntimeDisplayContext,
  facetType: 'instructions' | 'output-contracts',
): DisplayFacet {
  const resolvedMap = getWorkflowResolvedSectionMap(workflow, facetType);
  const resolved = resolveRefToContentWithSource(
    ref,
    resolvedMap,
    context.workflowDir,
    facetType,
    context.facetContext,
  );
  if (resolved?.sourcePath !== undefined) {
    return toDisplayFacet(resolved, ref, facetType, context.facetContext);
  }
  if (resolvedMap?.[ref] !== undefined) {
    return toDisplayFacet(resolved, ref, facetType, context.facetContext);
  }
  if (/\s/.test(ref)) {
    return { ref: 'inline', source: 'fragment' };
  }
  const inlineContent = facetType === 'instructions'
    ? workflow.instructions?.[ref]
    : workflow.reportFormats?.[ref];
  return toDisplayFacet(
    inlineContent === undefined ? resolved : { content: inlineContent, refName: ref },
    ref,
    facetType,
    context.facetContext,
  );
}

function displayFacetContents(
  indent: string,
  field: string,
  values: readonly ResolvedFacetContent[] | undefined,
  facetType: 'policies' | 'knowledge',
  context: RuntimeDisplayContext,
): void {
  if (values === undefined || values.length === 0) {
    printScalar(indent, field, 'not configured');
    return;
  }
  info(`${indent}${field}:`);
  for (const value of values) {
    const facet = toDisplayFacet(value, 'inline', facetType, context.facetContext);
    printScalar(`${indent}  - `, 'ref', facet.ref);
    printScalar(`${indent}    `, 'source', facet.source);
    if (facet.path !== undefined) {
      printScalar(`${indent}    `, 'path', facet.path);
    }
  }
}

function instructionRefs(step: WorkflowStep): string[] {
  const value = step.instructionRef;
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value];
}

function displayInstructions(indent: string, step: WorkflowStep, context: RuntimeDisplayContext): void {
  const refs = instructionRefs(step);
  if (refs.length === 0) {
    printScalar(indent, 'instruction', 'not configured');
    return;
  }
  info(`${indent}instruction:`);
  for (const ref of refs) {
    const facet = resolveFacetReference(ref, context.workflow, context, 'instructions');
    printScalar(`${indent}  - `, 'ref', facet.ref);
    printScalar(`${indent}    `, 'source', facet.source);
    if (facet.path !== undefined) {
      printScalar(`${indent}    `, 'path', facet.path);
    }
  }
}

function displayCompletionRetry(indent: string, step: WorkflowStep, context: RuntimeDisplayContext): void {
  if (step.completionRetry === undefined) {
    return;
  }
  info(`${indent}completionRetry:`);
  printScalar(`${indent}  `, 'minRetry', step.completionRetry.minRetry);
  printScalar(`${indent}  `, 'maxRetry', step.completionRetry.maxRetry);
  const reference = step.completionRetry.retryInstructionRef!;
  const facet = resolveFacetReference(reference, context.workflow, context, 'instructions');
  printScalar(`${indent}  `, 'retryInstruction', facet.ref);
  printScalar(`${indent}  `, 'source', facet.source);
  if (facet.path !== undefined) {
    printScalar(`${indent}  `, 'path', facet.path);
  }
}

function printFacetReference(
  indent: string,
  field: string,
  ref: string | undefined,
  path: string | undefined,
  facetType: 'personas' | 'instructions' | 'policies' | 'knowledge' | 'output-contracts',
  context: RuntimeDisplayContext,
): void {
  if (ref === undefined && path === undefined) {
    return;
  }
  const facet = toDisplayFacet(
    path === undefined ? undefined : { content: '', sourcePath: path, refName: ref },
    isInlinePersona(ref, path) ? 'inline' : ref ?? 'inline',
    facetType,
    context.facetContext,
  );
  printScalar(indent, field, facet.ref);
  printScalar(`${indent}  `, 'source', facet.source);
  if (facet.path !== undefined) {
    printScalar(`${indent}  `, 'path', facet.path);
  }
}

function displaySelectorGuidance(indent: string, selector: {
  readonly persona?: string;
  readonly personaPath?: string;
  readonly personaRef?: string;
  readonly instruction: string;
  readonly instructionRef?: string;
}, context: RuntimeDisplayContext): void {
  printFacetReference(indent, 'persona', selector.personaRef, selector.personaPath, 'personas', context);
  const facet = resolveFacetReference(selector.instructionRef!, context.workflow, context, 'instructions');
  printScalar(indent, 'instruction', facet.ref);
  printScalar(`${indent}  `, 'source', facet.source);
  if (facet.path !== undefined) {
    printScalar(`${indent}  `, 'path', facet.path);
  }
}

function displayDynamicFacets(indent: string, step: WorkflowStep, context: RuntimeDisplayContext): void {
  const dynamicFacets = 'dynamicFacets' in step ? step.dynamicFacets : undefined;
  if (dynamicFacets === undefined) {
    return;
  }
  info(`${indent}dynamicFacets:`);
  printScalar(`${indent}  `, 'pool', dynamicFacets.pool);
  if (dynamicFacets.maxSelected !== undefined) {
    printScalar(`${indent}  `, 'maxSelected', dynamicFacets.maxSelected);
  }
  if (dynamicFacets.selector !== undefined) {
    info(`${indent}  selector:`);
    displaySelectorGuidance(`${indent}    `, dynamicFacets.selector, context);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function printYamlLike(indent: string, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      printScalar(indent, key, '[]');
      return;
    }
    info(`${indent}${sanitizeTerminalText(key)}:`);
    for (const item of value) {
      const record = objectRecord(item);
      if (record === undefined) {
        info(`${indent}  - ${formatValue(item)}`);
        continue;
      }
      info(`${indent}  -`);
      for (const [childKey, childValue] of Object.entries(record)) {
        if (childKey === 'content') {
          continue;
        }
        printYamlLike(`${indent}    `, childKey, childValue);
      }
    }
    return;
  }
  const record = objectRecord(value);
  if (record !== undefined) {
    info(`${indent}${sanitizeTerminalText(key)}:`);
    for (const [childKey, childValue] of Object.entries(record)) {
      if (childKey === 'content') {
        continue;
      }
      printYamlLike(`${indent}  `, childKey, childValue);
    }
    return;
  }
  printScalar(indent, key, value);
}

function displayOutputContracts(indent: string, step: WorkflowStep, context: RuntimeDisplayContext): void {
  if (step.outputContracts === undefined) {
    return;
  }
  info(`${indent}outputContracts:`);
  for (const contract of step.outputContracts) {
    info(`${indent}  -`);
    printScalar(`${indent}    `, 'name', contract.name);
    printScalar(`${indent}    `, 'useJudge', contract.useJudge);
    if (contract.formatRef !== undefined) {
      const facet = resolveFacetReference(contract.formatRef, context.workflow, context, 'output-contracts');
      printScalar(`${indent}    `, 'format', facet.ref);
      printScalar(`${indent}    `, 'formatSource', facet.source);
      if (facet.path !== undefined) {
        printScalar(`${indent}    `, 'formatPath', facet.path);
      }
    } else {
      printScalar(`${indent}    `, 'format', 'configured');
    }
    if (contract.orderRef !== undefined) {
      const facet = resolveFacetReference(contract.orderRef, context.workflow, context, 'output-contracts');
      printScalar(`${indent}    `, 'order', facet.ref);
      printScalar(`${indent}    `, 'orderSource', facet.source);
      if (facet.path !== undefined) {
        printScalar(`${indent}    `, 'orderPath', facet.path);
      }
    }
  }
}

function displayTeamLeader(indent: string, teamLeader: TeamLeaderConfig, context: RuntimeDisplayContext): void {
  info(`${indent}teamLeader:`);
  for (const [key, value] of Object.entries(teamLeader)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'persona') {
      printFacetReference(
        `${indent}  `,
        'persona',
        teamLeader.providerRoutingPersonaKey,
        teamLeader.personaPath,
        'personas',
        context,
      );
      continue;
    }
    if (key === 'personaPath') {
      continue;
    }
    if (key === 'partPersona') {
      printFacetReference(
        `${indent}  `,
        'partPersona',
        teamLeader.partPersonaRef,
        teamLeader.partPersonaPath,
        'personas',
        context,
      );
      continue;
    }
    if (key === 'partPersonaPath') {
      continue;
    }
    if (key === 'partPersonaRef') {
      continue;
    }
    if (key === 'personaDisplayName' || key === 'providerRoutingPersonaKey') {
      printScalar(
        `${indent}  `,
        key,
        isInlinePersona(teamLeader.persona, teamLeader.personaPath) ? 'inline' : value,
      );
      continue;
    }
    printYamlLike(`${indent}  `, key, value);
  }
}

function displayStep(
  indent: string,
  step: WorkflowStep,
  context: RuntimeDisplayContext,
  node: InspectPlanNode,
  label = '-',
): void {
  const record = step as unknown as Record<string, unknown>;
  info(`${indent}${label} name: ${formatValue(step.name)}`);
  displayInstructions(`${indent}  `, step, context);
  printFacetReference(
    `${indent}  `,
    'persona',
    step.providerRoutingPersonaKey,
    step.personaPath,
    'personas',
    context,
  );
  displayFacetContents(
    `${indent}  `,
    'policy',
    record.policyContents as ResolvedFacetContent[] | undefined,
    'policies',
    context,
  );
  displayFacetContents(
    `${indent}  `,
    'knowledge',
    record.knowledgeContents as ResolvedFacetContent[] | undefined,
    'knowledge',
    context,
  );

  const entries = Object.entries(record);
  for (const [key, value] of entries) {
    if (
      value === undefined
      || key === 'name'
      || key === 'instruction'
      || key === 'instructionRef'
      || key === 'persona'
      || key === 'personaPath'
      || key === 'policyContents'
      || key === 'knowledgeContents'
      || key === 'outputContracts'
      || key === 'completionRetry'
      || key === 'parallel'
      || key === 'dynamicFacets'
      || key === 'teamLeader'
      || key === 'provider'
      || key === 'model'
      || key === 'providerSource'
      || key === 'modelSource'
    ) {
      continue;
    }
    if (key === 'personaDisplayName' || key === 'providerRoutingPersonaKey') {
      printScalar(
        `${indent}  `,
        key,
        isInlinePersona(step.persona, step.personaPath) ? 'inline' : value,
      );
      continue;
    }
    if (key === 'providerOptions' || key === 'internalProviderOptions' || key === 'capabilityProviderOptions') {
      printYamlLike(`${indent}  `, key, redactProviderOptions(value as Record<string, unknown>));
      continue;
    }
    printYamlLike(`${indent}  `, key, value);
  }

  if (step.teamLeader !== undefined) {
    displayTeamLeader(`${indent}  `, step.teamLeader, context);
  }
  displayOutputContracts(`${indent}  `, step, context);
  displayCompletionRetry(`${indent}  `, step, context);
  displayResolvedProvider(`${indent}  `, step, node);
  displayDynamicFacets(`${indent}  `, step, context);

  if (step.parallel !== undefined) {
    info(`${indent}  parallel:`);
    if (isDynamicParallelSubSteps(step.parallel)) {
      printScalar(`${indent}    `, 'kind', step.parallel.kind);
      printScalar(`${indent}    `, 'selectionMode', step.parallel.selection.mode);
      if (step.parallel.selection.reports !== undefined) {
        printYamlLike(`${indent}    `, 'reports', step.parallel.selection.reports);
      }
      if (step.parallel.selection.selector !== undefined) {
        info(`${indent}    selector:`);
        displaySelectorGuidance(`${indent}      `, step.parallel.selection.selector, context);
      }
      info(`${indent}    fixed:`);
      for (const subStep of step.parallel.fixed) {
        displayStep(`${indent}      `, subStep, context, node);
      }
      info(`${indent}    pool:`);
      for (const subStep of step.parallel.pool) {
        displayStep(`${indent}      `, subStep, context, node);
      }
    } else {
      for (const subStep of step.parallel) {
        displayStep(`${indent}    `, subStep, context, node);
      }
    }
  }
  if (step.kind === 'workflow_call') {
    displayWorkflowCall(indent, step, node);
  }
}

function displayResolvedProvider(indent: string, step: WorkflowStep, node: InspectPlanNode): void {
  if (getWorkflowStepKind(step) !== 'agent') {
    return;
  }
  const resolved = node.providerDisplays.get(step);
  if (resolved === undefined) {
    throw new Error(`Provider display resolution is missing for step "${step.name}"`);
  }
  printScalar(indent, 'provider', formatResolvedValue(resolved.provider, resolved.providerSource));
  printScalar(indent, 'model', formatResolvedValue(resolved.model, resolved.modelSource));
  printScalar(indent, 'permissionMode', formatResolvedValue(resolved.permissionValue, resolved.permissionSource));
}

function resolveProviderDisplay(step: WorkflowStep, context: RuntimeDisplayContext): ResolvedProviderDisplay {
  const providerResolutionStep = step.teamLeader === undefined
    ? step
    : createTeamLeaderPlanningStep(step);
  const autoRouting = context.providerEnvironment.autoRouting;
  const resolution = resolveStepProviderModel({
    step: providerResolutionStep,
    provider: context.providerEnvironment.provider,
    providerSource: context.providerEnvironment.providerSource,
    model: context.providerEnvironment.model,
    modelSource: context.providerEnvironment.modelSource,
    autoRouting: withWorkflowTargetContext(autoRouting, context.workflow.name),
    providerRouting: withWorkflowTargetContext(context.providerEnvironment.providerRouting, context.workflow.name),
    tagConflictPolicy: context.providerEnvironment.tagConflictPolicy,
    personaProviders: context.providerEnvironment.personaProviders,
    permissionMode: context.providerEnvironment.permissionMode,
  });
  let resolved = resolution;
  if (autoRouting !== undefined) {
    const contextualAutoRouting = withWorkflowTargetContext(autoRouting, context.workflow.name);
    resolved = resolveDeterministicAutoRoutingProviderInfo({
      autoRouting: contextualAutoRouting!,
      step: {
        name: providerResolutionStep.name,
        tags: providerResolutionStep.tags,
        personaKey: providerResolutionStep.providerRoutingPersonaKey,
        instruction: providerResolutionStep.instruction,
      },
      currentProviderInfo: resolution,
    }) ?? resolution;
  }
  const permission = resolvePermissionForDisplay(providerResolutionStep, resolved, context);
  return {
    provider: resolved.provider,
    providerSource: resolved.providerSource,
    model: resolved.model,
    modelSource: resolved.modelSource,
    permissionValue: permission.value,
    permissionSource: permission.source,
  };
}

function formatResolvedValue(
  value: string | undefined,
  source: ProviderResolutionSource | SelectorPermissionSource | undefined,
): string {
  return `${value === undefined ? 'not configured' : sanitizeTerminalText(value)} (source: ${source ?? 'unresolved'})`;
}

function resolvePermissionForDisplay(
  step: WorkflowStep,
  providerInfo: StepProviderModelOutput,
  context: RuntimeDisplayContext,
): { value: string; source: ProviderResolutionSource } {
  const explicitRequired = step.requiredPermissionMode ?? (step.edit === true ? 'edit' : undefined);
  if (providerInfo.permissionMode !== undefined) {
    return {
      value: providerInfo.permissionMode,
      source: providerInfo.providerSource ?? 'default',
    };
  }

  const resolvedPermission = resolveStepPermissionModeWithSource({
    stepName: step.name,
    requiredPermissionMode: explicitRequired,
    provider: providerInfo.provider,
    projectProviderProfiles: context.projectConfig.providerProfiles,
    globalProviderProfiles: context.globalConfig.providerProfiles,
    defaultProviderProfiles: DEFAULT_PROVIDER_PERMISSION_PROFILES,
  });
  return resolvedPermission;
}

function displayFacetPoolContents(
  indent: string,
  field: string,
  refs: readonly string[],
  values: readonly ResolvedFacetContent[],
  facetType: 'policies' | 'knowledge',
  context: RuntimeDisplayContext,
): void {
  if (refs.length === 0) {
    printScalar(indent, field, 'not configured');
    return;
  }
  info(`${indent}${field}:`);
  for (const [index, ref] of refs.entries()) {
    const value = values[index]!;
    const facet = toDisplayFacet(value, ref, facetType, context.facetContext);
    printScalar(`${indent}  - `, 'ref', facet.ref);
    printScalar(`${indent}    `, 'source', facet.source);
    if (facet.path !== undefined) {
      printScalar(`${indent}    `, 'path', facet.path);
    }
  }
}

function displayFacetPools(indent: string, workflow: WorkflowConfig, context: RuntimeDisplayContext): void {
  if (workflow.facetPools === undefined) {
    return;
  }
  info(`${indent}facetPools:`);
  for (const [name, pool] of Object.entries(workflow.facetPools)) {
    info(`${indent}  ${sanitizeTerminalText(name)}:`);
    printScalar(`${indent}    `, 'source', pool.source);
    info(`${indent}    candidates:`);
    for (const candidate of pool.candidates) {
      info(`${indent}      -`);
      printScalar(`${indent}        `, 'id', candidate.id);
      printScalar(`${indent}        `, 'description', candidate.description);
      displayFacetPoolContents(
        `${indent}        `,
        'policy',
        candidate.policyRefs,
        candidate.resolvedPolicyContents,
        'policies',
        context,
      );
      displayFacetPoolContents(
        `${indent}        `,
        'knowledge',
        candidate.knowledgeRefs,
        candidate.resolvedKnowledgeContents,
        'knowledge',
        context,
      );
    }
  }
}

function printWorkflowSections(indent: string, workflow: WorkflowConfig, context: RuntimeDisplayContext): void {
  const sections: Array<readonly [string, string[] | undefined]> = [
    ['personas', workflow.personas === undefined ? undefined : Object.keys(workflow.personas)],
    ['instructions', workflow.instructions === undefined ? undefined : Object.keys(workflow.instructions)],
    ['policies', workflow.policies === undefined ? undefined : Object.keys(workflow.policies)],
    ['knowledge', workflow.knowledge === undefined ? undefined : Object.keys(workflow.knowledge)],
    ['reportFormats', workflow.reportFormats === undefined ? undefined : Object.keys(workflow.reportFormats)],
  ];
  for (const [name, refs] of sections) {
    if (refs === undefined) {
      continue;
    }
    printYamlLike(indent, name, refs);
  }
  displayFacetPools(indent, workflow, context);
}

function displayLoopMonitors(indent: string, workflow: WorkflowConfig, context: RuntimeDisplayContext): void {
  if (workflow.loopMonitors === undefined) {
    return;
  }
  info(`${indent}loopMonitors:`);
  for (const monitor of workflow.loopMonitors) {
    info(`${indent}  -`);
    printYamlLike(`${indent}    `, 'cycle', monitor.cycle);
    if (monitor.ignoreSteps !== undefined) {
      printYamlLike(`${indent}    `, 'ignoreSteps', monitor.ignoreSteps);
    }
    printScalar(`${indent}    `, 'threshold', monitor.threshold);
    info(`${indent}    judge:`);
    printFacetReference(
      `${indent}      `,
      'persona',
      monitor.judge.personaRef,
      monitor.judge.personaPath,
      'personas',
      context,
    );
    if (monitor.judge.instruction !== undefined) {
      const facet = resolveFacetReference(monitor.judge.instructionRef!, context.workflow, context, 'instructions');
      printScalar(`${indent}      `, 'instruction', facet.ref);
      printScalar(`${indent}        `, 'source', facet.source);
      if (facet.path !== undefined) {
        printScalar(`${indent}        `, 'path', facet.path);
      }
    }
    printYamlLike(`${indent}      `, 'rules', monitor.judge.rules);
  }
}

function displayWorkflow(
  node: InspectPlanNode,
  indent = '',
): void {
  const { workflow, context } = node;
  const sourcePath = getWorkflowSourcePath(workflow);
  header(`${indent}Workflow inspect: ${sanitizeTerminalText(workflow.name)}`);
  printScalar(`${indent}  `, 'path', sourcePath ?? 'not available');
  printScalar(`${indent}  `, 'initialStep', workflow.initialStep);
  printScalar(`${indent}  `, 'maxSteps', workflow.maxSteps);
  if (workflow.description !== undefined) {
    printScalar(`${indent}  `, 'description', workflow.description);
  }
  if (workflow.subworkflow !== undefined) {
    printYamlLike(`${indent}  `, 'subworkflow', workflow.subworkflow);
  }
  printWorkflowSections(`${indent}  `, workflow, context);
  info(`${indent}  steps:`);
  for (const step of workflow.steps) {
    displayStep(`${indent}    `, step, context, node);
  }
  displayLoopMonitors(`${indent}  `, workflow, context);
}

function displayWorkflowCall(
  indent: string,
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
  node: InspectPlanNode,
): void {
  const edge = node.callEdges.get(step);
  if (edge === undefined) {
    throw new Error(`Workflow call plan is missing for step "${step.name}"`);
  }
  if ('note' in edge) {
    printScalar(`${indent}  `, 'workflowCall', edge.note);
    return;
  }
  displayWorkflow(edge.child, `${indent}    `);
}

function applyInspectionOverrides(
  runtime: ReturnType<typeof resolveAuxiliaryRuntimeEnvironment>,
  overrides: SelectorProviderOverrides | undefined,
): CompiledProviderEnvironment {
  if (overrides === undefined
    || (overrides.provider === undefined && overrides.model === undefined && overrides.autoStrategy === undefined)) {
    return runtime.providerEnvironment;
  }
  let providerEnvironment: CompiledProviderEnvironment;
  if (runtime.providerConfigMode === 'runtime-v1') {
    providerEnvironment = applyRuntimeProviderOverride(runtime.providerEnvironment, {
      provider: overrides.provider,
      providerSource: overrides.providerSource ?? 'cli',
      model: overrides.model,
      modelSource: overrides.modelSource ?? 'cli',
    });
  } else {
    providerEnvironment = {
      ...runtime.providerEnvironment,
      ...(overrides.provider === undefined ? {} : {
        provider: overrides.provider,
        providerSource: overrides.providerSource ?? 'cli',
      }),
      ...(overrides.model === undefined ? {} : {
        model: overrides.model,
        modelSource: overrides.modelSource ?? 'cli',
      }),
    };
  }
  return {
    ...providerEnvironment,
    autoRouting: applyAutoRoutingStrategyOverride(providerEnvironment.autoRouting, overrides.autoStrategy),
  };
}

function collectStepDisplayDiagnostics(step: WorkflowStep, diagnostics: string[]): void {
  if (step.completionRetry !== undefined && step.completionRetry.retryInstructionRef === undefined) {
    diagnostics.push(`Completion retry instruction reference is missing for step "${step.name}"`);
  }
  const dynamicFacets = 'dynamicFacets' in step ? step.dynamicFacets : undefined;
  if (dynamicFacets?.selector !== undefined && dynamicFacets.selector.instructionRef === undefined) {
    diagnostics.push('Selector instruction reference is missing');
  }
  if (step.parallel !== undefined && isDynamicParallelSubSteps(step.parallel)) {
    const selector = step.parallel.selection.selector;
    if (selector !== undefined && selector.instructionRef === undefined) {
      diagnostics.push('Selector instruction reference is missing');
    }
  }
}

function collectFacetPoolDisplayDiagnostics(workflow: WorkflowConfig, diagnostics: string[]): void {
  for (const pool of Object.values(workflow.facetPools ?? {})) {
    for (const candidate of pool.candidates) {
      const facetCollections = [
        ['policy', candidate.policyRefs, candidate.resolvedPolicyContents],
        ['knowledge', candidate.knowledgeRefs, candidate.resolvedKnowledgeContents],
      ] as const;
      for (const [field, refs, values] of facetCollections) {
        if (refs.length !== values.length) {
          diagnostics.push(`Facet pool ${field} references and resolved contents are out of sync`);
        }
        for (const index of refs.keys()) {
          if (values[index] === undefined) {
            diagnostics.push(`Facet pool ${field} content is missing at index ${index}`);
          }
        }
      }
    }
  }
}

function collectLoopMonitorDisplayDiagnostics(workflow: WorkflowConfig, diagnostics: string[]): void {
  for (const monitor of workflow.loopMonitors ?? []) {
    if (monitor.judge.instruction !== undefined && monitor.judge.instructionRef === undefined) {
      diagnostics.push('Loop monitor judge instruction reference is missing');
    }
  }
}

function buildInspectPlan(
  workflow: WorkflowConfig,
  context: RuntimeDisplayContext,
  activeReferences: ReadonlySet<string>,
  depth: number,
  diagnostics: string[],
): InspectPlanNode {
  const sourcePath = getWorkflowSourcePath(workflow);
  const nodeContext: RuntimeDisplayContext = {
    ...context,
    workflow,
    workflowDir: sourcePath === undefined ? context.workflowDir : dirname(sourcePath),
    facetContext: {
      ...context.facetContext,
      workflowDir: sourcePath === undefined ? context.workflowDir : dirname(sourcePath),
    },
  };
  const node: InspectPlanNode = {
    workflow,
    context: nodeContext,
    providerDisplays: new Map(),
    callEdges: new Map(),
  };
  collectFacetPoolDisplayDiagnostics(workflow, diagnostics);
  collectLoopMonitorDisplayDiagnostics(workflow, diagnostics);
  for (const step of workflow.steps) {
    collectStepPlan(step, node, activeReferences, depth, diagnostics);
  }
  return node;
}

function collectStepPlan(
  step: WorkflowStep,
  node: InspectPlanNode,
  activeReferences: ReadonlySet<string>,
  depth: number,
  diagnostics: string[],
): void {
  collectStepDisplayDiagnostics(step, diagnostics);
  if (getWorkflowStepKind(step) === 'agent') {
    try {
      node.providerDisplays.set(step, resolveProviderDisplay(step, node.context));
    } catch (resolutionError) {
      diagnostics.push(
        `workflow "${node.workflow.name}" step "${step.name}": ${getErrorMessage(resolutionError)}`,
      );
    }
  }
  if (step.parallel !== undefined) {
    for (const subStep of getAllParallelSubSteps(step.parallel)) {
      collectStepPlan(subStep, node, activeReferences, depth, diagnostics);
    }
  }
  if (step.kind === 'workflow_call') {
    const result = buildCallEdge(step, node, activeReferences, depth, diagnostics);
    if ('diagnostic' in result) {
      diagnostics.push(
        `workflow "${node.workflow.name}" step "${step.name}" call "${step.call}": ${result.diagnostic}`,
      );
      return;
    }
    node.callEdges.set(step, result.edge);
  }
}

function buildCallEdge(
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
  node: InspectPlanNode,
  activeReferences: ReadonlySet<string>,
  depth: number,
  diagnostics: string[],
): WorkflowCallPlanResult {
  if (depth + 1 >= DISPLAY_DEPTH_LIMIT) {
    return { edge: { note: `depth limit ${DISPLAY_DEPTH_LIMIT} reached` } };
  }
  let child: WorkflowConfig | null;
  try {
    child = resolveWorkflowCallTarget(node.workflow, step, node.context.projectDir, node.context.lookupCwd);
  } catch (callError) {
    return { diagnostic: getErrorMessage(callError) };
  }
  if (child === null) {
    return { diagnostic: 'workflow_call target was not found' };
  }
  if (child.subworkflow?.callable !== true) {
    return { diagnostic: `workflow "${child.name}" is not callable` };
  }
  const childReference = getWorkflowReference(child);
  if (activeReferences.has(childReference)) {
    return { edge: { note: `circular reference detected at ${child.name}` } };
  }
  const childRuntime = resolveAuxiliaryRuntimeEnvironment(node.context.projectDir, child);
  const childContext: RuntimeDisplayContext = {
    ...node.context,
    providerEnvironment: applyInspectionOverrides(childRuntime, node.context.selectorOverrides),
  };
  return {
    edge: {
      child: buildInspectPlan(
        child,
        childContext,
        new Set([...activeReferences, childReference]),
        depth + 1,
        diagnostics,
      ),
    },
  };
}

function reportDiagnostics(report: WorkflowDoctorReport): void {
  for (const diagnostic of report.diagnostics) {
    const message = sanitizeTerminalText(diagnostic.message);
    if (diagnostic.level === 'error') {
      error(`${sanitizeTerminalText(report.filePath)}: ${message}`);
    } else {
      warn(`${sanitizeTerminalText(report.filePath)}: ${formatInspectWarning(message)}`);
    }
  }
}

function formatInspectWarning(message: string): string {
  const references = message.match(/\{report:[^}]+\}/g);
  return references === null ? message : `${references.join(' ')}: ${message}`;
}

export async function inspectWorkflowCommand(
  target: string | undefined,
  projectDir: string,
  selectorOverrides?: SelectorProviderOverrides,
): Promise<void> {
  const targets = resolveWorkflowDoctorTargets(
    [target ?? DEFAULT_WORKFLOW_NAME],
    projectDir,
  );
  if (targets.length !== 1) {
    throw new Error('Workflow inspect requires exactly one target');
  }
  const workflowTarget = targets[0];
  if (workflowTarget === undefined) {
    throw new Error('No workflow file found to inspect');
  }

  const report = inspectWorkflowFile(workflowTarget.filePath, projectDir, {
    lookupCwd: workflowTarget.lookupCwd,
    source: workflowTarget.source,
  });
  const validation = validateWorkflowRuntimeContract(report, workflowTarget, projectDir, selectorOverrides);

  if (reportHasErrors(report) || validation === undefined) {
    reportDiagnostics(report);
    throw new Error('Workflow validation failed');
  }
  for (const diagnostic of report.diagnostics) {
    warn(`${sanitizeTerminalText(report.filePath)}: ${formatInspectWarning(sanitizeTerminalText(diagnostic.message))}`);
  }

  const { workflow, runtimeEnvironment: runtime } = validation;
  const providerEnvironment = applyInspectionOverrides(runtime, selectorOverrides);
  const sourcePath = getWorkflowSourcePath(workflow);
  const context: RuntimeDisplayContext = {
    workflow,
    projectDir,
    lookupCwd: workflowTarget.lookupCwd ?? projectDir,
    workflowDir: sourcePath === undefined ? dirname(workflowTarget.filePath) : dirname(sourcePath),
    facetContext: {
      lang: resolveWorkflowConfigValue(projectDir, 'language'),
      projectDir,
      workflowDir: sourcePath === undefined ? dirname(workflowTarget.filePath) : dirname(sourcePath),
      repertoireDir: getRepertoireDir(),
    },
    providerEnvironment,
    projectConfig: loadProjectConfig(projectDir),
    globalConfig: loadGlobalConfig(),
    selectorOverrides,
  };
  const planDiagnostics: string[] = [];
  const plan = buildInspectPlan(workflow, context, new Set([getWorkflowReference(workflow)]), 0, planDiagnostics);
  if (planDiagnostics.length > 0) {
    for (const message of planDiagnostics) {
      error(`${sanitizeTerminalText(report.filePath)}: ${sanitizeTerminalText(message)}`);
    }
    throw new Error('Workflow validation failed');
  }
  const selectorResolution = resolveWorkflowSelector(workflow, {
    projectCwd: projectDir,
    lookupCwd: context.lookupCwd,
    overrides: selectorOverrides,
    companionEnabled: runtime.companionEnabled,
    providerEnvironment,
    providerConfigMode: runtime.providerConfigMode,
  });
  if (selectorResolution.applies) {
    const permission = resolveSelectorPermissionMode(selectorResolution.selectorProvider.permissionMode);
    info(`selectorProvider: ${formatResolvedValue(selectorResolution.selectorProvider.provider, selectorResolution.selectorProvider.providerSource)}`);
    info(`selectorModel: ${formatResolvedValue(selectorResolution.selectorProvider.model, selectorResolution.selectorProvider.modelSource)}`);
    info(`selectorPermission: ${formatResolvedValue(permission.permissionMode, permission.permissionModeSource)}`);
  }

  displayWorkflow(plan);
  success(`Workflow inspected: ${sanitizeTerminalText(workflow.name)}`);
}
