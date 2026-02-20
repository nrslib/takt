/**
 * Zod schemas for configuration validation
 *
 * Note: Uses zod v4 syntax for SDK compatibility.
 */

import { z } from 'zod/v4';
import { DEFAULT_LANGUAGE } from '../../shared/constants.js';
import { McpServersSchema } from './mcp-schemas.js';
import { INTERACTIVE_MODES } from './interactive-mode.js';

export { McpServerConfigSchema, McpServersSchema } from './mcp-schemas.js';

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
  'error',
  'approved',
  'rejected',
  'improve',
  'cancelled',
  'interrupted',
  'answer',
]);

/** Permission mode schema for tool execution */
export const PermissionModeSchema = z.enum(['readonly', 'edit', 'full']);
/** Claude sandbox settings schema */
export const ClaudeSandboxSchema = z.object({
  allow_unsandboxed_commands: z.boolean().optional(),
  excluded_commands: z.array(z.string()).optional(),
}).optional();

/** Provider-specific movement options schema */
export const MovementProviderOptionsSchema = z.object({
  codex: z.object({
    network_access: z.boolean().optional(),
  }).optional(),
  opencode: z.object({
    network_access: z.boolean().optional(),
  }).optional(),
  claude: z.object({
    sandbox: ClaudeSandboxSchema,
  }).optional(),
}).optional();

/** Provider key schema for profile maps */
export const ProviderProfileNameSchema = z.enum(['claude', 'codex', 'opencode', 'mock']);

/** Provider permission profile schema */
export const ProviderPermissionProfileSchema = z.object({
  default_permission_mode: PermissionModeSchema,
  movement_permission_overrides: z.record(z.string(), PermissionModeSchema).optional(),
});

/** Provider permission profiles schema */
export const ProviderPermissionProfilesSchema = z.object({
  claude: ProviderPermissionProfileSchema.optional(),
  codex: ProviderPermissionProfileSchema.optional(),
  opencode: ProviderPermissionProfileSchema.optional(),
  mock: ProviderPermissionProfileSchema.optional(),
}).optional();

/** Runtime prepare preset identifiers */
export const RuntimePreparePresetSchema = z.enum(['gradle', 'node']);
/** Runtime prepare entry: preset name or script path */
export const RuntimePrepareEntrySchema = z.union([
  RuntimePreparePresetSchema,
  z.string().min(1),
]);

/** Piece-level runtime settings */
export const RuntimeConfigSchema = z.object({
  prepare: z.array(RuntimePrepareEntrySchema).optional(),
}).optional();

/** Piece-level provider options schema */
export const PieceProviderOptionsSchema = z.object({
  provider_options: MovementProviderOptionsSchema,
  runtime: RuntimeConfigSchema,
}).optional();

/**
 * Output contract item schema (new structured format).
 *
 * YAML format:
 *   output_contracts:
 *     report:
 *       - name: 00-plan.md
 *         format: plan
 *         use_judge: true
 */
export const OutputContractItemSchema = z.object({
  /** Report file name */
  name: z.string().min(1),
  /** Instruction appended after instruction_template (e.g., output format) */
  format: z.string().min(1),
  /** Whether this report is used as input for status judgment phase */
  use_judge: z.boolean().optional().default(true),
  /** Instruction prepended before instruction_template (e.g., output destination) */
  order: z.string().optional(),
});

/**
 * Output contracts field schema for movement-level definition.
 *
 * YAML format:
 *   output_contracts:
 *     report:
 *       - name: 00-plan.md
 *         order: ...
 *         format: plan
 *         use_judge: true
 */
export const OutputContractsFieldSchema = z.object({
  report: z.array(OutputContractItemSchema).optional(),
}).optional();

/** Quality gates schema - AI directives for movement completion (string array) */
export const QualityGatesSchema = z.array(z.string()).optional();

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

/** Arpeggio merge configuration schema */
export const ArpeggioMergeRawSchema = z.object({
  /** Merge strategy: 'concat' or 'custom' */
  strategy: z.enum(['concat', 'custom']).optional().default('concat'),
  /** Inline JS function body for custom merge */
  inline_js: z.string().optional(),
  /** External JS file path for custom merge */
  file: z.string().optional(),
  /** Separator for concat strategy */
  separator: z.string().optional(),
}).refine(
  (data) => data.strategy !== 'custom' || data.inline_js != null || data.file != null,
  { message: "Custom merge strategy requires either 'inline_js' or 'file'" }
).refine(
  (data) => data.strategy !== 'concat' || (data.inline_js == null && data.file == null),
  { message: "Concat merge strategy does not accept 'inline_js' or 'file'" }
);

