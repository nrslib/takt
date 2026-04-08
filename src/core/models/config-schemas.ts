/**
 * Project/global config schemas and config-specific alias normalization.
 */

import { z } from 'zod/v4';
import { DEFAULT_LANGUAGE } from '../../shared/constants.js';
import { VCS_PROVIDER_TYPES } from './vcs-types.js';
import {
  AnalyticsConfigSchema,
  LanguageSchema,
  LoggingConfigSchema,
  StepProviderOptionsSchema,
  StepQualityGatesOverrideSchema,
  PersonaProviderReferenceSchema,
  PipelineConfigSchema,
  ProviderPermissionProfilesSchema,
  ProviderReferenceSchema,
  QualityGatesSchema,
  RuntimeConfigSchema,
  TaktProvidersSchema,
} from './schema-base.js';

/** Workflow overrides schema for config-level overrides */
export const WorkflowOverridesSchema = z.object({
  quality_gates: QualityGatesSchema,
  quality_gates_edit_only: z.boolean().optional(),
  steps: z.record(z.string(), StepQualityGatesOverrideSchema).optional(),
  personas: z.record(z.string(), StepQualityGatesOverrideSchema).optional(),
}).optional();

export const WorkflowRuntimePrepareConfigSchema = z.object({
  custom_scripts: z.boolean().optional(),
}).strict();

export const WorkflowArpeggioConfigSchema = z.object({
  custom_data_source_modules: z.boolean().optional(),
  custom_merge_inline_js: z.boolean().optional(),
  custom_merge_files: z.boolean().optional(),
}).strict();

export const SyncConflictResolverConfigSchema = z.object({
  auto_approve_tools: z.boolean().optional(),
}).strict();

export const WorkflowMcpServersConfigSchema = z.object({
  stdio: z.boolean().optional(),
  sse: z.boolean().optional(),
  http: z.boolean().optional(),
}).strict();

/** Workflow category config schema (recursive) */
export type WorkflowCategoryConfigNode = {
  workflows?: string[];
  [key: string]: WorkflowCategoryConfigNode | string[] | undefined;
};

export const WorkflowCategoryConfigNodeSchema: z.ZodType<WorkflowCategoryConfigNode> = z.lazy(() =>
  z.object({
    workflows: z.array(z.string()).optional(),
  }).catchall(WorkflowCategoryConfigNodeSchema)
);

export const WorkflowCategoryConfigSchema = z.record(z.string(), WorkflowCategoryConfigNodeSchema);

/** Project config schema */
const ProjectConfigObjectSchema = z.object({
  language: LanguageSchema.optional(),
  provider: ProviderReferenceSchema.optional(),
  model: z.string().optional(),
  analytics: AnalyticsConfigSchema.optional(),
  allow_git_hooks: z.boolean().optional(),
  allow_git_filters: z.boolean().optional(),
  auto_pr: z.boolean().optional(),
  draft_pr: z.boolean().optional(),
  pipeline: PipelineConfigSchema.optional(),
  takt_providers: TaktProvidersSchema.optional(),
  persona_providers: z.record(z.string(), PersonaProviderReferenceSchema).optional(),
  branch_name_strategy: z.enum(['romaji', 'ai']).optional(),
  minimal_output: z.boolean().optional(),
  provider_options: StepProviderOptionsSchema,
  provider_profiles: ProviderPermissionProfilesSchema,
  runtime: RuntimeConfigSchema,
  workflow_runtime_prepare: WorkflowRuntimePrepareConfigSchema.optional(),
  workflow_arpeggio: WorkflowArpeggioConfigSchema.optional(),
  sync_conflict_resolver: SyncConflictResolverConfigSchema.optional(),
  workflow_mcp_servers: WorkflowMcpServersConfigSchema.optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  task_poll_interval_ms: z.number().int().min(100).max(5000).optional(),
  interactive_preview_steps: z.number().int().min(0).max(10).optional(),
  base_branch: z.string().optional(),
  workflow_overrides: WorkflowOverridesSchema,
  vcs_provider: z.enum(VCS_PROVIDER_TYPES).optional(),
  submodules: z.union([
    z.string().refine((value) => value.trim().toLowerCase() === 'all', {
      message: 'Invalid submodules: string value must be "all"',
    }),
    z.array(z.string().min(1)).refine((paths) => paths.every((path) => !path.includes('*')), {
      message: 'Invalid submodules: path entries must not include wildcard "*"',
    }),
  ]).optional(),
  with_submodules: z.boolean().optional(),
}).strict();

export const ProjectConfigSchema = ProjectConfigObjectSchema;

const GlobalOnlyConfigSchema = z.object({
  language: LanguageSchema.optional().default(DEFAULT_LANGUAGE),
  logging: LoggingConfigSchema.optional(),
  worktree_dir: z.string().optional(),
  disabled_builtins: z.array(z.string()).optional().default([]),
  enable_builtin_workflows: z.boolean().optional(),
  anthropic_api_key: z.string().optional(),
  openai_api_key: z.string().optional(),
  gemini_api_key: z.string().optional(),
  google_api_key: z.string().optional(),
  groq_api_key: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  codex_cli_path: z.string().optional(),
  claude_cli_path: z.string().optional(),
  cursor_cli_path: z.string().optional(),
  copilot_cli_path: z.string().optional(),
  copilot_github_token: z.string().optional(),
  opencode_api_key: z.string().optional(),
  cursor_api_key: z.string().optional(),
  bookmarks_file: z.string().optional(),
  workflow_categories_file: z.string().optional(),
  prevent_sleep: z.boolean().optional(),
  notification_sound: z.boolean().optional(),
  notification_sound_events: z.object({
    iteration_limit: z.boolean().optional(),
    workflow_complete: z.boolean().optional(),
    workflow_abort: z.boolean().optional(),
    run_complete: z.boolean().optional(),
    run_abort: z.boolean().optional(),
  }).optional(),
  auto_fetch: z.boolean().optional().default(false),
});

/** Global config schema = ProjectConfig + global-only fields. */
export const GlobalConfigSchema = ProjectConfigObjectSchema
  .omit({ submodules: true, with_submodules: true })
  .merge(GlobalOnlyConfigSchema)
  .extend({
    provider: ProviderReferenceSchema.optional().default('claude'),
  })
  .strict();
