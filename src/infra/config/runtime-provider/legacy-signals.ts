/**
 * Shared legacy-provider signal collection (issue #1136).
 *
 * A "legacy provider signal" is a provider setting explicitly written to project/global
 * `config.yaml` settings that must not coexist with an active runtime.yaml provider
 * section. `determineProviderConfigMode` turns a non-empty signal list into a mixed-config
 * fail-fast. This module owns the single signal-generation mapping so every entry point — the
 * workflow-execution bootstrap, the auxiliary preview/doctor entry, and the selector/assistant
 * seams — consumes the same mode decision instead of re-deriving it.
 */

import type {
  TaktProvidersConfig,
  WorkflowMcpServersConfig,
} from '../../../core/models/config-types.js';
import type { McpServerConfig } from '../../../core/models/index.js';
import type { WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import { getAllParallelSubSteps } from '../../../core/models/index.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { getWorkflowReference } from '../../../core/workflow/workflow-reference.js';
import type { WorkflowCallResolver } from '../../../core/workflow/types.js';
import type { ProviderOptionsSource } from '../../../core/workflow/provider-options-trace.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import {
  resolveConfigValueWithSource,
  resolveProviderOptionsWithTrace,
  toProviderResolutionSource,
} from '../resolveConfigValue.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import type { LegacyProviderEnvironmentInput } from './environment.js';
import type { LegacyProviderSignal } from './mode.js';
import type { McpAssignmentSection } from './mcp-assignment.js';

function isNonEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

/**
 * Reduce project/global `takt_providers` into the subset that counts as a mixed-config signal:
 * a `selector` or `assistant` entry whose `provider` is set in `config.yaml`. Project wins over
 * global so the returned view reflects the effective config the same way the rest of the loader
 * layers do.
 */
export function selectConfigTaktProviders(
  project: TaktProvidersConfig | undefined,
  global: TaktProvidersConfig | undefined,
): TaktProvidersConfig | undefined {
  const selectorProvider = project?.selector?.provider ?? global?.selector?.provider;
  const assistantProvider = project?.assistant?.provider ?? global?.assistant?.provider;
  if (selectorProvider === undefined && assistantProvider === undefined) {
    return undefined;
  }
  return {
    ...(selectorProvider !== undefined ? { selector: { provider: selectorProvider } } : {}),
    ...(assistantProvider !== undefined ? { assistant: { provider: assistantProvider } } : {}),
  };
}

/**
 * Detect legacy provider settings that must not coexist with an active runtime.yaml provider
 * section. CLI/env overrides and built-in defaults are runtime overrides / defaults (allowed in
 * both modes), so they are not reported as legacy configuration — only settings explicitly
 * written to project/global `config.yaml` count.
 */
export function collectLegacyProviderSignals(
  legacy: LegacyProviderEnvironmentInput,
  providerOptionsSource: ProviderOptionsSource | undefined,
): LegacyProviderSignal[] {
  const signals: LegacyProviderSignal[] = [];

  if (legacy.providerSource === 'project' || legacy.providerSource === 'global') {
    signals.push({
      setting: 'provider',
      location: `config.yaml:provider (${legacy.providerSource})`,
      migrateTo: 'provider.defaults + provider.profiles',
    });
  }
  if (legacy.modelSource === 'project' || legacy.modelSource === 'global') {
    signals.push({
      setting: 'model',
      location: `config.yaml:model (${legacy.modelSource})`,
      migrateTo: 'provider.defaults + provider.profiles',
    });
  }
  // Only takt_providers with an explicit provider (config.yaml only; never CLI/env/default) count.
  if (
    legacy.taktProviders?.selector?.provider !== undefined
    || legacy.taktProviders?.assistant?.provider !== undefined
  ) {
    signals.push({
      setting: 'takt_providers',
      location: 'config.yaml:takt_providers',
      migrateTo: 'provider.targets.internal_agents',
    });
  }
  // Only provider_options explicitly written to project/global config.yaml are a legacy signal.
  // The resolver always merges built-in skill defaults into the value (source 'default'), and
  // env overrides (source 'env') are runtime overrides — neither must trip the mixed-config gate.
  if (
    (providerOptionsSource === 'project' || providerOptionsSource === 'global')
    && isNonEmptyRecord(legacy.providerOptions as Record<string, unknown> | undefined)
  ) {
    signals.push({
      setting: 'provider_options',
      location: 'config.yaml:provider_options',
      migrateTo: 'provider.profiles.*.options',
    });
  }
  if (isNonEmptyRecord(legacy.personaProviders)) {
    signals.push({
      setting: 'persona_providers',
      location: 'config.yaml:persona_providers',
      migrateTo: 'provider.targets.personas',
    });
  }
  if (isNonEmptyRecord(legacy.providerRouting as Record<string, unknown> | undefined)) {
    signals.push({
      setting: 'provider_routing',
      location: 'config.yaml:provider_routing',
      migrateTo: 'provider.targets',
    });
  }
  if (legacy.autoRouting !== undefined) {
    signals.push({
      setting: 'auto_routing',
      location: 'config.yaml:auto_routing',
      migrateTo: 'provider.auto_routing',
    });
  }

  return signals;
}

