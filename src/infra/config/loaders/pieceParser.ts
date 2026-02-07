/**
 * Piece YAML parsing and normalization.
 *
 * Converts raw YAML structures into internal PieceConfig format,
 * resolving persona paths, content paths, and rule conditions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { PieceConfigRawSchema, PieceMovementRawSchema } from '../../../core/models/index.js';
import type { PieceConfig, PieceMovement, PieceRule, OutputContractEntry, OutputContractLabelPath, OutputContractItem, LoopMonitorConfig, LoopMonitorJudge } from '../../../core/models/index.js';

type RawStep = z.output<typeof PieceMovementRawSchema>;

/** Resolve a resource spec to an absolute file path. */
function resolveResourcePath(spec: string, pieceDir: string): string {
  if (spec.startsWith('./')) return join(pieceDir, spec.slice(2));
  if (spec.startsWith('~')) return join(homedir(), spec.slice(1));
  if (spec.startsWith('/')) return spec;
  return join(pieceDir, spec);
}

/**
 * Resolve a resource spec to its file content.
 * If the spec ends with .md and the file exists, returns file content.
 * Otherwise returns the spec as-is (treated as inline content).
 */
function resolveResourceContent(spec: string | undefined, pieceDir: string): string | undefined {
  if (spec == null) return undefined;
  if (spec.endsWith('.md')) {
    const resolved = resolveResourcePath(spec, pieceDir);
    if (existsSync(resolved)) return readFileSync(resolved, 'utf-8');
  }
  return spec;
}

/**
 * Resolve a section reference to content.
 * Looks up ref in resolvedMap first, then falls back to resolveResourceContent.
 */
function resolveRefToContent(
  ref: string,
  resolvedMap: Record<string, string> | undefined,
  pieceDir: string,
): string | undefined {
  const mapped = resolvedMap?.[ref];
  if (mapped) return mapped;
  return resolveResourceContent(ref, pieceDir);
}

/** Resolve multiple references to content strings (for fields that accept string | string[]). */
function resolveRefList(
  refs: string | string[] | undefined,
  resolvedMap: Record<string, string> | undefined,
  pieceDir: string,
): string[] | undefined {
  if (refs == null) return undefined;
  const list = Array.isArray(refs) ? refs : [refs];
  const contents: string[] = [];
  for (const ref of list) {
    const content = resolveRefToContent(ref, resolvedMap, pieceDir);
    if (content) contents.push(content);
  }
  return contents.length > 0 ? contents : undefined;
}

