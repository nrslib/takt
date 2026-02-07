/**
 * Piece YAML parsing and normalization.
 *
 * Converts raw YAML structures into internal PieceConfig format,
 * resolving persona paths, content paths, and rule conditions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { PieceConfigRawSchema, PieceMovementRawSchema } from '../../../core/models/index.js';
import type { PieceConfig, PieceMovement, PieceRule, ReportConfig, ReportObjectConfig, LoopMonitorConfig, LoopMonitorJudge } from '../../../core/models/index.js';

/** Parsed movement type from Zod schema (replaces `any`) */
type RawStep = z.output<typeof PieceMovementRawSchema>;

/**
 * Resolve persona path from piece specification.
 * - Relative path (./persona.md): relative to piece directory
 * - Absolute path (/path/to/persona.md or ~/...): use as-is
 */
function resolvePersonaPathForPiece(personaSpec: string, pieceDir: string): string {
  if (personaSpec.startsWith('./')) {
    return join(pieceDir, personaSpec.slice(2));
  }
  if (personaSpec.startsWith('~')) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '';
    return join(homedir, personaSpec.slice(1));
  }
  if (personaSpec.startsWith('/')) {
    return personaSpec;
  }
  return join(pieceDir, personaSpec);
}

/**
 * Extract display name from persona path.
 * e.g., "~/.takt/personas/coder.md" -> "coder"
 */
function extractPersonaDisplayName(personaPath: string): string {
  return basename(personaPath, '.md');
}

/**
 * Resolve a string value that may be a file path.
 * If the value ends with .md and the file exists (resolved relative to pieceDir),
 * read and return the file contents. Otherwise return the value as-is.
 */
function resolveContentPath(value: string | undefined, pieceDir: string): string | undefined {
  if (value == null) return undefined;
  if (value.endsWith('.md')) {
    let resolvedPath = value;
    if (value.startsWith('./')) {
      resolvedPath = join(pieceDir, value.slice(2));
    } else if (value.startsWith('~')) {
      const homedir = process.env.HOME || process.env.USERPROFILE || '';
      resolvedPath = join(homedir, value.slice(1));
    } else if (!value.startsWith('/')) {
      resolvedPath = join(pieceDir, value);
    }
    if (existsSync(resolvedPath)) {
      return readFileSync(resolvedPath, 'utf-8');
    }
  }
  return value;
}

/**
 * Resolve a value from a section map by key lookup.
 * If the value matches a key in sectionMap, return the mapped value.
 * Otherwise return the value as-is (treated as file path or inline content).
 */
function resolveSectionReference(
  value: string,
  sectionMap: Record<string, string> | undefined,
): string {
  const resolved = sectionMap?.[value];
  return resolved ?? value;
}

/** Section maps parsed from piece YAML for section reference expansion */
interface PieceSections {
  personas?: Record<string, string>;
  stances?: Record<string, string>;
  /** Stances resolved to file content (for backward-compat plain name lookup) */
  resolvedStances?: Record<string, string>;
  instructions?: Record<string, string>;
  reportFormats?: Record<string, string>;
}

/** Check if a raw report value is the object form (has 'name' property). */
function isReportObject(raw: unknown): raw is { name: string; order?: string; format?: string } {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'name' in raw;
}

/**
 * Normalize the raw report field from YAML into internal format.
 * Supports section references for format/order fields via rawReportFormats section.
 */
function normalizeReport(
  raw: string | Record<string, string>[] | { name: string; order?: string; format?: string } | undefined,
  pieceDir: string,
  rawReportFormats?: Record<string, string>,
): string | ReportConfig[] | ReportObjectConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (isReportObject(raw)) {
    const expandedFormat = raw.format ? resolveSectionReference(raw.format, rawReportFormats) : undefined;
    const expandedOrder = raw.order ? resolveSectionReference(raw.order, rawReportFormats) : undefined;
    return {
      name: raw.name,
      order: resolveContentPath(expandedOrder, pieceDir),
      format: resolveContentPath(expandedFormat, pieceDir),
    };
  }
  return (raw as Record<string, string>[]).flatMap((entry) =>
    Object.entries(entry).map(([label, path]) => ({ label, path })),
  );
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

/**
 * Resolve stance references for a movement.
 *
 * Resolution priority:
 * 1. Section key → look up in resolvedStances (pre-resolved content)
 * 2. File path (`./path`, `../path`, `*.md`) → resolve file directly
 * 3. Unknown names are silently ignored
 */