/**
 * Collect the legacy provider signals for entry points that carry no workflow context (the
 * selector and assistant seams). Reads project/global `config.yaml` directly through the same
 * resolvers the bootstrap uses, so the seams fail fast on a mixed configuration with the same
 * `location`/`migrateTo` details as the workflow-execution path.
 */
export function collectProjectLegacyProviderSignals(projectCwd: string): LegacyProviderSignal[] {
  const provider = resolveConfigValueWithSource(projectCwd, 'provider');
  const model = resolveConfigValueWithSource(projectCwd, 'model');
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  const resolved = resolveWorkflowConfigValues(projectCwd, [
    'personaProviders',
    'providerRouting',
    'autoRouting',
  ]);
  const legacy: LegacyProviderEnvironmentInput = {
    provider: provider.value,
    providerSource: toProviderResolutionSource(provider.source),
    model: model.value,
    modelSource: toProviderResolutionSource(model.source),
    personaProviders: resolved.personaProviders,
    providerRouting: resolved.providerRouting,
    autoRouting: resolved.autoRouting,
    providerOptions: providerOptions.value,
    taktProviders: selectConfigTaktProviders(
      loadProjectConfig(projectCwd).taktProviders,
      loadGlobalConfig().taktProviders,
    ),
  };
  return collectLegacyProviderSignals(legacy, providerOptions.source);
}

/**
 * Input for legacy MCP signal collection. `workflow_mcp_servers` is the workflow
 * policy that enables MCP servers globally; `workflowStepMcpServers` is the
 * per-step `mcp_servers` map (order.md:112-118).
 */
export interface LegacyMcpSignalInput {
  /** The workflow-level `mcp_servers` policy (e.g. `{ stdio: true }`). */
  workflowMcpServersPolicy: WorkflowMcpServersConfig | undefined;
  /** The per-step `mcp_servers` map (`{ name: McpServerConfig }`). */
  workflowStepMcpServers: Record<string, McpServerConfig> | undefined;
  /** Workflow name for error messages. */
  workflowName: string;
  /** Step name when the signal is step-scoped (undefined for workflow-scoped). */
  workflowStepName: string | undefined;
}

/**
 * Detect legacy workflow MCP settings that must not coexist with an active
 * `runtime.yaml.mcp` section. Both the `workflow_mcp_servers` policy and the
 * per-step `mcp_servers` map are reported so the mixed-config error names
 * every legacy location and its migration target (order.md:112-118).
 */
export function collectLegacyMcpSignals(input: LegacyMcpSignalInput): LegacyProviderSignal[] {
  const signals: LegacyProviderSignal[] = [];

  if (input.workflowMcpServersPolicy !== undefined
    && Object.keys(input.workflowMcpServersPolicy).length > 0) {
    signals.push({
      setting: 'workflow_mcp_servers',
      location: `workflow "${input.workflowName}":workflow_mcp_servers policy`,
      migrateTo: 'mcp.targets',
    });
  }

  if (input.workflowStepMcpServers !== undefined
    && Object.keys(input.workflowStepMcpServers).length > 0) {
    const stepSuffix = input.workflowStepName !== undefined
      ? `:${input.workflowStepName}`
      : '';
    signals.push({
      setting: 'mcp_servers',
      location: `workflow "${input.workflowName}"${stepSuffix}:mcp_servers`,
      migrateTo: 'mcp.targets.steps',
    });
  }

  return signals;
}

