/**
 * Piece YAML parsing and normalization.
 *
 * Converts raw YAML structures into internal PieceConfig format,
 * resolving persona paths, content paths, and rule conditions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { PieceConfigRawSchema, PieceMovementRawSchema } from '../../../core/models/index.js';
import type { PieceConfig, PieceMovement, PieceRule, OutputContractEntry, OutputContractLabelPath, OutputContractItem, LoopMonitorConfig, LoopMonitorJudge, ArpeggioMovementConfig, ArpeggioMergeMovementConfig, TeamLeaderConfig } from '../../../core/models/index.js';
import { getLanguage } from '../global/globalConfig.js';
import {
  type PieceSections,
  type FacetResolutionContext,
  resolveRefToContent,
  resolveRefList,
  resolveSectionMap,
  extractPersonaDisplayName,
  resolvePersona,
} from './resource-resolver.js';

type RawStep = z.output<typeof PieceMovementRawSchema>;

function normalizeProviderOptions(
  raw: RawStep['provider_options'],
): PieceMovement['providerOptions'] {
  if (!raw) return undefined;

  const codex = raw.codex?.network_access === undefined
    ? undefined
    : { networkAccess: raw.codex.network_access };
  const opencode = raw.opencode?.network_access === undefined
    ? undefined
    : { networkAccess: raw.opencode.network_access };

  if (!codex && !opencode) return undefined;
  return { ...(codex ? { codex } : {}), ...(opencode ? { opencode } : {}) };
}

function mergeProviderOptions(
  base: PieceMovement['providerOptions'],
  override: PieceMovement['providerOptions'],
): PieceMovement['providerOptions'] {
  const codexNetworkAccess = override?.codex?.networkAccess ?? base?.codex?.networkAccess;
  const opencodeNetworkAccess = override?.opencode?.networkAccess ?? base?.opencode?.networkAccess;

  const codex = codexNetworkAccess === undefined ? undefined : { networkAccess: codexNetworkAccess };
  const opencode = opencodeNetworkAccess === undefined ? undefined : { networkAccess: opencodeNetworkAccess };

  if (!codex && !opencode) return undefined;
  return { ...(codex ? { codex } : {}), ...(opencode ? { opencode } : {}) };
}

/** Check if a raw output contract item is the object form (has 'name' property). */
function isOutputContractItem(raw: unknown): raw is { name: string; order?: string; format?: string } {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'name' in raw;
}

/**
 * Normalize the raw output_contracts field from YAML into internal format.
 *
 * Input format (YAML):
 *   output_contracts:
 *     report:
 *       - Scope: 01-scope.md           # label:path format
 *       - name: 00-plan.md             # item format
 *         format: plan
 *
 * Output: OutputContractEntry[]
 */
function normalizeOutputContracts(
  raw: { report?: Array<Record<string, string> | { name: string; order?: string; format?: string }> } | undefined,
  pieceDir: string,
  resolvedReportFormats?: Record<string, string>,
  context?: FacetResolutionContext,
): OutputContractEntry[] | undefined {
  if (raw?.report == null || raw.report.length === 0) return undefined;

  const result: OutputContractEntry[] = [];

  for (const entry of raw.report) {
    if (isOutputContractItem(entry)) {
      // Item format: {name, order?, format?}
      const item: OutputContractItem = {
        name: entry.name,
        order: entry.order ? resolveRefToContent(entry.order, resolvedReportFormats, pieceDir, 'output-contracts', context) : undefined,
        format: entry.format ? resolveRefToContent(entry.format, resolvedReportFormats, pieceDir, 'output-contracts', context) : undefined,
      };
      result.push(item);
    } else {
      // Label:path format: {Scope: "01-scope.md"}
      for (const [label, path] of Object.entries(entry)) {
        const labelPath: OutputContractLabelPath = { label, path };
        result.push(labelPath);
      }
    }
  }

  return result.length > 0 ? result : undefined;
}

/** Regex to detect ai("...") condition expressions */
const AI_CONDITION_REGEX = /^ai\("(.+)"\)$/;

/** Regex to detect all("...")/any("...") aggregate condition expressions */
const AGGREGATE_CONDITION_REGEX = /^(all|any)\((.+)\)$/;

/**
 * Parse aggregate condition arguments from all("A", "B") or any("A", "B").
 * Returns an array of condition strings.
 * Throws if the format is invalid.
 */
function parseAggregateConditions(argsText: string): string[] {
  const conditions: string[] = [];
  const regex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(argsText)) !== null) {
    if (match[1]) conditions.push(match[1]);
  }

  if (conditions.length === 0) {
    throw new Error(`Invalid aggregate condition format: ${argsText}`);
  }

  return conditions;
}

/**
 * Parse a rule's condition for ai() and all()/any() expressions.
 */
