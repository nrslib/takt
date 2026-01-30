/**
 * Workflow configuration loader
 *
 * Loads workflows from ~/.takt/workflows/ directory only.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../models/schemas.js';
import type { WorkflowConfig, WorkflowStep, WorkflowRule, ReportConfig, ReportObjectConfig } from '../models/types.js';
import { getGlobalWorkflowsDir } from './paths.js';

/** Get builtin workflow by name */
export function getBuiltinWorkflow(name: string): WorkflowConfig | null {
  // No built-in workflows - all workflows must be defined in ~/.takt/workflows/
  void name;
  return null;
}

/**
 * Resolve agent path from workflow specification.
 * - Relative path (./agent.md): relative to workflow directory
 * - Absolute path (/path/to/agent.md or ~/...): use as-is
 */
function resolveAgentPathForWorkflow(agentSpec: string, workflowDir: string): string {
  // Relative path (starts with ./)
  if (agentSpec.startsWith('./')) {
    return join(workflowDir, agentSpec.slice(2));
  }

  // Home directory expansion
  if (agentSpec.startsWith('~')) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '';
    return join(homedir, agentSpec.slice(1));
  }

  // Absolute path
  if (agentSpec.startsWith('/')) {
    return agentSpec;
  }

  // Fallback: treat as relative to workflow directory
  return join(workflowDir, agentSpec);
}

/**
 * Extract display name from agent path.
 * e.g., "~/.takt/agents/default/coder.md" -> "coder"
 */
function extractAgentDisplayName(agentPath: string): string {
  // Get the filename without extension
  const filename = basename(agentPath, '.md');
  return filename;
}

/**
 * Resolve a string value that may be a file path.
 * If the value ends with .md and the file exists (resolved relative to workflowDir),
 * read and return the file contents. Otherwise return the value as-is.
 */
function resolveContentPath(value: string | undefined, workflowDir: string): string | undefined {
  if (value == null) return undefined;
  if (value.endsWith('.md')) {
    // Resolve path relative to workflow directory
    let resolvedPath = value;
    if (value.startsWith('./')) {
      resolvedPath = join(workflowDir, value.slice(2));
    } else if (value.startsWith('~')) {
      const homedir = process.env.HOME || process.env.USERPROFILE || '';
      resolvedPath = join(homedir, value.slice(1));
    } else if (!value.startsWith('/')) {
      resolvedPath = join(workflowDir, value);
    }
    if (existsSync(resolvedPath)) {
      return readFileSync(resolvedPath, 'utf-8');
    }
  }
  return value;
}

/**
 * Check if a raw report value is the object form (has 'name' property).
 */
function isReportObject(raw: unknown): raw is { name: string; order?: string; format?: string } {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'name' in raw;
}

/**
 * Normalize the raw report field from YAML into internal format.
 *
 * YAML formats:
 *   report: "00-plan.md"                  → string (single file)
 *   report:                               → ReportConfig[] (multiple files)
 *     - Scope: 01-scope.md
 *     - Decisions: 02-decisions.md
 *   report:                               → ReportObjectConfig (object form)
 *     name: 00-plan.md
 *     order: ...
 *     format: ...
 *
 * Array items are parsed as single-key objects: [{Scope: "01-scope.md"}, ...]
 */
function normalizeReport(
  raw: string | Record<string, string>[] | { name: string; order?: string; format?: string } | undefined,
  workflowDir: string,
): string | ReportConfig[] | ReportObjectConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (isReportObject(raw)) {
    return {
      name: raw.name,
      order: resolveContentPath(raw.order, workflowDir),
      format: resolveContentPath(raw.format, workflowDir),
    };
  }
  // Convert [{Scope: "01-scope.md"}, ...] to [{label: "Scope", path: "01-scope.md"}, ...]
  return (raw as Record<string, string>[]).flatMap((entry) =>
    Object.entries(entry).map(([label, path]) => ({ label, path })),
  );
}

/** Regex to detect ai("...") condition expressions */
const AI_CONDITION_REGEX = /^ai\("(.+)"\)$/;

/** Regex to detect all("...")/any("...") aggregate condition expressions */
const AGGREGATE_CONDITION_REGEX = /^(all|any)\("(.+)"\)$/;

/**
 * Parse a rule's condition for ai() and all()/any() expressions.
 * - `ai("text")` → sets isAiCondition and aiConditionText
 * - `all("text")` / `any("text")` → sets isAggregateCondition, aggregateType, aggregateConditionText
 */