export interface WorkflowMcpSignalTraversalOptions {
  /** Resolve child workflows reachable through workflow_call steps. */
  workflowCallResolver?: WorkflowCallResolver;
  /** Project root passed to the same resolver used by workflow execution. */
  projectCwd?: string;
  /** Lookup directory passed to the same resolver used by workflow execution. */
  lookupCwd?: string;
}

/** Collect all legacy workflow MCP signals used by the bootstrap mixed-mode gate. */
export function collectWorkflowLegacyMcpSignals(
  workflowConfig: WorkflowConfig,
  workflowMcpServersPolicy: WorkflowMcpServersConfig | undefined,
  options: WorkflowMcpSignalTraversalOptions = {},
): LegacyProviderSignal[] {
  const signals: LegacyProviderSignal[] = [];
  const visited = new Set<string>();

  function visitStep(step: WorkflowStep, parentWorkflow: WorkflowConfig): void {
    signals.push(...collectLegacyMcpSignals({
      workflowMcpServersPolicy: undefined,
      workflowStepMcpServers: step.mcpServers,
      workflowName: parentWorkflow.name,
      workflowStepName: step.name,
    }));

    if (
      isWorkflowCallStep(step)
      && options.workflowCallResolver !== undefined
      && options.projectCwd !== undefined
      && options.lookupCwd !== undefined
    ) {
      const childWorkflow = options.workflowCallResolver({
        parentWorkflow,
        step,
        projectCwd: options.projectCwd,
        lookupCwd: options.lookupCwd,
      });
      if (childWorkflow !== null) {
        visitWorkflow(childWorkflow, false);
      }
    }

    const parallelSteps = step.parallel === undefined
      ? []
      : getAllParallelSubSteps(step.parallel);
    for (const parallelStep of parallelSteps) {
      visitStep(parallelStep, parentWorkflow);
    }
  }

  function visitWorkflow(workflow: WorkflowConfig, includePolicy: boolean): void {
    const reference = getWorkflowReference(workflow);
    if (visited.has(reference)) {
      return;
    }
    visited.add(reference);

    if (includePolicy) {
      signals.push(...collectLegacyMcpSignals({
        workflowMcpServersPolicy,
        workflowStepMcpServers: undefined,
        workflowName: workflow.name,
        workflowStepName: undefined,
      }));
    }
    for (const step of workflow.steps) {
      visitStep(step, workflow);
    }
  }

  visitWorkflow(workflowConfig, true);
  return signals;
}

/** Fail fast when runtime MCP assignment and legacy workflow MCP are mixed. */
export function assertNoMixedMcpConfiguration(
  mcpAssignment: McpAssignmentSection | undefined,
  legacyMcpSignals: readonly LegacyProviderSignal[],
): void {
  if (mcpAssignment === undefined || legacyMcpSignals.length === 0) {
    return;
  }
  const lines = legacyMcpSignals.map(
    (signal) => `  - ${signal.setting} at ${signal.location} → migrate to ${signal.migrateTo}`,
  );
  throw new Error([
    'Mixed MCP configuration detected: an active runtime.yaml mcp section cannot',
    'coexist with legacy workflow MCP settings. Remove the runtime.yaml mcp section or migrate',
    'the following legacy settings:',
    ...lines,
  ].join('\n'));
}

/** Apply the production mixed-MCP gate to a workflow and its legacy settings. */
export function assertNoMixedWorkflowMcpConfiguration(
  mcpAssignment: McpAssignmentSection | undefined,
  workflowConfig: WorkflowConfig,
  workflowMcpServersPolicy: WorkflowMcpServersConfig | undefined,
  options: WorkflowMcpSignalTraversalOptions = {},
): void {
  assertNoMixedMcpConfiguration(
    mcpAssignment,
    collectWorkflowLegacyMcpSignals(workflowConfig, workflowMcpServersPolicy, options),
  );
}
