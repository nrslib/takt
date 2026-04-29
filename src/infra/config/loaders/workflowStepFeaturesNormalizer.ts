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
import { resolvePersona, resolveRefToContent } from './resource-resolver.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;

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
  return {
    persona: personaSpec,
    personaPath,
    maxParts: raw.max_parts,
    refillThreshold: raw.refill_threshold,
    timeoutMs: raw.timeout_ms,
    partPersona,
    partPersonaPath,
    partAllowedTools: raw.part_allowed_tools,
    partEdit: raw.part_edit,
    partPermissionMode: raw.part_permission_mode,
  };
}