function normalizeRule(r: { condition: string; next: string; appendix?: string }): WorkflowRule {
  const aiMatch = r.condition.match(AI_CONDITION_REGEX);
  if (aiMatch?.[1]) {
    return {
      condition: r.condition,
      next: r.next,
      appendix: r.appendix,
      isAiCondition: true,
      aiConditionText: aiMatch[1],
    };
  }

  const aggMatch = r.condition.match(AGGREGATE_CONDITION_REGEX);
  if (aggMatch?.[1] && aggMatch[2]) {
    return {
      condition: r.condition,
      next: r.next,
      appendix: r.appendix,
      isAggregateCondition: true,
      aggregateType: aggMatch[1] as 'all' | 'any',
      aggregateConditionText: aggMatch[2],
    };
  }

  return {
    condition: r.condition,
    next: r.next,
    appendix: r.appendix,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawStep = any;

/**
 * Normalize a raw step into internal WorkflowStep format.
 */
function normalizeStepFromRaw(step: RawStep, workflowDir: string): WorkflowStep {
  const rules: WorkflowRule[] | undefined = step.rules?.map(normalizeRule);
  const agentSpec: string = step.agent ?? '';

  const result: WorkflowStep = {
    name: step.name,
    agent: agentSpec,
    agentDisplayName: step.agent_name || (agentSpec ? extractAgentDisplayName(agentSpec) : step.name),
    agentPath: agentSpec ? resolveAgentPathForWorkflow(agentSpec, workflowDir) : undefined,
    allowedTools: step.allowed_tools,
    provider: step.provider,
    model: step.model,
    permissionMode: step.permission_mode,
    edit: step.edit,
    instructionTemplate: resolveContentPath(step.instruction_template, workflowDir) || step.instruction || '{task}',
    rules,
    report: normalizeReport(step.report, workflowDir),
    passPreviousResponse: step.pass_previous_response ?? true,
  };

  if (step.parallel && step.parallel.length > 0) {
    result.parallel = step.parallel.map((sub: RawStep) => normalizeStepFromRaw(sub, workflowDir));
  }

  return result;
}

/**
 * Convert raw YAML workflow config to internal format.
 * Agent paths are resolved relative to the workflow directory.
 */
function normalizeWorkflowConfig(raw: unknown, workflowDir: string): WorkflowConfig {
  const parsed = WorkflowConfigRawSchema.parse(raw);

  const steps: WorkflowStep[] = parsed.steps.map((step) =>
    normalizeStepFromRaw(step, workflowDir),
  );

  return {
    name: parsed.name,
    description: parsed.description,
    steps,
    initialStep: parsed.initial_step || steps[0]?.name || '',
    maxIterations: parsed.max_iterations,
    answerAgent: parsed.answer_agent,
  };
}

/**
 * Load a workflow from a YAML file.
 * @param filePath Path to the workflow YAML file
 */
export function loadWorkflowFromFile(filePath: string): WorkflowConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const workflowDir = dirname(filePath);
  return normalizeWorkflowConfig(raw, workflowDir);
}

/**
 * Load workflow by name from global directory.
 * Looks for ~/.takt/workflows/{name}.yaml
 */
export function loadWorkflow(name: string): WorkflowConfig | null {
  const globalWorkflowsDir = getGlobalWorkflowsDir();
  const workflowYamlPath = join(globalWorkflowsDir, `${name}.yaml`);

  if (existsSync(workflowYamlPath)) {
    return loadWorkflowFromFile(workflowYamlPath);
  }
  return null;
}

/** Load all workflows with descriptions (for switch command) */
export function loadAllWorkflows(): Map<string, WorkflowConfig> {
  const workflows = new Map<string, WorkflowConfig>();

  // Global workflows (~/.takt/workflows/{name}.yaml)
  const globalWorkflowsDir = getGlobalWorkflowsDir();
  if (existsSync(globalWorkflowsDir)) {
    for (const entry of readdirSync(globalWorkflowsDir)) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

      const entryPath = join(globalWorkflowsDir, entry);
      if (statSync(entryPath).isFile()) {
        try {
          const workflow = loadWorkflowFromFile(entryPath);
          const workflowName = entry.replace(/\.ya?ml$/, '');
          workflows.set(workflowName, workflow);
        } catch {
          // Skip invalid workflows
        }
      }
    }
  }

  return workflows;
}

/** List available workflows from global directory (~/.takt/workflows/) */
export function listWorkflows(): string[] {
  const workflows = new Set<string>();

  const globalWorkflowsDir = getGlobalWorkflowsDir();
  if (existsSync(globalWorkflowsDir)) {
    for (const entry of readdirSync(globalWorkflowsDir)) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

      const entryPath = join(globalWorkflowsDir, entry);
      if (statSync(entryPath).isFile()) {
        const workflowName = entry.replace(/\.ya?ml$/, '');
        workflows.add(workflowName);
      }
    }
  }

  return Array.from(workflows).sort();
}
