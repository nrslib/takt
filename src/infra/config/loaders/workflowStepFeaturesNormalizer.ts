import { resolve } from 'node:path';
import type { z } from 'zod';
import type {
  ArpeggioMergeStepConfig,
  ArpeggioStepConfig,
  OutputContractEntry,
  OutputContractItem,
  TeamLeaderConfig,
  WorkflowStepRawSchema,
} from '../../../core/models/index.js';
import type { FacetResolutionContext, ResolvedSectionMap, WorkflowSections } from './resource-resolver.js';
import {
  extractPersonaDisplayName,
  resolvePersona,
  resolveRefToContent,
} from './resource-resolver.js';
import { DEFAULT_TEAM_LEADER_MAX_TOTAL_PARTS } from '../../../shared/constants.js';
import {
  formatTeamLeaderInspectTools,
  isTeamLeaderInspectTool,
} from '../../../shared/team-leader-inspect-tools.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;

function normalizeTeamLeaderInspectTools(tools: string[] | undefined): string[] | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const normalizedTools = tools.map((tool) => {
    const normalizedTool = tool.trim().toLowerCase();
    if (normalizedTool.length === 0) {
      throw new Error('team_leader.inspect_tools contains an empty entry');
    }
    if (!isTeamLeaderInspectTool(normalizedTool)) {
      throw new Error(
        `team_leader.inspect_tools contains non-read-only tool "${normalizedTool}". Allowed values: ${formatTeamLeaderInspectTools()}`,
      );
    }
    return normalizedTool;
  });

  return normalizedTools.length > 0 ? normalizedTools : undefined;
}

export function normalizeOutputContracts(
  raw: { report?: Array<{ name: string; format: string | { $param: string }; use_judge?: boolean; order?: string }> } | undefined,
  workflowDir: string,
  resolvedReportFormats: Record<string, string> | ResolvedSectionMap | undefined,
  context?: FacetResolutionContext,
): OutputContractEntry[] | undefined {
  if (raw?.report == null || raw.report.length === 0) {
    return undefined;
  }

  const result: OutputContractItem[] = raw.report.map((entry) => {
    if (typeof entry.format !== 'string') {
      throw new Error(`Unresolved output contract format param for report "${entry.name}"`);
    }

    const format = resolveRefToContent(entry.format, resolvedReportFormats, workflowDir, 'output-contracts', context);
    if (!format) {
      throw new Error(`Failed to resolve output contract format "${entry.format}" for report "${entry.name}"`);
    }

    const order = entry.order
      ? resolveRefToContent(entry.order, resolvedReportFormats, workflowDir, 'output-contracts', context)
      : undefined;
    if (entry.order && !order) {
      throw new Error(`Failed to resolve output contract order "${entry.order}" for report "${entry.name}"`);
    }

    return { name: entry.name, useJudge: entry.use_judge ?? true, format, order };
  });

  return result.length > 0 ? result : undefined;
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
  context?: FacetResolutionContext,
): TeamLeaderConfig | undefined {
  if (!raw) {
    return undefined;
  }

  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, workflowDir, context);
  const { personaSpec: partPersona, personaPath: partPersonaPath } = resolvePersona(raw.part_persona, sections, workflowDir, context);
  const rawPersona = raw.persona?.trim();
  const personaDisplayName = personaSpec ? extractPersonaDisplayName(personaSpec) : undefined;
  const providerRoutingPersonaKey = rawPersona && rawPersona.length > 0 ? rawPersona : undefined;
  const partTags = raw.part_tags?.map((tag) => {
    const normalizedTag = tag.trim();
    if (normalizedTag.length === 0) {
      throw new Error('team_leader.part_tags contains an empty entry');
    }
    return normalizedTag;
  });

  return {
    persona: personaSpec,
    personaPath,
    personaDisplayName,
    providerRoutingPersonaKey,
    maxConcurrency: raw.max_concurrency ?? raw.max_parts ?? 3,
    maxTotalParts: raw.max_total_parts ?? DEFAULT_TEAM_LEADER_MAX_TOTAL_PARTS,
    refillThreshold: raw.refill_threshold ?? 0,
    timeoutMs: raw.timeout_ms ?? 900000,
    inspectTools: normalizeTeamLeaderInspectTools(raw.inspect_tools),
    partPersona,
    partPersonaPath,
    partTags,
    partAllowedTools: raw.part_allowed_tools,
    partEdit: raw.part_edit,
    partPermissionMode: raw.part_permission_mode,
  };
}