/** Resolve a piece-level section map (each value resolved to file content or inline). */
function resolveSectionMap(
  raw: Record<string, string> | undefined,
  pieceDir: string,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const content = resolveResourceContent(value, pieceDir);
    if (content) resolved[name] = content;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Extract display name from persona path (e.g., "coder.md" → "coder"). */
function extractPersonaDisplayName(personaPath: string): string {
  return basename(personaPath, '.md');
}

/** Resolve persona from YAML field to spec + absolute path. */
function resolvePersona(
  rawPersona: string | undefined,
  sections: PieceSections,
  pieceDir: string,
): { personaSpec?: string; personaPath?: string } {
  if (!rawPersona) return {};
  const personaSpec = sections.personas?.[rawPersona] ?? rawPersona;

  const resolved = resolveResourcePath(personaSpec, pieceDir);
  const personaPath = existsSync(resolved) ? resolved : undefined;
  return { personaSpec, personaPath };
}

/** Pre-resolved section maps passed to movement normalization. */
interface PieceSections {
  /** Persona name → file path (raw, not content-resolved) */
  personas?: Record<string, string>;
  /** Policy name → resolved content */
  resolvedPolicies?: Record<string, string>;
  /** Knowledge name → resolved content */
  resolvedKnowledge?: Record<string, string>;
  /** Instruction name → resolved content */
  resolvedInstructions?: Record<string, string>;
  /** Report format name → resolved content */
  resolvedReportFormats?: Record<string, string>;
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
): OutputContractEntry[] | undefined {
  if (raw?.report == null || raw.report.length === 0) return undefined;

  const result: OutputContractEntry[] = [];

  for (const entry of raw.report) {
    if (isOutputContractItem(entry)) {
      // Item format: {name, order?, format?}
      const item: OutputContractItem = {
        name: entry.name,
        order: entry.order ? resolveRefToContent(entry.order, resolvedReportFormats, pieceDir) : undefined,
        format: entry.format ? resolveRefToContent(entry.format, resolvedReportFormats, pieceDir) : undefined,
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

/** Normalize a raw step into internal PieceMovement format. */
function normalizeStepFromRaw(
  step: RawStep,
  pieceDir: string,
  sections: PieceSections,
): PieceMovement {
  const rules: PieceRule[] | undefined = step.rules?.map(normalizeRule);

  const rawPersona = (step as Record<string, unknown>).persona as string | undefined;
  const { personaSpec, personaPath } = resolvePersona(rawPersona, sections, pieceDir);

  const displayName: string | undefined = (step as Record<string, unknown>).persona_name as string
    || undefined;

  const policyRef = (step as Record<string, unknown>).policy as string | string[] | undefined;
  const policyContents = resolveRefList(policyRef, sections.resolvedPolicies, pieceDir);

  const knowledgeRef = (step as Record<string, unknown>).knowledge as string | string[] | undefined;
  const knowledgeContents = resolveRefList(knowledgeRef, sections.resolvedKnowledge, pieceDir);

  const expandedInstruction = step.instruction
    ? resolveRefToContent(step.instruction, sections.resolvedInstructions, pieceDir)
    : undefined;

  const result: PieceMovement = {
    name: step.name,
    description: step.description,
    persona: personaSpec,
    session: step.session,
    personaDisplayName: displayName || (personaSpec ? extractPersonaDisplayName(personaSpec) : step.name),
    personaPath,
    allowedTools: step.allowed_tools,
    provider: step.provider,
    model: step.model,
    permissionMode: step.permission_mode,
    edit: step.edit,
    instructionTemplate: resolveResourceContent(step.instruction_template, pieceDir) || expandedInstruction || '{task}',
    rules,
    outputContracts: normalizeOutputContracts(step.output_contracts, pieceDir, sections.resolvedReportFormats),
    qualityGates: step.quality_gates,
    passPreviousResponse: step.pass_previous_response ?? true,
    policyContents,
    knowledgeContents,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) => normalizeStepFromRaw(sub, pieceDir, sections));
  }

  return result;
}

/** Normalize a raw loop monitor judge from YAML into internal format. */
function normalizeLoopMonitorJudge(
  raw: { persona?: string; instruction_template?: string; rules: Array<{ condition: string; next: string }> },
  pieceDir: string,
  sections: PieceSections,
): LoopMonitorJudge {
  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, pieceDir);

  return {
    persona: personaSpec,
    personaPath,
    instructionTemplate: resolveResourceContent(raw.instruction_template, pieceDir),
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
): LoopMonitorConfig[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((monitor) => ({
    cycle: monitor.cycle,
    threshold: monitor.threshold,
    judge: normalizeLoopMonitorJudge(monitor.judge, pieceDir, sections),
  }));
}

/** Convert raw YAML piece config to internal format. */
export function normalizePieceConfig(raw: unknown, pieceDir: string): PieceConfig {
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

  const movements: PieceMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(step, pieceDir, sections),
  );

  // Schema guarantees movements.min(1)
  const initialMovement = parsed.initial_movement ?? movements[0]!.name;

  return {
    name: parsed.name,
    description: parsed.description,
    personas: parsed.personas,
    policies: resolvedPolicies,
    knowledge: resolvedKnowledge,
    instructions: resolvedInstructions,
    reportFormats: resolvedReportFormats,
    movements,
    initialMovement,
    maxIterations: parsed.max_iterations,
    loopMonitors: normalizeLoopMonitors(parsed.loop_monitors, pieceDir, sections),
    answerAgent: parsed.answer_agent,
  };
}

/**
 * Load a piece from a YAML file.
 * @param filePath Path to the piece YAML file
 */
export function loadPieceFromFile(filePath: string): PieceConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Piece file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const pieceDir = dirname(filePath);
  return normalizePieceConfig(raw, pieceDir);
}