/** Arpeggio configuration schema for data-driven batch processing */
export const ArpeggioConfigRawSchema = z.object({
  /** Data source type (e.g., 'csv') */
  source: z.string().min(1),
  /** Path to the data source file */
  source_path: z.string().min(1),
  /** Number of rows per batch (default: 1) */
  batch_size: z.number().int().positive().optional().default(1),
  /** Number of concurrent LLM calls (default: 1) */
  concurrency: z.number().int().positive().optional().default(1),
  /** Path to prompt template file */
  template: z.string().min(1),
  /** Merge configuration */
  merge: ArpeggioMergeRawSchema.optional(),
  /** Maximum retry attempts per batch (default: 2) */
  max_retries: z.number().int().min(0).optional().default(2),
  /** Delay between retries in ms (default: 1000) */
  retry_delay_ms: z.number().int().min(0).optional().default(1000),
  /** Optional output file path */
  output_path: z.string().optional(),
});

/** Team leader configuration schema for dynamic part decomposition */
export const TeamLeaderConfigRawSchema = z.object({
  /** Persona reference for team leader agent */
  persona: z.string().optional(),
  /** Maximum number of parts (must be <= 3) */
  max_parts: z.number().int().positive().max(3).optional().default(3),
  /** Default timeout per part in milliseconds */
  timeout_ms: z.number().int().positive().optional().default(600000),
  /** Persona reference for part agents */
  part_persona: z.string().optional(),
  /** Allowed tools for part agents */
  part_allowed_tools: z.array(z.string()).optional(),
  /** Whether part agents can edit files */
  part_edit: z.boolean().optional(),
  /** Permission mode for part agents */
  part_permission_mode: PermissionModeSchema.optional(),
});

/** Sub-movement schema for parallel execution */
export const ParallelSubMovementRawSchema = z.object({
  name: z.string().min(1),
  /** Persona reference — key name from piece-level personas map, or file path */
  persona: z.string().optional(),
  /** Display name for the persona (shown in output) */
  persona_name: z.string().optional(),
  /** Policy reference(s) — key name(s) from piece-level policies map */
  policy: z.union([z.string(), z.array(z.string())]).optional(),
  /** Knowledge reference(s) — key name(s) from piece-level knowledge map */
  knowledge: z.union([z.string(), z.array(z.string())]).optional(),
  allowed_tools: z.array(z.string()).optional(),
  mcp_servers: McpServersSchema,
  provider: z.enum(['claude', 'codex', 'opencode', 'mock']).optional(),
  model: z.string().optional(),
  /** Removed legacy field (no backward compatibility) */
  permission_mode: z.never().optional(),
  required_permission_mode: PermissionModeSchema.optional(),
  provider_options: MovementProviderOptionsSchema,
  edit: z.boolean().optional(),
  instruction: z.string().optional(),
  instruction_template: z.string().optional(),
  rules: z.array(PieceRuleSchema).optional(),
  /** Output contracts for this movement (report definitions) */
  output_contracts: OutputContractsFieldSchema,
  /** Quality gates for this movement (AI directives) */
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional().default(true),
});

