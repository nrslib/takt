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
  isResourcePath,
  resolvePersona,
} from './resource-resolver.js';

type RawStep = z.output<typeof PieceMovementRawSchema>;
import type { MovementProviderOptions } from '../../../core/models/piece-types.js';
import { isRuntimePreparePreset } from '../../../core/models/piece-types.js';
import { normalizeRuntime } from '../configNormalizers.js';
import type { PieceArpeggioConfig, PieceMcpServersConfig, PieceOverrides, PieceRuntimePrepareConfig } from '../../../core/models/config-types.js';
import { applyQualityGateOverrides } from './qualityGateOverrides.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { normalizeConfigProviderReferenceDetailed, type ConfigProviderReference } from '../providerReference.js';
import { mergeProviderOptions } from '../providerOptions.js';
import {
  warnLegacyWorkflowYamlKeysOncePerProcess,
} from '../legacy-workflow-key-deprecation.js';

type RawProviderReference = RawStep['provider'];

function normalizeProviderReference(
  provider: RawProviderReference,
  model: RawStep['model'],
  providerOptions: RawStep['provider_options'],
): {
  provider: PieceMovement['provider'];
  model: PieceMovement['model'];
  providerOptions: MovementProviderOptions | undefined;
  providerSpecified: boolean;
} {
  return normalizeConfigProviderReferenceDetailed(
    provider as ConfigProviderReference<NonNullable<PieceMovement['provider']>>,
    model,
    providerOptions as Record<string, unknown> | undefined,
  );
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
        separator: raw.merge.separator,
        inlineJs: raw.merge.inline_js,
        file: raw.merge.file ? resolve(pieceDir, raw.merge.file) : undefined,
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
  inheritedProvider?: PieceMovement['provider'],
  inheritedModel?: PieceMovement['model'],
  inheritedProviderOptions?: PieceMovement['providerOptions'],
  context?: FacetResolutionContext,
  projectOverrides?: PieceOverrides,
  globalOverrides?: PieceOverrides,
  pieceArpeggioPolicy?: PieceArpeggioConfig,
  pieceMcpServersPolicy?: PieceMcpServersConfig,
): PieceMovement {
  const rules: PieceRule[] | undefined = step.rules?.map(normalizeRule);

  const rawPersona = (step as Record<string, unknown>).persona as string | undefined;
  if (rawPersona !== undefined && rawPersona.trim().length === 0) {
    throw new Error(`Movement "${step.name}" has an empty persona value`);
  }
  const { personaSpec, personaPath } = resolvePersona(rawPersona, sections, pieceDir, context);

  const displayNameRaw = (step as Record<string, unknown>).persona_name as string | undefined;
  if (displayNameRaw !== undefined && displayNameRaw.trim().length === 0) {
    throw new Error(`Movement "${step.name}" has an empty persona_name value`);
  }
  const displayName = displayNameRaw || undefined;
  const derivedPersonaName = personaSpec ? extractPersonaDisplayName(personaSpec) : undefined;
  const resolvedPersonaDisplayName = displayName || derivedPersonaName || step.name;
  const normalizedRawPersona = rawPersona?.trim();
  const personaOverrideKey = normalizedRawPersona
    ? (isResourcePath(normalizedRawPersona) ? extractPersonaDisplayName(normalizedRawPersona) : normalizedRawPersona)
    : undefined;

  const policyRef = (step as Record<string, unknown>).policy as string | string[] | undefined;
  const policyContents = resolveRefList(policyRef, sections.resolvedPolicies, pieceDir, 'policies', context);

  const knowledgeRef = (step as Record<string, unknown>).knowledge as string | string[] | undefined;
  const knowledgeContents = resolveRefList(knowledgeRef, sections.resolvedKnowledge, pieceDir, 'knowledge', context);
  const normalizedProvider = normalizeProviderReference(step.provider, step.model, step.provider_options);

  const expandedInstruction = step.instruction
    ? resolveRefToContent(step.instruction, sections.resolvedInstructions, pieceDir, 'instructions', context)
    : undefined;
  validatePieceArpeggio(step.name, step.arpeggio, pieceArpeggioPolicy);
  validatePieceMcpServers(step.name, step.mcp_servers, pieceMcpServersPolicy);

  const result: PieceMovement = {
    name: step.name,
    description: step.description,
    persona: personaSpec,
    session: step.session,
    personaDisplayName: resolvedPersonaDisplayName,
    personaPath,
    mcpServers: step.mcp_servers,
    provider: normalizedProvider.provider ?? inheritedProvider,
    model: normalizedProvider.model ?? (normalizedProvider.providerSpecified ? undefined : inheritedModel),
    requiredPermissionMode: step.required_permission_mode,
    providerOptions: mergeProviderOptions(inheritedProviderOptions, normalizedProvider.providerOptions),
    edit: step.edit,
    instruction: expandedInstruction || '{task}',
    rules,
    outputContracts: normalizeOutputContracts(step.output_contracts, pieceDir, sections.resolvedReportFormats, context),
    qualityGates: applyQualityGateOverrides(
      step.name,
      step.quality_gates,
      step.edit,
      personaOverrideKey,
      projectOverrides,
      globalOverrides,
    ),
    passPreviousResponse: step.pass_previous_response ?? true,
    policyContents,
    knowledgeContents,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) =>
      normalizeStepFromRaw(
        sub,
        pieceDir,
        sections,
        result.provider,
        result.model,
        result.providerOptions,
        context,
        projectOverrides,
        globalOverrides,
        pieceArpeggioPolicy,
        pieceMcpServersPolicy,
      ),
    );
    if (step.concurrency != null) {
      result.concurrency = step.concurrency;
    }
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
  raw: { persona?: string; instruction?: string; rules: Array<{ condition: string; next: string }> },
  pieceDir: string,
  sections: PieceSections,
  context?: FacetResolutionContext,
): LoopMonitorJudge {
  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, pieceDir, context);
  const resolvedInstruction = raw.instruction
    ? resolveRefToContent(raw.instruction, sections.resolvedInstructions, pieceDir, 'instructions', context)
    : undefined;

  return {
    persona: personaSpec,
    personaPath,
    instruction: resolvedInstruction,
    rules: raw.rules.map((r) => ({ condition: r.condition, next: r.next })),
  };
}

