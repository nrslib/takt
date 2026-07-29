import { resolve } from 'node:path';
import type { z } from 'zod';
import type {
  ArpeggioMergeStepConfig,
  ArpeggioStepConfig,
  OutputContractItem,
  TeamLeaderConfig,
  WorkflowStepRawSchema,
} from '../../../core/models/index.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import {
  extractPersonaDisplayName,
  resolvePersona,
} from './resource-resolver.js';
import {
  formatTeamLeaderInspectTools,
  isTeamLeaderInspectTool,
} from '../../../shared/team-leader-inspect-tools.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;
type RawOutputContract = NonNullable<NonNullable<RawStep['output_contracts']>['report']>[number];

function normalizeTeamLeaderInspectTools(
  tools: string[] | undefined,
  stepPath: readonly PropertyKey[],
): string[] | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const normalizedTools = tools.map((tool, index) => {
    const normalizedTool = tool.trim().toLowerCase();
    if (normalizedTool.length === 0) {
      throw withWorkflowStepErrorPath(
        new Error('team_leader.inspect_tools contains an empty entry'),
        [...stepPath, 'team_leader', 'inspect_tools', index],
      );
    }
    if (!isTeamLeaderInspectTool(normalizedTool)) {
      throw withWorkflowStepErrorPath(
        new Error(`team_leader.inspect_tools contains non-read-only tool "${normalizedTool}". Allowed values: ${formatTeamLeaderInspectTools()}`),
        [...stepPath, 'team_leader', 'inspect_tools', index],
      );
    }
    return normalizedTool;
  });

  return normalizedTools.length > 0 ? normalizedTools : undefined;
}

export function normalizeOutputContract(
  entry: RawOutputContract,
  resolveReference: (reference: string, field: 'format' | 'order') => string,
): OutputContractItem {
  if (typeof entry.format !== 'string') {
    throw new Error(`Unresolved output contract format param for report "${entry.name}"`);
  }

  const format = resolveReference(entry.format, 'format');

  const order = entry.order
    ? resolveReference(entry.order, 'order')
    : undefined;

  // formatRef は解決前の facet 参照名を保持する。format は本文へ解決済みのため、
  // "*-finding-contract" 命名規約の検証（WorkflowValidator の fail-fast チェック）
  // はこちらでしか行えない。
  return { name: entry.name, useJudge: entry.use_judge ?? true, format, formatRef: entry.format, order };
}

export function normalizeArpeggio(raw: RawStep['arpeggio'], workflowDir: string): ArpeggioStepConfig | undefined {
  if (!raw) {
    return undefined;
  }

  const merge: ArpeggioMergeStepConfig = raw.merge
    ? {
        strategy: raw.merge.strategy,
        separator: raw.merge.separator,
        inlineJs: raw.merge.inline_js,
        file: raw.merge.file ? resolve(workflowDir, raw.merge.file) : undefined,
      }
    : { strategy: 'concat' };

  return {
    source: raw.source,
    sourcePath: resolve(workflowDir, raw.source_path),
    batchSize: raw.batch_size,
    concurrency: raw.concurrency,
    templatePath: resolve(workflowDir, raw.template),
    merge,
    maxRetries: raw.max_retries,
    retryDelayMs: raw.retry_delay_ms,
    outputPath: raw.output_path ? resolve(workflowDir, raw.output_path) : undefined,
  };
}

export function normalizeTeamLeader(
  raw: RawStep['team_leader'],
  workflowDir: string,
  sections: WorkflowSections,
  stepPath: readonly PropertyKey[],
  context?: FacetResolutionContext,
): TeamLeaderConfig | undefined {
  if (!raw) {
    return undefined;
  }
  const { personaSpec, personaPath } = normalizeTeamLeaderField(
    stepPath,
    ['persona'],
    () => resolvePersona(raw.persona, sections, workflowDir, context),
  );
  const { personaSpec: partPersona, personaPath: partPersonaPath } = normalizeTeamLeaderField(
    stepPath,
    ['part_persona'],
    () => resolvePersona(raw.part_persona, sections, workflowDir, context),
  );
  const rawPersona = raw.persona?.trim();
  const personaDisplayName = personaSpec ? extractPersonaDisplayName(personaSpec) : undefined;
  const providerRoutingPersonaKey = rawPersona && rawPersona.length > 0 ? rawPersona : undefined;
  const partTags = raw.part_tags?.map((tag, index) => {
    const normalizedTag = tag.trim();
    if (normalizedTag.length === 0) {
      throw withWorkflowStepErrorPath(
        new Error('team_leader.part_tags contains an empty entry'),
        [...stepPath, 'team_leader', 'part_tags', index],
      );
    }
    return normalizedTag;
  });

  return {
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    persona: personaSpec,
    personaPath,
    personaDisplayName,
    providerRoutingPersonaKey,
    maxConcurrency: raw.max_concurrency ?? raw.max_parts ?? 3,
    ...(raw.initial_max_parts !== undefined ? { initialMaxParts: raw.initial_max_parts } : {}),
    ...(raw.fail_on_part_error !== undefined ? { failOnPartError: raw.fail_on_part_error } : {}),
    timeoutMs: raw.timeout_ms ?? 900000,
    inspectTools: normalizeTeamLeaderInspectTools(raw.inspect_tools, stepPath),
    partPersona,
    partPersonaPath,
    partTags,
    partAllowedTools: raw.part_allowed_tools,
    partEdit: raw.part_edit,
    partPermissionMode: raw.part_permission_mode,
  };
}

function normalizeTeamLeaderField<T>(
  stepPath: readonly PropertyKey[],
  fieldPath: readonly PropertyKey[],
  normalize: () => T,
): T {
  try {
    return normalize();
  } catch (error) {
    throw withWorkflowStepErrorPath(error, [...stepPath, 'team_leader', ...fieldPath]);
  }
}
