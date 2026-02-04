/**
 * Zod schemas for configuration validation
 *
 * Note: Uses zod v4 syntax for SDK compatibility.
 */

import { z } from 'zod/v4';
import { DEFAULT_LANGUAGE } from '../../shared/constants.js';

/** Agent model schema (opus, sonnet, haiku) */
export const AgentModelSchema = z.enum(['opus', 'sonnet', 'haiku']).default('sonnet');

/** Agent configuration schema */
export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  model: AgentModelSchema,
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
});

/** Claude CLI configuration schema */
export const ClaudeConfigSchema = z.object({
  command: z.string().default('claude'),
  timeout: z.number().int().positive().default(300000),
});

/** TAKT global tool configuration schema */
export const TaktConfigSchema = z.object({
  defaultModel: AgentModelSchema,
  defaultPiece: z.string().default('default'),
  agentDirs: z.array(z.string()).default([]),
  pieceDirs: z.array(z.string()).default([]),
  sessionDir: z.string().optional(),
  claude: ClaudeConfigSchema.default({ command: 'claude', timeout: 300000 }),
});

/** Agent type schema */
export const AgentTypeSchema = z.enum(['coder', 'architect', 'supervisor', 'custom']);

/** Status schema */
export const StatusSchema = z.enum([
  'pending',
  'done',
  'blocked',
  'approved',
  'rejected',
  'improve',
  'cancelled',
  'interrupted',
  'answer',
]);

/** Permission mode schema for tool execution */
export const PermissionModeSchema = z.enum(['readonly', 'edit', 'full']);

/**
 * Report object schema (new structured format).
 *
 * YAML format:
 *   report:
 *     name: 00-plan.md
 *     order: |
 *       **レポート出力:** {report:00-plan.md} に出力してください。
 *     format: |
 *       **レポートフォーマット:**
 *       ```markdown
 *       ...
 *       ```
 */
export const ReportObjectSchema = z.object({
  /** Report file name */
  name: z.string().min(1),
  /** Instruction prepended before instruction_template (e.g., output destination) */
  order: z.string().optional(),
  /** Instruction appended after instruction_template (e.g., output format) */
  format: z.string().optional(),
});

/**
 * Report field schema.
 *
 * YAML formats:
 *   report: 00-plan.md          # single file (string)
 *   report:                     # multiple files (label: path map entries)
 *     - Scope: 01-scope.md
 *     - Decisions: 02-decisions.md
 *   report:                     # object form (name + order + format)
 *     name: 00-plan.md
 *     order: ...
 *     format: ...
 *
 * Array items are parsed as single-key objects: [{Scope: "01-scope.md"}, ...]
 */
export const ReportFieldSchema = z.union([
  z.string().min(1),
  z.array(z.record(z.string(), z.string())).min(1),
  ReportObjectSchema,
]);

/** Rule-based transition schema (new unified format) */
export const PieceRuleSchema = z.object({
  /** Human-readable condition text */
  condition: z.string().min(1),
  /** Next movement name (e.g., implement, COMPLETE, ABORT). Optional for parallel sub-movements (parent handles routing). */
  next: z.string().min(1).optional(),
  /** Template for additional AI output */
  appendix: z.string().optional(),
  /** Require user input before continuing (interactive mode only) */
  requires_user_input: z.boolean().optional(),
  /** Rule applies only in interactive mode */
  interactive_only: z.boolean().optional(),
});

/** Sub-movement schema for parallel execution */
export const ParallelSubMovementRawSchema = z.object({
  name: z.string().min(1),
  agent: z.string().optional(),
  agent_name: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
  model: z.string().optional(),
  permission_mode: PermissionModeSchema.optional(),
  edit: z.boolean().optional(),
  instruction: z.string().optional(),
  instruction_template: z.string().optional(),
  rules: z.array(PieceRuleSchema).optional(),
  report: ReportFieldSchema.optional(),
  pass_previous_response: z.boolean().optional().default(true),
});