function resolveStanceContents(
  stanceRef: string | string[] | undefined,
  sections: PieceSections,
  pieceDir: string,
): string[] | undefined {
  if (stanceRef == null) return undefined;
  const refs = Array.isArray(stanceRef) ? stanceRef : [stanceRef];
  const contents: string[] = [];
  for (const ref of refs) {
    const sectionContent = sections.resolvedStances?.[ref];
    if (sectionContent) {
      contents.push(sectionContent);
    } else if (ref.endsWith('.md') || ref.startsWith('./') || ref.startsWith('../')) {
      const content = resolveContentPath(ref, pieceDir);
      if (content) contents.push(content);
    }
  }
  return contents.length > 0 ? contents : undefined;
}

/** Normalize a raw step into internal PieceMovement format. */
function normalizeStepFromRaw(
  step: RawStep,
  pieceDir: string,
  sections: PieceSections,
): PieceMovement {
  const rules: PieceRule[] | undefined = step.rules?.map(normalizeRule);

  // Resolve persona via section reference expansion
  const rawPersona = (step as Record<string, unknown>).persona as string | undefined;
  const expandedPersona = rawPersona ? resolveSectionReference(rawPersona, sections.personas) : undefined;
  const personaSpec: string | undefined = expandedPersona || undefined;

  // Resolve persona path: if the resolved path exists on disk, use it; otherwise leave personaPath undefined
  // so that the runner treats personaSpec as an inline system prompt string.
  let personaPath: string | undefined;
  if (personaSpec) {
    const resolved = resolvePersonaPathForPiece(personaSpec, pieceDir);
    if (existsSync(resolved)) {
      personaPath = resolved;
    }
  }

  const displayName: string | undefined = (step as Record<string, unknown>).persona_name as string
    || undefined;

  // Resolve stance references (supports section key, file paths)
  const stanceRef = (step as Record<string, unknown>).stance as string | string[] | undefined;
  const stanceContents = resolveStanceContents(stanceRef, sections, pieceDir);

  // Resolve instruction: instruction_template > instruction (with section reference expansion) > default
  const expandedInstruction = step.instruction
    ? resolveContentPath(resolveSectionReference(step.instruction, sections.instructions), pieceDir)
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
    instructionTemplate: resolveContentPath(step.instruction_template, pieceDir) || expandedInstruction || '{task}',
    rules,
    report: normalizeReport(step.report, pieceDir, sections.reportFormats),
    passPreviousResponse: step.pass_previous_response ?? true,
    stanceContents,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) => normalizeStepFromRaw(sub, pieceDir, sections));
  }

  return result;
}

/**
 * Normalize a raw loop monitor judge from YAML into internal format.
 * Resolves persona paths and instruction_template content paths.
 */
function normalizeLoopMonitorJudge(
  raw: { persona?: string; instruction_template?: string; rules: Array<{ condition: string; next: string }> },
  pieceDir: string,
  sections: PieceSections,
): LoopMonitorJudge {
  const rawPersona = raw.persona || undefined;
  const expandedPersona = rawPersona ? resolveSectionReference(rawPersona, sections.personas) : undefined;
  const personaSpec = expandedPersona || undefined;

  let personaPath: string | undefined;
  if (personaSpec) {
    const resolved = resolvePersonaPathForPiece(personaSpec, pieceDir);
    if (existsSync(resolved)) {
      personaPath = resolved;
    }
  }

  return {
    persona: personaSpec,
    personaPath,
    instructionTemplate: resolveContentPath(raw.instruction_template, pieceDir),
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

/**
 * Resolve a piece-level section map.
 * Each value is resolved via resolveContentPath (supports .md file references).
 * Used for stances, instructions, and report_formats.
 */
function resolveSectionMap(
  raw: Record<string, string> | undefined,
  pieceDir: string,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const content = resolveContentPath(value, pieceDir);
    if (content) {
      resolved[name] = content;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Convert raw YAML piece config to internal format.
 * Agent paths are resolved relative to the piece directory.
 */
export function normalizePieceConfig(raw: unknown, pieceDir: string): PieceConfig {
  const parsed = PieceConfigRawSchema.parse(raw);

  // Resolve piece-level section maps
  const resolvedStances = resolveSectionMap(parsed.stances, pieceDir);
  const resolvedInstructions = resolveSectionMap(parsed.instructions, pieceDir);
  const resolvedReportFormats = resolveSectionMap(parsed.report_formats, pieceDir);

  // Build sections for section reference expansion in movements
  const sections: PieceSections = {
    personas: parsed.personas,
    stances: parsed.stances,
    resolvedStances,
    instructions: parsed.instructions,
    reportFormats: parsed.report_formats,
  };

  const movements: PieceMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(step, pieceDir, sections),
  );

  const initialMovement = parsed.initial_movement ?? movements[0]?.name ?? '';

  return {
    name: parsed.name,
    description: parsed.description,
    personas: parsed.personas,
    stances: resolvedStances,
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
