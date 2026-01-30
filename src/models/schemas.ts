/**
 * Zod schemas for configuration validation
 *
 * Note: Uses zod v4 syntax for SDK compatibility.
 */

import { z } from 'zod/v4';
import { DEFAULT_LANGUAGE } from '../constants.js';

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
export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions']);

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
export const WorkflowRuleSchema = z.object({
  /** Human-readable condition text */
  condition: z.string().min(1),
  /** Next step name (e.g., implement, COMPLETE, ABORT) */
  next: z.string().min(1),
  /** Template for additional AI output */
  appendix: z.string().optional(),
});

/** Sub-step schema for parallel execution (agent is required) */
export const ParallelSubStepRawSchema = z.object({
  name: z.string().min(1),
  agent: z.string().min(1),
  agent_name: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
  model: z.string().optional(),
  permission_mode: PermissionModeSchema.optional(),
  edit: z.boolean().optional(),
  instruction: z.string().optional(),
  instruction_template: z.string().optional(),
  rules: z.array(WorkflowRuleSchema).optional(),
  report: ReportFieldSchema.optional(),
  pass_previous_response: z.boolean().optional().default(true),
});

/** Workflow step schema - raw YAML format */
export const WorkflowStepRawSchema = z.object({
  name: z.string().min(1),
  /** Agent is required for normal steps, optional for parallel container steps */
  agent: z.string().optional(),
  /** Display name for the agent (shown in output). Falls back to agent basename if not specified */
  agent_name: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
  model: z.string().optional(),
  /** Permission mode for tool execution in this step */
  permission_mode: PermissionModeSchema.optional(),
  /** Whether this step is allowed to edit project files */
  edit: z.boolean().optional(),
  instruction: z.string().optional(),
  instruction_template: z.string().optional(),
  /** Rules for step routing */
  rules: z.array(WorkflowRuleSchema).optional(),
  /** Report file(s) for this step */
  report: ReportFieldSchema.optional(),
  pass_previous_response: z.boolean().optional().default(true),
  /** Sub-steps to execute in parallel */
  parallel: z.array(ParallelSubStepRawSchema).optional(),
}).refine(
  (data) => data.agent || (data.parallel && data.parallel.length > 0),
  { message: 'Step must have either an agent or parallel sub-steps' },
);

/** Workflow configuration schema - raw YAML format */
export const WorkflowConfigRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(WorkflowStepRawSchema).min(1),
  initial_step: z.string().optional(),
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

/** Global config schema */
export const GlobalConfigSchema = z.object({
  language: LanguageSchema.optional().default(DEFAULT_LANGUAGE),
  trusted_directories: z.array(z.string()).optional().default([]),
  default_workflow: z.string().optional().default('default'),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  provider: z.enum(['claude', 'codex', 'mock']).optional().default('claude'),
  model: z.string().optional(),
  debug: DebugConfigSchema.optional(),
  /** Directory for shared clones (worktree_dir in config). If empty, uses ../{clone-name} relative to project */
  worktree_dir: z.string().optional(),
});

/** Project config schema */
export const ProjectConfigSchema = z.object({
  workflow: z.string().optional(),
  agents: z.array(CustomAgentConfigSchema).optional(),
  provider: z.enum(['claude', 'codex', 'mock']).optional(),
});

