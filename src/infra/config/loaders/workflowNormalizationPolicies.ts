import type { z } from 'zod';
import { isRuntimePreparePreset } from '../../../core/models/workflow-types.js';
import type {
  WorkflowArpeggioConfig,
  WorkflowMcpServersConfig,
  WorkflowRuntimePrepareConfig,
} from '../../../core/models/config-types.js';
import type { WorkflowConfig, WorkflowStepRawSchema } from '../../../core/models/index.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;

export function resolveWorkflowRuntimePreparePolicy(
  globalPolicy: WorkflowRuntimePrepareConfig | undefined,
  projectPolicy: WorkflowRuntimePrepareConfig | undefined,
): WorkflowRuntimePrepareConfig | undefined {
  const policy: WorkflowRuntimePrepareConfig = {};
  if (globalPolicy?.customScripts !== undefined) policy.customScripts = globalPolicy.customScripts;
  if (projectPolicy?.customScripts !== undefined) policy.customScripts = projectPolicy.customScripts;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function validateWorkflowRuntimePrepare(
  runtime: WorkflowConfig['runtime'],
  policy?: WorkflowRuntimePrepareConfig,
): void {
  for (const entry of runtime?.prepare ?? []) {
    if (isRuntimePreparePreset(entry)) continue;
    if (policy?.customScripts === true) continue;
    throw new Error(
      `Workflow runtime.prepare custom script "${entry}" is disabled by default. `
      + 'Configure workflow_runtime_prepare.custom_scripts in project/global config to allow it.',
    );
  }
}

export function resolveWorkflowArpeggioPolicy(
  globalPolicy: WorkflowArpeggioConfig | undefined,
  projectPolicy: WorkflowArpeggioConfig | undefined,
): WorkflowArpeggioConfig | undefined {
  const policy: WorkflowArpeggioConfig = {};
  if (globalPolicy?.customDataSourceModules !== undefined) policy.customDataSourceModules = globalPolicy.customDataSourceModules;
  if (globalPolicy?.customMergeInlineJs !== undefined) policy.customMergeInlineJs = globalPolicy.customMergeInlineJs;
  if (globalPolicy?.customMergeFiles !== undefined) policy.customMergeFiles = globalPolicy.customMergeFiles;
  if (projectPolicy?.customDataSourceModules !== undefined) policy.customDataSourceModules = projectPolicy.customDataSourceModules;
  if (projectPolicy?.customMergeInlineJs !== undefined) policy.customMergeInlineJs = projectPolicy.customMergeInlineJs;
  if (projectPolicy?.customMergeFiles !== undefined) policy.customMergeFiles = projectPolicy.customMergeFiles;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function validateWorkflowArpeggio(
  stepName: string,
  raw: RawStep['arpeggio'],
  policy?: WorkflowArpeggioConfig,
): void {
  if (!raw) return;
  if (raw.source !== 'csv' && policy?.customDataSourceModules !== true) {
    throw new Error(
      `Step "${stepName}" uses Arpeggio source "${raw.source}", which is disabled by default for workflows. `
      + 'Configure workflow_arpeggio.custom_data_source_modules in project/global config to allow it.',
    );
  }
  if (raw.merge?.inline_js && policy?.customMergeInlineJs !== true) {
    throw new Error(
      `Step "${stepName}" uses Arpeggio inline_js, which is disabled by default for workflows. `
      + 'Configure workflow_arpeggio.custom_merge_inline_js in project/global config to allow it.',
    );
  }
  if (raw.merge?.file && policy?.customMergeFiles !== true) {
    throw new Error(
      `Step "${stepName}" uses Arpeggio merge.file, which is disabled by default for workflows. `
      + 'Configure workflow_arpeggio.custom_merge_files in project/global config to allow it.',
    );
  }
}

export function resolveWorkflowMcpServersPolicy(
  globalPolicy: WorkflowMcpServersConfig | undefined,
  projectPolicy: WorkflowMcpServersConfig | undefined,
): WorkflowMcpServersConfig | undefined {
  const policy: WorkflowMcpServersConfig = {};
  if (globalPolicy?.stdio !== undefined) policy.stdio = globalPolicy.stdio;
  if (globalPolicy?.sse !== undefined) policy.sse = globalPolicy.sse;
  if (globalPolicy?.http !== undefined) policy.http = globalPolicy.http;
  if (projectPolicy?.stdio !== undefined) policy.stdio = projectPolicy.stdio;
  if (projectPolicy?.sse !== undefined) policy.sse = projectPolicy.sse;
  if (projectPolicy?.http !== undefined) policy.http = projectPolicy.http;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function validateWorkflowMcpServers(
  stepName: string,
  mcpServers: RawStep['mcp_servers'],
  policy: WorkflowMcpServersConfig | undefined,
): void {
  if (!mcpServers) return;
  for (const [serverName, config] of Object.entries(mcpServers)) {
    const transport = config.type ?? 'stdio';
    const allowed = transport === 'stdio'
      ? (policy?.stdio ?? false)
      : transport === 'sse'
        ? (policy?.sse ?? false)
        : (policy?.http ?? false);
    if (allowed) continue;
    throw new Error(
      `Step "${stepName}" uses MCP server "${serverName}" with transport "${transport}", `
      + 'which is disabled by default for workflows. '
      + 'Configure workflow_mcp_servers in project/global config to allow it.',
    );
  }
}
