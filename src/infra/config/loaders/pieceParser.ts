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
import { PieceConfigRawSchema, PieceMovementRawSchema, ProviderBlockRawSchema } from '../../../core/models/index.js';
import type { PieceConfig, PieceMovement, PieceRule, OutputContractEntry, OutputContractItem, LoopMonitorConfig, LoopMonitorJudge, ArpeggioMovementConfig, ArpeggioMergeMovementConfig, TeamLeaderConfig } from '../../../core/models/index.js';
import { resolvePieceConfigValue } from '../resolvePieceConfigValue.js';
import { getRepertoireDir } from '../paths.js';
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
type RawPiece = z.output<typeof PieceConfigRawSchema>;
type OnWarning = (message: string) => void;
type ProviderBlock = z.output<typeof ProviderBlockRawSchema> | undefined;

import type { MovementProviderOptions } from '../../../core/models/piece-types.js';
import type { PieceRuntimeConfig } from '../../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../../core/models/provider-profiles.js';

export type RawProviderConfig = string | Record<string, unknown> | undefined;
export type NormalizedProviderConfig = {
  provider?: string;
  model?: string;
  providerOptions?: MovementProviderOptions;
};

/** Convert raw YAML provider_options (snake_case) to internal format (camelCase). */
export function normalizeProviderOptions(
  raw: RawStep['provider_options'],
): MovementProviderOptions | undefined {
  if (!raw) return undefined;

  const result: MovementProviderOptions = {};
  if (raw.codex?.network_access !== undefined) {
    result.codex = { networkAccess: raw.codex.network_access };
  }
  if (raw.opencode?.network_access !== undefined) {
    result.opencode = { networkAccess: raw.opencode.network_access };
  }
  if (raw.claude?.sandbox) {
    result.claude = {
      sandbox: {
        ...(raw.claude.sandbox.allow_unsandboxed_commands !== undefined
          ? { allowUnsandboxedCommands: raw.claude.sandbox.allow_unsandboxed_commands }
          : {}),
        ...(raw.claude.sandbox.excluded_commands !== undefined
          ? { excludedCommands: raw.claude.sandbox.excluded_commands }
          : {}),
      },
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function toProviderOptionsPayload(
  providerOptions: MovementProviderOptions | undefined,
): Record<string, unknown> | undefined {
  if (!providerOptions) return undefined;

  const codex: Record<string, unknown> = {};
  if (providerOptions.codex?.networkAccess !== undefined) {
    codex.network_access = providerOptions.codex.networkAccess;
  }

  const opencode: Record<string, unknown> = {};
  if (providerOptions.opencode?.networkAccess !== undefined) {
    opencode.network_access = providerOptions.opencode.networkAccess;
  }

  const claudeSandbox: Record<string, unknown> = {};
  if (providerOptions.claude?.sandbox?.allowUnsandboxedCommands !== undefined) {
    claudeSandbox.allow_unsandboxed_commands = providerOptions.claude.sandbox.allowUnsandboxedCommands;
  }
  if (providerOptions.claude?.sandbox?.excludedCommands !== undefined) {
    claudeSandbox.excluded_commands = providerOptions.claude.sandbox.excludedCommands;
  }

  const claude: Record<string, unknown> = {};
  if (Object.keys(claudeSandbox).length > 0) {
    claude.sandbox = claudeSandbox;
  }

  const result: Record<string, unknown> = {};
  if (Object.keys(codex).length > 0) result.codex = codex;
  if (Object.keys(opencode).length > 0) result.opencode = opencode;
  if (Object.keys(claude).length > 0) result.claude = claude;

  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeConfigProviderBlock(
  rawProvider: RawProviderConfig,
  rawModel: unknown,
  rawProviderOptions: unknown,
  warn: (message: string) => void,
  source: string,
): NormalizedProviderConfig {
  const legacyModel = typeof rawModel === 'string' ? rawModel : undefined;
  const legacyProviderOptions = normalizeProviderOptions(rawProviderOptions as Parameters<typeof normalizeProviderOptions>[0]);

  if (rawProvider === undefined) {
    return {
      model: legacyModel,
      providerOptions: legacyProviderOptions,
    };
  }

  if (typeof rawProvider === 'string') {
    if (legacyModel !== undefined) {
      warn(`${source}: model is deprecated; use provider.model instead.`);
    }
    if (rawProviderOptions !== undefined) {
      warn(`${source}: provider_options is deprecated; move fields into provider block.`);
    }
    return {
      provider: rawProvider,
      model: legacyModel,
      providerOptions: legacyProviderOptions,
    };
  }

  const providerRecord = toRecord(rawProvider);
  if (!providerRecord) {
    return {
      model: legacyModel,
      providerOptions: legacyProviderOptions,
    };
  }

  const providerFromType = typeof providerRecord.type === 'string' ? providerRecord.type : undefined;
  const providerFromProvider = typeof providerRecord.provider === 'string' ? providerRecord.provider : undefined;

  if (providerFromProvider !== undefined && providerFromType === undefined) {
    warn(`${source}: provider block uses deprecated "provider" key; use "type" instead.`);
  }

  const providerBlockInput = {
    type: providerFromType ?? providerFromProvider,
    model: typeof providerRecord.model === 'string' ? providerRecord.model : undefined,
    network_access: typeof providerRecord.network_access === 'boolean' ? providerRecord.network_access : undefined,
    sandbox: toRecord(providerRecord.sandbox),
  };
  const normalizedProviderBlock = normalizeProviderBlock(providerBlockInput as unknown as ProviderBlock);

  if (legacyModel !== undefined) {
    warn(`${source}: model is deprecated; use provider.model instead.`);
  }
  if (rawProviderOptions !== undefined) {
    warn(`${source}: provider_options is deprecated; move fields into provider block.`);
  }

  return {
    provider: normalizedProviderBlock.provider,
    model: normalizedProviderBlock.model ?? legacyModel,
    providerOptions: mergeProviderOptions(legacyProviderOptions, normalizedProviderBlock.providerOptions),
  };
}

type NormalizedProviderBlock = {
  provider?: PieceMovement['provider'];
  model?: string;
  providerOptions?: MovementProviderOptions;
};

/** Convert raw provider block to unified movement provider representation. */
function normalizeProviderBlock(raw: ProviderBlock | undefined): NormalizedProviderBlock {
  if (raw === undefined) return {};
  if (typeof raw === 'string') {
    return { provider: raw };
  }

  const normalizedOptions: MovementProviderOptions = {};
  if (raw.network_access !== undefined) {
    if (raw.type === 'codex') {
      normalizedOptions.codex = { networkAccess: raw.network_access };
    } else if (raw.type === 'opencode') {
      normalizedOptions.opencode = { networkAccess: raw.network_access };
    }
  }

  if (raw.sandbox) {
    normalizedOptions.claude = {
      sandbox: {
        ...(raw.sandbox.allow_unsandboxed_commands !== undefined
          ? { allowUnsandboxedCommands: raw.sandbox.allow_unsandboxed_commands }
          : {}),
        ...(raw.sandbox.excluded_commands !== undefined
          ? { excludedCommands: raw.sandbox.excluded_commands }
          : {}),
      },
    };
  }

  return {
    provider: raw.type,
    model: raw.model,
    providerOptions: Object.keys(normalizedOptions).length > 0 ? normalizedOptions : undefined,
  };
}

/**
 * Deep merge provider options. Later sources override earlier ones.
 * Exported for reuse in runner.ts (4-layer resolution).
 */
export function mergeProviderOptions(
  ...layers: (MovementProviderOptions | undefined)[]
): MovementProviderOptions | undefined {
  const result: MovementProviderOptions = {};

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.codex) {
      result.codex = { ...result.codex, ...layer.codex };
    }
    if (layer.opencode) {
      result.opencode = { ...result.opencode, ...layer.opencode };
    }
    if (layer.claude?.sandbox) {
      result.claude = {
        sandbox: { ...result.claude?.sandbox, ...layer.claude.sandbox },
      };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

type RawProviderProfile = {
  default_permission_mode: unknown;
  movement_permission_overrides?: Record<string, unknown>;
};

/** Convert raw YAML provider_profiles (snake_case) to internal format (camelCase). */
export function normalizeProviderProfiles(
  raw: Record<string, RawProviderProfile> | undefined,
): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([provider, profile]) => [provider, {
      defaultPermissionMode: profile.default_permission_mode,
      movementPermissionOverrides: profile.movement_permission_overrides,
    }]),
  ) as ProviderPermissionProfiles;
}

/** Convert internal provider_profiles to raw YAML format (snake_case). */
export function denormalizeProviderProfiles(
  profiles: ProviderPermissionProfiles | undefined,
): Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }> | undefined {
  if (!profiles) return undefined;
  const entries = Object.entries(profiles);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([provider, profile]) => [provider, {
    default_permission_mode: profile.defaultPermissionMode,
    ...(profile.movementPermissionOverrides
      ? { movement_permission_overrides: profile.movementPermissionOverrides }
      : {}),
  }])) as Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }>;
}

