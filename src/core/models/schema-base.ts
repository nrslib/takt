/**
 * Shared Zod schema primitives.
 *
 * Note: Uses zod v4 syntax for SDK compatibility.
 */

import { z } from 'zod/v4';
import { STATUS_VALUES } from './status.js';
import { CLAUDE_EFFORT_VALUES, CODEX_REASONING_EFFORT_VALUES, RUNTIME_PREPARE_PRESETS } from './piece-types.js';

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
export const StatusSchema = z.enum(STATUS_VALUES);

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
    reasoning_effort: z.enum(CODEX_REASONING_EFFORT_VALUES).optional(),
  }).optional(),
  opencode: z.object({
    network_access: z.boolean().optional(),
  }).optional(),
  claude: z.object({
    allowed_tools: z.array(z.string()).optional(),
    effort: z.enum(CLAUDE_EFFORT_VALUES).optional(),
    sandbox: ClaudeSandboxSchema,
  }).optional(),
}).optional();

/** Provider key schema for profile maps */
export const ProviderProfileNameSchema = z.enum([
  'claude',
  'claude-sdk',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'mock',
]);
export const ProviderTypeSchema = ProviderProfileNameSchema;

export const ProviderBlockSchema = z.object({
  type: ProviderTypeSchema,
  model: z.string().optional(),
  network_access: z.boolean().optional(),
  sandbox: ClaudeSandboxSchema,
}).strict().superRefine((provider, ctx) => {
  const hasNetworkAccess = provider.network_access !== undefined;
  const hasSandbox = provider.sandbox !== undefined;

  if (provider.type === 'claude-sdk') {
    if (hasNetworkAccess) {
      ctx.addIssue({
        code: 'custom',
        path: ['network_access'],
        message: "provider.type 'claude-sdk' does not support 'network_access'.",
      });
    }
    return;
  }

  if (provider.type === 'claude') {
    if (hasNetworkAccess) {
      ctx.addIssue({
        code: 'custom',
        path: ['network_access'],
        message: "provider.type 'claude' does not support 'network_access'.",
      });
    }
    return;
  }

  if (provider.type === 'codex' || provider.type === 'opencode') {
    if (hasSandbox) {
      ctx.addIssue({
        code: 'custom',
        path: ['sandbox'],
        message: `provider.type '${provider.type}' does not support 'sandbox'.`,
      });
    }
    return;
  }

  if (hasNetworkAccess || hasSandbox) {
    ctx.addIssue({
      code: 'custom',
      message: `provider.type '${provider.type}' does not support provider-specific options in provider block.`,
    });
  }
});

export const ProviderReferenceSchema = z.union([ProviderTypeSchema, ProviderBlockSchema]);

/** Provider permission profile schema */
export const ProviderPermissionProfileSchema = z.object({
  default_permission_mode: PermissionModeSchema,
  movement_permission_overrides: z.record(z.string(), PermissionModeSchema).optional(),
  step_permission_overrides: z.record(z.string(), PermissionModeSchema).optional(),
});

/** Provider permission profiles schema */
export const ProviderPermissionProfilesSchema = z.object({
  claude: ProviderPermissionProfileSchema.optional(),
  'claude-sdk': ProviderPermissionProfileSchema.optional(),
  codex: ProviderPermissionProfileSchema.optional(),
  opencode: ProviderPermissionProfileSchema.optional(),
  cursor: ProviderPermissionProfileSchema.optional(),
  copilot: ProviderPermissionProfileSchema.optional(),
  mock: ProviderPermissionProfileSchema.optional(),
}).optional();

/** Runtime prepare preset identifiers */
export const RuntimePreparePresetSchema = z.enum(RUNTIME_PREPARE_PRESETS);

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
  provider: ProviderReferenceSchema.optional(),
  provider_options: MovementProviderOptionsSchema,
  runtime: RuntimeConfigSchema,
}).optional();

/**
 * Output contract item schema (new structured format).
 */
export const OutputContractItemSchema = z.object({
  name: z.string().min(1),
  format: z.string().min(1),
  use_judge: z.boolean().optional().default(true),
  order: z.string().optional(),
});

/** Output contracts field schema for movement-level definition. */
export const OutputContractsFieldSchema = z.object({
  report: z.array(OutputContractItemSchema).optional(),
}).optional();

/** Quality gates schema - AI directives for movement completion (string array) */
export const QualityGatesSchema = z.array(z.string()).optional();

/** Movement-specific quality gates override schema */
export const MovementQualityGatesOverrideSchema = z.object({
  quality_gates: QualityGatesSchema,
}).optional();

export const PersonaProviderEntrySchema = z.object({
  provider: ProviderTypeSchema.optional(),
  model: z.string().optional(),
}).strict().refine(
  (entry) => entry.provider !== undefined || entry.model !== undefined,
  { message: "persona_providers entry must include either 'provider' or 'model'" }
);

export const PersonaProviderBlockSchema = z.object({
  type: ProviderTypeSchema,
  model: z.string().optional(),
}).strict();

export const PersonaProviderReferenceSchema = z.union([
  ProviderTypeSchema,
  PersonaProviderBlockSchema,
  PersonaProviderEntrySchema,
]);

export const TaktProviderEntrySchema = z.object({
  provider: ProviderTypeSchema.optional(),
  model: z.string().optional(),
}).strict().refine(
  (entry) => entry.provider !== undefined || entry.model !== undefined,
  { message: "takt_providers.assistant must include either 'provider' or 'model'" }
);

export const TaktProvidersSchema = z.object({
  assistant: TaktProviderEntrySchema.optional(),
}).strict().refine(
  (entry) => entry.assistant !== undefined,
  { message: "takt_providers must include 'assistant'" }
);

/** Custom agent configuration schema */
export const CustomAgentConfigSchema = z.object({
  name: z.string().min(1),
  prompt_file: z.string().optional(),
  prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
}).strict().refine(
  (data) => data.prompt_file || data.prompt,
  { message: 'Agent must have prompt_file or prompt' }
);

export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  trace: z.boolean().optional(),
  debug: z.boolean().optional(),
  provider_events: z.boolean().optional(),
  usage_events: z.boolean().optional(),
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
}).strict();