function normalizeRule(r: {
  condition: string;
  next?: string;
  appendix?: string;
  requires_user_input?: boolean;
  interactive_only?: boolean;
}): PieceRule {
  const next = r.next ?? '';
  const aiMatch = r.condition.match(AI_CONDITION_REGEX);
  if (aiMatch?.[1]) {
    return {
      condition: r.condition,
      next,
      appendix: r.appendix,
      requiresUserInput: r.requires_user_input,
      interactiveOnly: r.interactive_only,
      isAiCondition: true,
      aiConditionText: aiMatch[1],
    };
  }

  const aggMatch = r.condition.match(AGGREGATE_CONDITION_REGEX);
  if (aggMatch?.[1] && aggMatch[2]) {
    const conditions = parseAggregateConditions(aggMatch[2]);
    // parseAggregateConditions guarantees conditions.length >= 1
    const aggregateConditionText: string | string[] =
      conditions.length === 1 ? (conditions[0] as string) : conditions;
    return {
      condition: r.condition,
      next,
      appendix: r.appendix,
      requiresUserInput: r.requires_user_input,
      interactiveOnly: r.interactive_only,
      isAggregateCondition: true,
      aggregateType: aggMatch[1] as 'all' | 'any',
      aggregateConditionText,
    };
  }

  return {
    condition: r.condition,
    next,
    appendix: r.appendix,
    requiresUserInput: r.requires_user_input,
    interactiveOnly: r.interactive_only,
  };
}

/** Normalize raw arpeggio config from YAML into internal format. */
function normalizeArpeggio(
  raw: RawStep['arpeggio'],
  pieceDir: string,
): ArpeggioMovementConfig | undefined {
  if (!raw) return undefined;

  const merge: ArpeggioMergeMovementConfig = raw.merge
    ? {
        strategy: raw.merge.strategy,
        inlineJs: raw.merge.inline_js,
        filePath: raw.merge.file ? resolve(pieceDir, raw.merge.file) : undefined,
        separator: raw.merge.separator,
      }
    : { strategy: 'concat' };

  return {
    source: raw.source,
    sourcePath: resolve(pieceDir, raw.source_path),
    batchSize: raw.batch_size,
    concurrency: raw.concurrency,
    templatePath: resolve(pieceDir, raw.template),
    merge,
    maxRetries: raw.max_retries,
    retryDelayMs: raw.retry_delay_ms,
    outputPath: raw.output_path ? resolve(pieceDir, raw.output_path) : undefined,
  };
}

/** Normalize raw team_leader config from YAML into internal format. */
function normalizeTeamLeader(
  raw: RawStep['team_leader'],
  pieceDir: string,
  sections: PieceSections,
  context?: FacetResolutionContext,
): TeamLeaderConfig | undefined {
  if (!raw) return undefined;

  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, pieceDir, context);
  const { personaSpec: partPersona, personaPath: partPersonaPath } = resolvePersona(raw.part_persona, sections, pieceDir, context);

  return {
    persona: personaSpec,
    personaPath,
    maxParts: raw.max_parts,
    timeoutMs: raw.timeout_ms,
    partPersona,
    partPersonaPath,
    partAllowedTools: raw.part_allowed_tools,
    partEdit: raw.part_edit,
    partPermissionMode: raw.part_permission_mode,
  };
}

/** Normalize a raw step into internal PieceMovement format. */
function normalizeStepFromRaw(
  step: RawStep,
  pieceDir: string,
  sections: PieceSections,
  inheritedProviderOptions?: PieceMovement['providerOptions'],
  context?: FacetResolutionContext,
): PieceMovement {
  const rules: PieceRule[] | undefined = step.rules?.map(normalizeRule);

  const rawPersona = (step as Record<string, unknown>).persona as string | undefined;
  const { personaSpec, personaPath } = resolvePersona(rawPersona, sections, pieceDir, context);

  const displayName: string | undefined = (step as Record<string, unknown>).persona_name as string
    || undefined;

  const policyRef = (step as Record<string, unknown>).policy as string | string[] | undefined;
  const policyContents = resolveRefList(policyRef, sections.resolvedPolicies, pieceDir, 'policies', context);

  const knowledgeRef = (step as Record<string, unknown>).knowledge as string | string[] | undefined;
  const knowledgeContents = resolveRefList(knowledgeRef, sections.resolvedKnowledge, pieceDir, 'knowledge', context);

  const expandedInstruction = step.instruction
    ? resolveRefToContent(step.instruction, sections.resolvedInstructions, pieceDir, 'instructions', context)
    : undefined;

  const result: PieceMovement = {
    name: step.name,
    description: step.description,
    persona: personaSpec,
    session: step.session,
    personaDisplayName: displayName || (personaSpec ? extractPersonaDisplayName(personaSpec) : step.name),
    personaPath,
    allowedTools: step.allowed_tools,
    mcpServers: step.mcp_servers,
    provider: step.provider,
    model: step.model,
    permissionMode: step.permission_mode,
    providerOptions: mergeProviderOptions(inheritedProviderOptions, normalizeProviderOptions(step.provider_options)),
    edit: step.edit,
    instructionTemplate: (step.instruction_template
      ? resolveRefToContent(step.instruction_template, sections.resolvedInstructions, pieceDir, 'instructions', context)
      : undefined) || expandedInstruction || '{task}',
    rules,
    outputContracts: normalizeOutputContracts(step.output_contracts, pieceDir, sections.resolvedReportFormats, context),
    qualityGates: step.quality_gates,
    passPreviousResponse: step.pass_previous_response ?? true,
    policyContents,
    knowledgeContents,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) =>
      normalizeStepFromRaw(sub, pieceDir, sections, inheritedProviderOptions, context),
    );
  }

  const arpeggioConfig = normalizeArpeggio(step.arpeggio, pieceDir);
  if (arpeggioConfig) {
    result.arpeggio = arpeggioConfig;
  }

  const teamLeaderConfig = normalizeTeamLeader(step.team_leader, pieceDir, sections, context);
  if (teamLeaderConfig) {
    result.teamLeader = teamLeaderConfig;
  }

  return result;
}