function normalizeRuntimeConfig(raw: RawPiece['piece_config']): PieceRuntimeConfig | undefined {
  const prepare = raw?.runtime?.prepare;
  if (!prepare || prepare.length === 0) {
    return undefined;
  }
  return {
    prepare: [...new Set(prepare)],
  };
}

/**
 * Normalize the raw output_contracts field from YAML into internal format.
 *
 * Input format (YAML):
 *   output_contracts:
 *     report:
 *       - name: 00-plan.md
 *         format: plan
 *         use_judge: true
 *
 * Output: OutputContractEntry[]
 */
function normalizeOutputContracts(
  raw: { report?: Array<{ name: string; format: string; use_judge?: boolean; order?: string }> } | undefined,
  pieceDir: string,
  resolvedReportFormats?: Record<string, string>,
  context?: FacetResolutionContext,
): OutputContractEntry[] | undefined {
  if (raw?.report == null || raw.report.length === 0) return undefined;

  const result: OutputContractItem[] = raw.report.map((entry) => {
    const resolvedFormat = resolveRefToContent(entry.format, resolvedReportFormats, pieceDir, 'output-contracts', context);
    if (!resolvedFormat) {
      throw new Error(`Failed to resolve output contract format "${entry.format}" for report "${entry.name}"`);
    }

    let resolvedOrder: string | undefined;
    if (entry.order) {
      resolvedOrder = resolveRefToContent(entry.order, resolvedReportFormats, pieceDir, 'output-contracts', context);
      if (!resolvedOrder) {
        throw new Error(`Failed to resolve output contract order "${entry.order}" for report "${entry.name}"`);
      }
    }

    return {
      name: entry.name,
      useJudge: entry.use_judge ?? true,
      format: resolvedFormat,
      order: resolvedOrder,
    };
  });
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
    refillThreshold: raw.refill_threshold,
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
  onWarning?: OnWarning,
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
  const normalizedProvider = normalizeProviderBlock(step.provider);
  if (step.model !== undefined) {
    onWarning?.(`movement "${step.name}": model is deprecated; use provider.model instead.`);
  }
  if (step.provider_options !== undefined) {
    onWarning?.(`movement "${step.name}": provider_options is deprecated; move fields into provider block.`);
  }

  const result: PieceMovement = {
    name: step.name,
    description: step.description,
    persona: personaSpec,
    session: step.session,
    personaDisplayName: displayName || (personaSpec ? extractPersonaDisplayName(personaSpec) : step.name),
    personaPath,
    allowedTools: step.allowed_tools,
    mcpServers: step.mcp_servers,
    provider: normalizedProvider.provider,
    model: normalizedProvider.model ?? step.model,
    requiredPermissionMode: step.required_permission_mode,
    providerOptions: mergeProviderOptions(
      inheritedProviderOptions,
      normalizeProviderOptions(step.provider_options),
      normalizedProvider.providerOptions,
    ),
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
      normalizeStepFromRaw(sub, pieceDir, sections, inheritedProviderOptions, context, onWarning),
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
  onWarning?: OnWarning,
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

  if (parsed.piece_config?.provider_options !== undefined) {
    onWarning?.('piece_config.provider_options is deprecated; use piece_config.provider block instead.');
  }
  const pieceProviderBlock = normalizeProviderBlock(parsed.piece_config?.provider);
  const pieceProviderOptions = mergeProviderOptions(
    normalizeProviderOptions(parsed.piece_config?.provider_options as RawStep['provider_options']),
    pieceProviderBlock.providerOptions,
  );
  const pieceRuntime = normalizeRuntimeConfig(parsed.piece_config);

  const movements: PieceMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(step, pieceDir, sections, pieceProviderOptions, context, onWarning),
  );

  // Schema guarantees movements.min(1)
  const initialMovement = parsed.initial_movement ?? movements[0]!.name;

  return {
    name: parsed.name,
    description: parsed.description,
    provider: pieceProviderBlock.provider,
    model: pieceProviderBlock.model,
    providerOptions: pieceProviderOptions,
    runtime: pieceRuntime,
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
 * @param projectDir Project directory for 3-layer facet resolution
 */
export function loadPieceFromFile(filePath: string, projectDir: string): PieceConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Piece file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const pieceDir = dirname(filePath);

  const context: FacetResolutionContext = {
    lang: resolvePieceConfigValue(projectDir, 'language'),
    projectDir,
    pieceDir,
    repertoireDir: getRepertoireDir(),
  };
  const warnings: string[] = [];
  const config = normalizePieceConfig(raw, pieceDir, context, (message) => {
    warnings.push(message);
  });
  for (const message of warnings) {
    console.warn(message);
  }
  return config;
}