/** Piece movement schema - raw YAML format */
export const PieceMovementRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Agent is required for normal movements, optional for parallel container movements */
  agent: z.string().optional(),
  /** Session handling for this movement */
  session: z.enum(['continue', 'refresh']).optional(),
  /** Display name for the agent (shown in output). Falls back to agent basename if not specified */
  agent_name: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
  model: z.string().optional(),
  /** Permission mode for tool execution in this movement */
  permission_mode: PermissionModeSchema.optional(),
  /** Whether this movement is allowed to edit project files */
  edit: z.boolean().optional(),
  instruction: z.string().optional(),
  instruction_template: z.string().optional(),
  /** Rules for movement routing */
  rules: z.array(PieceRuleSchema).optional(),
  /** Report file(s) for this movement */
  report: ReportFieldSchema.optional(),
  pass_previous_response: z.boolean().optional().default(true),
  /** Sub-movements to execute in parallel */
  parallel: z.array(ParallelSubMovementRawSchema).optional(),
});

/** Piece configuration schema - raw YAML format */
export const PieceConfigRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  movements: z.array(PieceMovementRawSchema).min(1),
  initial_movement: z.string().optional(),
  max_iterations: z.number().int().positive().optional().default(10),
  answer_agent: z.string().optional(),
});

/** Custom agent configuration schema */
export const CustomAgentConfigSchema = z.object({
  name: z.string().min(1),
  prompt_file: z.string().optional(),
  prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  claude_agent: z.string().optional(),
  claude_skill: z.string().optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
  model: z.string().optional(),
}).refine(
  (data) => data.prompt_file || data.prompt || data.claude_agent || data.claude_skill,
  { message: 'Agent must have prompt_file, prompt, claude_agent, or claude_skill' }
);

/** Debug config schema */
export const DebugConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  log_file: z.string().optional(),
});

/** Language setting schema */
export const LanguageSchema = z.enum(['en', 'ja']);

/** Pipeline execution config schema */
export const PipelineConfigSchema = z.object({
  default_branch_prefix: z.string().optional(),
  commit_message_template: z.string().optional(),
  pr_body_template: z.string().optional(),
});

/** Piece category config schema (recursive) */
export type PieceCategoryConfigNode = {
  pieces?: string[];
  [key: string]: PieceCategoryConfigNode | string[] | undefined;
};

export const PieceCategoryConfigNodeSchema: z.ZodType<PieceCategoryConfigNode> = z.lazy(() =>
  z.object({
    pieces: z.array(z.string()).optional(),
  }).catchall(PieceCategoryConfigNodeSchema)
);

export const PieceCategoryConfigSchema = z.record(z.string(), PieceCategoryConfigNodeSchema);

/** Global config schema */
export const GlobalConfigSchema = z.object({
  language: LanguageSchema.optional().default(DEFAULT_LANGUAGE),
  default_piece: z.string().optional().default('default'),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  provider: z.enum(['claude', 'codex', 'mock']).optional().default('claude'),
  model: z.string().optional(),
  debug: DebugConfigSchema.optional(),
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktree_dir: z.string().optional(),
  /** List of builtin piece/agent names to exclude from fallback loading */
  disabled_builtins: z.array(z.string()).optional().default([]),
  /** Enable builtin pieces from resources/global/{lang}/pieces */
  enable_builtin_pieces: z.boolean().optional(),
  /** Anthropic API key for Claude Code SDK (overridden by TAKT_ANTHROPIC_API_KEY env var) */
  anthropic_api_key: z.string().optional(),
  /** OpenAI API key for Codex SDK (overridden by TAKT_OPENAI_API_KEY env var) */
  openai_api_key: z.string().optional(),
  /** Pipeline execution settings */
  pipeline: PipelineConfigSchema.optional(),
  /** Minimal output mode for CI - suppress AI output to prevent sensitive information leaks */
  minimal_output: z.boolean().optional().default(false),
  /** Path to bookmarks file (default: ~/.takt/preferences/bookmarks.yaml) */
  bookmarks_file: z.string().optional(),
  /** Path to piece categories file (default: ~/.takt/preferences/piece-categories.yaml) */
  piece_categories_file: z.string().optional(),
});

/** Project config schema */
export const ProjectConfigSchema = z.object({
  piece: z.string().optional(),
  agents: z.array(CustomAgentConfigSchema).optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
});