/** Normalize a raw loop monitor judge from YAML into internal format. */
function normalizeLoopMonitorJudge(
  raw: { persona?: string; instruction_template?: string; rules: Array<{ condition: string; next: string }> },
  pieceDir: string,
  sections: PieceSections,
  context?: FacetResolutionContext,
): LoopMonitorJudge {
  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, pieceDir, context);

  return {
    persona: personaSpec,
    personaPath,
    instructionTemplate: raw.instruction_template
      ? resolveRefToContent(raw.instruction_template, sections.resolvedInstructions, pieceDir, 'instructions', context)
      : undefined,
    rules: raw.rules.map((r) => ({ condition: r.condition, next: r.next })),
  };
}

/**
 * Normalize raw loop monitors from YAML into internal format.
 */
function normalizeLoopMonitors(
  raw: Array<{ cycle: string[]; threshold: number; judge: { persona?: string; instruction_template?: string; rules: Array<{ condition: string; next: string }> } }> | undefined,
  pieceDir: string,
  sections: PieceSections,
  context?: FacetResolutionContext,
): LoopMonitorConfig[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((monitor) => ({
    cycle: monitor.cycle,
    threshold: monitor.threshold,
    judge: normalizeLoopMonitorJudge(monitor.judge, pieceDir, sections, context),
  }));
}

/** Convert raw YAML piece config to internal format. */
export function normalizePieceConfig(
  raw: unknown,
  pieceDir: string,
  context?: FacetResolutionContext,
): PieceConfig {
  const parsed = PieceConfigRawSchema.parse(raw);

  const resolvedPolicies = resolveSectionMap(parsed.policies, pieceDir);
  const resolvedKnowledge = resolveSectionMap(parsed.knowledge, pieceDir);
  const resolvedInstructions = resolveSectionMap(parsed.instructions, pieceDir);
  const resolvedReportFormats = resolveSectionMap(parsed.report_formats, pieceDir);

  const sections: PieceSections = {
    personas: parsed.personas,
    resolvedPolicies,
    resolvedKnowledge,
    resolvedInstructions,
    resolvedReportFormats,
  };

  const pieceProviderOptions = normalizeProviderOptions(parsed.piece_config?.provider_options as RawStep['provider_options']);

  const movements: PieceMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(step, pieceDir, sections, pieceProviderOptions, context),
  );

  // Schema guarantees movements.min(1)
  const initialMovement = parsed.initial_movement ?? movements[0]!.name;

  return {
    name: parsed.name,
    description: parsed.description,
    providerOptions: pieceProviderOptions,
    personas: parsed.personas,
    policies: resolvedPolicies,
    knowledge: resolvedKnowledge,
    instructions: resolvedInstructions,
    reportFormats: resolvedReportFormats,
    movements,
    initialMovement,
    maxMovements: parsed.max_movements,
    loopMonitors: normalizeLoopMonitors(parsed.loop_monitors, pieceDir, sections, context),
    answerAgent: parsed.answer_agent,
    interactiveMode: parsed.interactive_mode,
  };
}

/**
 * Load a piece from a YAML file.
 * @param filePath Path to the piece YAML file
 * @param projectDir Optional project directory for 3-layer facet resolution
 */
export function loadPieceFromFile(filePath: string, projectDir?: string): PieceConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Piece file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const pieceDir = dirname(filePath);

  const context: FacetResolutionContext = {
    lang: getLanguage(),
    projectDir,
  };

  return normalizePieceConfig(raw, pieceDir, context);
}
