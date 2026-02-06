/**
 * Piece YAML parsing and normalization.
 *
 * Converts raw YAML structures into internal PieceConfig format,
 * resolving agent paths, content paths, and rule conditions.
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
 * Resolve agent path from piece specification.
 * - Relative path (./agent.md): relative to piece directory
 * - Absolute path (/path/to/agent.md or ~/...): use as-is
 */
function resolveAgentPathForPiece(agentSpec: string, pieceDir: string): string {
  if (agentSpec.startsWith('./')) {
    return join(pieceDir, agentSpec.slice(2));
  }
  if (agentSpec.startsWith('~')) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '';
    return join(homedir, agentSpec.slice(1));
  }
  if (agentSpec.startsWith('/')) {
    return agentSpec;
  }
  return join(pieceDir, agentSpec);
}

/**
 * Extract display name from agent path.
 * e.g., "~/.takt/agents/default/coder.md" -> "coder"
 */
function extractAgentDisplayName(agentPath: string): string {
  return basename(agentPath, '.md');
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

/** Check if a raw report value is the object form (has 'name' property). */
function isReportObject(raw: unknown): raw is { name: string; order?: string; format?: string } {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'name' in raw;
}

/**
 * Normalize the raw report field from YAML into internal format.
 */
function normalizeReport(
  raw: string | Record<string, string>[] | { name: string; order?: string; format?: string } | undefined,
  pieceDir: string,
): string | ReportConfig[] | ReportObjectConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (isReportObject(raw)) {
    return {
      name: raw.name,
      order: resolveContentPath(raw.order, pieceDir),
      format: resolveContentPath(raw.format, pieceDir),
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

/** Normalize a raw step into internal PieceMovement format. */
function normalizeStepFromRaw(step: RawStep, pieceDir: string): PieceMovement {
  const rules: PieceRule[] | undefined = step.rules?.map(normalizeRule);
  const agentSpec: string | undefined = step.agent || undefined;

  // Resolve agent path: if the resolved path exists on disk, use it; otherwise leave agentPath undefined
  // so that the runner treats agentSpec as an inline system prompt string.
  let agentPath: string | undefined;
  if (agentSpec) {
    const resolved = resolveAgentPathForPiece(agentSpec, pieceDir);
    if (existsSync(resolved)) {
      agentPath = resolved;
    }
  }

  const result: PieceMovement = {
    name: step.name,
    description: step.description,
    agent: agentSpec,
    session: step.session,
    agentDisplayName: step.agent_name || (agentSpec ? extractAgentDisplayName(agentSpec) : step.name),
    agentPath,
    allowedTools: step.allowed_tools,
    provider: step.provider,
    model: step.model,
    permissionMode: step.permission_mode,
    edit: step.edit,
    instructionTemplate: resolveContentPath(step.instruction_template, pieceDir) || step.instruction || '{task}',
    rules,
    report: normalizeReport(step.report, pieceDir),
    passPreviousResponse: step.pass_previous_response ?? true,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) => normalizeStepFromRaw(sub, pieceDir));
  }

  return result;
}

/**
 * Normalize a raw loop monitor judge from YAML into internal format.
 * Resolves agent paths and instruction_template content paths.
 */
function normalizeLoopMonitorJudge(
  raw: { agent?: string; instruction_template?: string; rules: Array<{ condition: string; next: string }> },
  pieceDir: string,
): LoopMonitorJudge {
  const agentSpec = raw.agent || undefined;

  let agentPath: string | undefined;
  if (agentSpec) {
    const resolved = resolveAgentPathForPiece(agentSpec, pieceDir);
    if (existsSync(resolved)) {
      agentPath = resolved;
    }
  }

  return {
    agent: agentSpec,
    agentPath,
    instructionTemplate: resolveContentPath(raw.instruction_template, pieceDir),
    rules: raw.rules.map((r) => ({ condition: r.condition, next: r.next })),
  };
}

/**
 * Normalize raw loop monitors from YAML into internal format.
 */
function normalizeLoopMonitors(
  raw: Array<{ cycle: string[]; threshold: number; judge: { agent?: string; instruction_template?: string; rules: Array<{ condition: string; next: string }> } }> | undefined,
  pieceDir: string,
): LoopMonitorConfig[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((monitor) => ({
    cycle: monitor.cycle,
    threshold: monitor.threshold,
    judge: normalizeLoopMonitorJudge(monitor.judge, pieceDir),
  }));
}

/**
 * Convert raw YAML piece config to internal format.
 * Agent paths are resolved relative to the piece directory.
 */
export function normalizePieceConfig(raw: unknown, pieceDir: string): PieceConfig {
  const parsed = PieceConfigRawSchema.parse(raw);

  const movements: PieceMovement[] = parsed.movements.map((step) =>
    normalizeStepFromRaw(step, pieceDir),
  );

  const initialMovement = parsed.initial_movement ?? movements[0]?.name ?? '';

  return {
    name: parsed.name,
    description: parsed.description,
    movements,
    initialMovement,
    maxIterations: parsed.max_iterations,
    loopMonitors: normalizeLoopMonitors(parsed.loop_monitors, pieceDir),
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