/** Piece movement schema - raw YAML format */
export const PieceMovementRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Session handling for this movement */
  session: z.enum(['continue', 'refresh']).optional(),
  /** Persona reference — key name from piece-level personas map, or file path */
  persona: z.string().optional(),
  /** Display name for the persona (shown in output) */
  persona_name: z.string().optional(),
  /** Policy reference(s) — key name(s) from piece-level policies map */
  policy: z.union([z.string(), z.array(z.string())]).optional(),
  /** Knowledge reference(s) — key name(s) from piece-level knowledge map */
  knowledge: z.union([z.string(), z.array(z.string())]).optional(),
  allowed_tools: z.array(z.string()).optional(),
  mcp_servers: McpServersSchema,
  provider: z.enum(['claude', 'codex', 'opencode', 'mock']).optional(),
  model: z.string().optional(),
  /** Removed legacy field (no backward compatibility) */
  permission_mode: z.never().optional(),
  /** Required minimum permission mode for tool execution in this movement */
  required_permission_mode: PermissionModeSchema.optional(),
  /** Provider-specific movement options */
  provider_options: MovementProviderOptionsSchema,
  /** Whether this movement is allowed to edit project files */
  edit: z.boolean().optional(),
  instruction: z.string().optional(),
  instruction_template: z.string().optional(),
  /** Rules for movement routing */
  rules: z.array(PieceRuleSchema).optional(),
  /** Output contracts for this movement (report definitions) */
  output_contracts: OutputContractsFieldSchema,
  /** Quality gates for this movement (AI directives) */
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional().default(true),
  /** Sub-movements to execute in parallel */
  parallel: z.array(ParallelSubMovementRawSchema).optional(),
  /** Arpeggio configuration for data-driven batch processing */
  arpeggio: ArpeggioConfigRawSchema.optional(),
  /** Team leader configuration for dynamic part decomposition */
  team_leader: TeamLeaderConfigRawSchema.optional(),
}).refine(
  (data) => [data.parallel, data.arpeggio, data.team_leader].filter((v) => v != null).length <= 1,
  {
    message: "'parallel', 'arpeggio', and 'team_leader' are mutually exclusive",
    path: ['parallel'],
  },
);

/** Loop monitor rule schema */
export const LoopMonitorRuleSchema = z.object({
  /** Human-readable condition text */
  condition: z.string().min(1),
  /** Next movement name to transition to */
  next: z.string().min(1),
});

/** Loop monitor judge schema */
export const LoopMonitorJudgeSchema = z.object({
  /** Persona reference — key name from piece-level personas map, or file path */
  persona: z.string().optional(),
  /** Custom instruction template for the judge */
  instruction_template: z.string().optional(),
  /** Rules for the judge's decision */
  rules: z.array(LoopMonitorRuleSchema).min(1),
});

/** Loop monitor configuration schema */
export const LoopMonitorSchema = z.object({
  /** Ordered list of movement names forming the cycle to detect */
  cycle: z.array(z.string().min(1)).min(2),
  /** Number of complete cycles before triggering the judge (default: 3) */
  threshold: z.number().int().positive().optional().default(3),
  /** Judge configuration */
  judge: LoopMonitorJudgeSchema,
});

/** Interactive mode schema for piece-level default */
export const InteractiveModeSchema = z.enum(INTERACTIVE_MODES);

/** Piece configuration schema - raw YAML format */
export const PieceConfigRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  piece_config: PieceProviderOptionsSchema,
  /** Piece-level persona definitions — map of name to .md file path or inline content */
  personas: z.record(z.string(), z.string()).optional(),
  /** Piece-level policy definitions — map of name to .md file path or inline content */
  policies: z.record(z.string(), z.string()).optional(),
  /** Piece-level knowledge definitions — map of name to .md file path or inline content */
  knowledge: z.record(z.string(), z.string()).optional(),
  /** Piece-level instruction definitions — map of name to .md file path or inline content */
  instructions: z.record(z.string(), z.string()).optional(),
  /** Piece-level report format definitions — map of name to .md file path or inline content */
  report_formats: z.record(z.string(), z.string()).optional(),
  movements: z.array(PieceMovementRawSchema).min(1),
  initial_movement: z.string().optional(),
  max_movements: z.number().int().positive().optional().default(10),
  loop_monitors: z.array(LoopMonitorSchema).optional(),
  answer_agent: z.string().optional(),
  /** Default interactive mode for this piece (overrides user default) */
  interactive_mode: InteractiveModeSchema.optional(),
});

export const PersonaProviderEntrySchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'mock']).optional(),
  model: z.string().optional(),
});

/** Custom agent configuration schema */
export const CustomAgentConfigSchema = z.object({
  name: z.string().min(1),
  prompt_file: z.string().optional(),
  prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  claude_agent: z.string().optional(),
  claude_skill: z.string().optional(),
  provider: z.enum(['claude', 'codex', 'opencode', 'mock']).optional(),
  model: z.string().optional(),
}).refine(
  (data) => data.prompt_file || data.prompt || data.claude_agent || data.claude_skill,
  { message: 'Agent must have prompt_file, prompt, claude_agent, or claude_skill' }
);