/**
 * Normalize raw loop monitors from YAML into internal format.
 */
function normalizeLoopMonitors(
  raw: Array<{ cycle: string[]; threshold: number; judge: { persona?: string; instruction?: string; rules: Array<{ condition: string; next: string }> } }> | undefined,
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
  projectOverrides?: PieceOverrides,
  globalOverrides?: PieceOverrides,
  pieceRuntimePreparePolicy?: PieceRuntimePrepareConfig,
  pieceArpeggioPolicy?: PieceArpeggioConfig,
  pieceMcpServersPolicy?: PieceMcpServersConfig,
): PieceConfig {
  warnLegacyWorkflowYamlKeysOncePerProcess(raw);
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

  const normalizedPieceProvider = normalizeProviderReference(
    parsed.piece_config?.provider as RawProviderReference,
    undefined,
    parsed.piece_config?.provider_options as RawStep['provider_options'],
  );
  const pieceProvider = normalizedPieceProvider.provider;
  const pieceModel = normalizedPieceProvider.model;
  const pieceProviderOptions = normalizedPieceProvider.providerOptions;
  const pieceRuntime = normalizeRuntime(parsed.piece_config?.runtime);
  validatePieceRuntimePrepare(pieceRuntime, pieceRuntimePreparePolicy);

  const movements: PieceMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(
      step,
      pieceDir,
      sections,
      pieceProvider,
      pieceModel,
      pieceProviderOptions,
      context,
      projectOverrides,
      globalOverrides,
      pieceArpeggioPolicy,
      pieceMcpServersPolicy,
    ),
  );

  // Schema guarantees movements.min(1)
  const initialMovement = parsed.initial_movement ?? movements[0]!.name;

  return {
    name: parsed.name,
    description: parsed.description,
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
    throw new Error(`Workflow file not found: ${filePath}`);
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

  // Load config overrides from project and global configs
  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  const projectOverrides = projectConfig.pieceOverrides;
  const globalOverrides = globalConfig.pieceOverrides;
  const pieceRuntimePreparePolicy = resolvePieceRuntimePreparePolicy(
    globalConfig.pieceRuntimePrepare,
    projectConfig.pieceRuntimePrepare,
  );
  const pieceArpeggioPolicy = resolvePieceArpeggioPolicy(globalConfig.pieceArpeggio, projectConfig.pieceArpeggio);
  const pieceMcpServersPolicy = resolvePieceMcpServersPolicy(globalConfig.pieceMcpServers, projectConfig.pieceMcpServers);

  return normalizePieceConfig(
    raw,
    pieceDir,
    context,
    projectOverrides,
    globalOverrides,
    pieceRuntimePreparePolicy,
    pieceArpeggioPolicy,
    pieceMcpServersPolicy,
  );
}