export const ObservabilityConfigSchema = z.object({
  provider_events: z.boolean().optional(),
});

/** Analytics config schema */
export const AnalyticsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  events_path: z.string().optional(),
  retention_days: z.number().int().positive().optional(),
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
  log_level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  provider: z.enum(['claude', 'codex', 'opencode', 'mock']).optional().default('claude'),
  model: z.string().optional(),
  observability: ObservabilityConfigSchema.optional(),
  analytics: AnalyticsConfigSchema.optional(),
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktree_dir: z.string().optional(),
  /** Auto-create PR after worktree execution (default: prompt in interactive mode) */
  auto_pr: z.boolean().optional(),
  /** Create PR as draft (default: prompt in interactive mode when auto_pr is true) */
  draft_pr: z.boolean().optional(),
  /** List of builtin piece/agent names to exclude from fallback loading */
  disabled_builtins: z.array(z.string()).optional().default([]),
  /** Enable builtin pieces from builtins/{lang}/pieces */
  enable_builtin_pieces: z.boolean().optional(),
  /** Anthropic API key for Claude Code SDK (overridden by TAKT_ANTHROPIC_API_KEY env var) */
  anthropic_api_key: z.string().optional(),
  /** OpenAI API key for Codex SDK (overridden by TAKT_OPENAI_API_KEY env var) */
  openai_api_key: z.string().optional(),
  /** External Codex CLI path for Codex SDK override (overridden by TAKT_CODEX_CLI_PATH env var) */
  codex_cli_path: z.string().optional(),
  /** OpenCode API key for OpenCode SDK (overridden by TAKT_OPENCODE_API_KEY env var) */
  opencode_api_key: z.string().optional(),
  /** Pipeline execution settings */
  pipeline: PipelineConfigSchema.optional(),
  /** Minimal output mode for CI - suppress AI output to prevent sensitive information leaks */
  minimal_output: z.boolean().optional().default(false),
  /** Path to bookmarks file (default: ~/.takt/preferences/bookmarks.yaml) */
  bookmarks_file: z.string().optional(),
  /** Path to piece categories file (default: ~/.takt/preferences/piece-categories.yaml) */
  piece_categories_file: z.string().optional(),
  /** Per-persona provider and model overrides. */
  persona_providers: z.record(z.string(), z.union([
    z.enum(['claude', 'codex', 'opencode', 'mock']),
    PersonaProviderEntrySchema,
  ])).optional(),
  /** Global provider-specific options (lowest priority) */
  provider_options: MovementProviderOptionsSchema,
  /** Provider-specific permission profiles */
  provider_profiles: ProviderPermissionProfilesSchema,
  /** Global runtime defaults (piece runtime overrides this) */
  runtime: RuntimeConfigSchema,
  /** Branch name generation strategy: 'romaji' (fast, default) or 'ai' (slow) */
  branch_name_strategy: z.enum(['romaji', 'ai']).optional(),
  /** Prevent macOS idle sleep during takt execution using caffeinate (default: false) */
  prevent_sleep: z.boolean().optional(),
  /** Enable notification sounds (default: true when undefined) */
  notification_sound: z.boolean().optional(),
  /** Notification sound toggles per event timing */
  notification_sound_events: z.object({
    iteration_limit: z.boolean().optional(),
    piece_complete: z.boolean().optional(),
    piece_abort: z.boolean().optional(),
    run_complete: z.boolean().optional(),
    run_abort: z.boolean().optional(),
  }).optional(),
  /** Number of movement previews to inject into interactive mode (0 to disable, max 10) */
  interactive_preview_movements: z.number().int().min(0).max(10).optional().default(3),
  /** Verbose output mode */
  verbose: z.boolean().optional(),
  /** Number of tasks to run concurrently in takt run (default: 1 = sequential, max: 10) */
  concurrency: z.number().int().min(1).max(10).optional().default(1),
  /** Polling interval in ms for picking up new tasks during takt run (default: 500, range: 100-5000) */
  task_poll_interval_ms: z.number().int().min(100).max(5000).optional().default(500),
});

/** Project config schema */
export const ProjectConfigSchema = z.object({
  piece: z.string().optional(),
  provider: z.enum(['claude', 'codex', 'opencode', 'mock']).optional(),
  provider_options: MovementProviderOptionsSchema,
  provider_profiles: ProviderPermissionProfilesSchema,
});