function resolvePieceRuntimePreparePolicy(
  globalPolicy: PieceRuntimePrepareConfig | undefined,
  projectPolicy: PieceRuntimePrepareConfig | undefined,
): PieceRuntimePrepareConfig | undefined {
  const policy: PieceRuntimePrepareConfig = {};

  if (globalPolicy?.customScripts !== undefined) {
    policy.customScripts = globalPolicy.customScripts;
  }
  if (projectPolicy?.customScripts !== undefined) {
    policy.customScripts = projectPolicy.customScripts;
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function validatePieceRuntimePrepare(
  runtime: PieceConfig['runtime'],
  policy?: PieceRuntimePrepareConfig,
): void {
  const prepareEntries = runtime?.prepare ?? [];
  if (prepareEntries.length === 0) return;

  for (const entry of prepareEntries) {
    if (isRuntimePreparePreset(entry)) continue;
    if (policy?.customScripts === true) continue;
    throw new Error(
      `Piece runtime.prepare custom script "${entry}" is disabled by default. `
      + 'Configure piece_runtime_prepare.custom_scripts in project/global config to allow it.'
    );
  }
}

function resolvePieceArpeggioPolicy(
  globalPolicy: PieceArpeggioConfig | undefined,
  projectPolicy: PieceArpeggioConfig | undefined,
): PieceArpeggioConfig | undefined {
  const policy: PieceArpeggioConfig = {};

  if (globalPolicy?.customDataSourceModules !== undefined) {
    policy.customDataSourceModules = globalPolicy.customDataSourceModules;
  }
  if (globalPolicy?.customMergeInlineJs !== undefined) {
    policy.customMergeInlineJs = globalPolicy.customMergeInlineJs;
  }
  if (globalPolicy?.customMergeFiles !== undefined) {
    policy.customMergeFiles = globalPolicy.customMergeFiles;
  }

  if (projectPolicy?.customDataSourceModules !== undefined) {
    policy.customDataSourceModules = projectPolicy.customDataSourceModules;
  }
  if (projectPolicy?.customMergeInlineJs !== undefined) {
    policy.customMergeInlineJs = projectPolicy.customMergeInlineJs;
  }
  if (projectPolicy?.customMergeFiles !== undefined) {
    policy.customMergeFiles = projectPolicy.customMergeFiles;
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function validatePieceArpeggio(
  movementName: string,
  raw: RawStep['arpeggio'],
  policy?: PieceArpeggioConfig,
): void {
  if (!raw) return;

  if (raw.source !== 'csv' && policy?.customDataSourceModules !== true) {
    throw new Error(
      `Movement "${movementName}" uses Arpeggio source "${raw.source}", which is disabled by default for pieces. `
      + 'Configure piece_arpeggio.custom_data_source_modules in project/global config to allow it.'
    );
  }

  if (raw.merge?.inline_js && policy?.customMergeInlineJs !== true) {
    throw new Error(
      `Movement "${movementName}" uses Arpeggio inline_js, which is disabled by default for pieces. `
      + 'Configure piece_arpeggio.custom_merge_inline_js in project/global config to allow it.'
    );
  }

  if (raw.merge?.file && policy?.customMergeFiles !== true) {
    throw new Error(
      `Movement "${movementName}" uses Arpeggio merge.file, which is disabled by default for pieces. `
      + 'Configure piece_arpeggio.custom_merge_files in project/global config to allow it.'
    );
  }
}

function resolvePieceMcpServersPolicy(
  globalPolicy: PieceMcpServersConfig | undefined,
  projectPolicy: PieceMcpServersConfig | undefined,
): PieceMcpServersConfig | undefined {
  const policy: PieceMcpServersConfig = {};

  if (globalPolicy?.stdio !== undefined) policy.stdio = globalPolicy.stdio;
  if (globalPolicy?.sse !== undefined) policy.sse = globalPolicy.sse;
  if (globalPolicy?.http !== undefined) policy.http = globalPolicy.http;

  if (projectPolicy?.stdio !== undefined) policy.stdio = projectPolicy.stdio;
  if (projectPolicy?.sse !== undefined) policy.sse = projectPolicy.sse;
  if (projectPolicy?.http !== undefined) policy.http = projectPolicy.http;

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function isPieceMcpTransportAllowed(
  config: NonNullable<NonNullable<RawStep['mcp_servers']>[string]>,
  policy: PieceMcpServersConfig | undefined,
): boolean {
  const transport = config.type ?? 'stdio';
  if (transport === 'stdio') return policy?.stdio ?? false;
  if (transport === 'sse') return policy?.sse ?? false;
  return policy?.http ?? false;
}

function validatePieceMcpServers(
  movementName: string,
  mcpServers: RawStep['mcp_servers'],
  policy: PieceMcpServersConfig | undefined,
): void {
  if (!mcpServers) return;

  for (const [serverName, config] of Object.entries(mcpServers)) {
    if (isPieceMcpTransportAllowed(config, policy)) continue;
    const transport = config.type ?? 'stdio';
    throw new Error(
      `Movement "${movementName}" uses MCP server "${serverName}" with transport "${transport}", `
      + 'which is disabled by default for pieces. '
      + 'Configure piece_mcp_servers in project/global config to allow it.'
    );
  }
}
