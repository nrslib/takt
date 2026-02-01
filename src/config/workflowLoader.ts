/**
 * Workflow configuration loader
 *
 * Loads workflows with the following priority:
 * 1. Path-based input (absolute, relative, or home-dir) → load directly from file
 * 2. Project-local workflows: .takt/workflows/{name}.yaml
 * 3. User workflows: ~/.takt/workflows/{name}.yaml
 * 4. Builtin workflows: resources/global/{lang}/workflows/{name}.yaml
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../models/schemas.js';
import type { WorkflowConfig, WorkflowStep, WorkflowRule, ReportConfig, ReportObjectConfig } from '../models/types.js';
import { getGlobalWorkflowsDir, getBuiltinWorkflowsDir, getProjectConfigDir } from './paths.js';
import { getLanguage, getDisabledBuiltins } from './globalConfig.js';

/** Get builtin workflow by name */
export function getBuiltinWorkflow(name: string): WorkflowConfig | null {
  const lang = getLanguage();
  const disabled = getDisabledBuiltins();
  if (disabled.includes(name)) return null;

  const builtinDir = getBuiltinWorkflowsDir(lang);
  const yamlPath = join(builtinDir, `${name}.yaml`);
  if (existsSync(yamlPath)) {
    return loadWorkflowFromFile(yamlPath);
  }
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
function loadWorkflowFromFile(filePath: string): WorkflowConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const workflowDir = dirname(filePath);
  return normalizeWorkflowConfig(raw, workflowDir);
}

/**
 * Resolve a path that may be relative, absolute, or home-directory-relative.
 * @param pathInput Path to resolve
 * @param basePath Base directory for relative paths (defaults to cwd)
 * @returns Absolute resolved path
 */
function resolvePath(pathInput: string, basePath: string = process.cwd()): string {
  // Home directory expansion
  if (pathInput.startsWith('~')) {
    const home = homedir();
    return resolve(home, pathInput.slice(1).replace(/^\//, ''));
  }

  // Absolute path
  if (isAbsolute(pathInput)) {
    return pathInput;
  }

  // Relative path
  return resolve(basePath, pathInput);
}

/**
 * Load workflow from a file path.
 * Called internally by loadWorkflowByIdentifier when the identifier is detected as a path.
 *
 * @param filePath Path to workflow file (absolute, relative, or home-dir prefixed with ~)
 * @param basePath Base directory for resolving relative paths (default: cwd)
 * @returns WorkflowConfig or null if file not found
 */
function loadWorkflowFromPath(
  filePath: string,
  basePath: string = process.cwd()
): WorkflowConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);

  if (!existsSync(resolvedPath)) {
    return null;
  }

  return loadWorkflowFromFile(resolvedPath);
}

/**
 * Load workflow by name (name-based loading only, no path detection).
 *
 * Priority:
 * 1. Project-local workflows → .takt/workflows/{name}.yaml
 * 2. User workflows → ~/.takt/workflows/{name}.yaml
 * 3. Builtin workflows → resources/global/{lang}/workflows/{name}.yaml
 *
 * @param name Workflow name (not a file path)
 * @param projectCwd Project root directory (default: cwd, for project-local workflow resolution)
 */
export function loadWorkflow(
  name: string,
  projectCwd: string = process.cwd()
): WorkflowConfig | null {
  // 1. Project-local workflow (.takt/workflows/{name}.yaml)
  const projectWorkflowsDir = join(getProjectConfigDir(projectCwd), 'workflows');
  const projectWorkflowPath = join(projectWorkflowsDir, `${name}.yaml`);
  if (existsSync(projectWorkflowPath)) {
    return loadWorkflowFromFile(projectWorkflowPath);
  }

  // 2. User workflow (~/.takt/workflows/{name}.yaml)
  const globalWorkflowsDir = getGlobalWorkflowsDir();
  const workflowYamlPath = join(globalWorkflowsDir, `${name}.yaml`);
  if (existsSync(workflowYamlPath)) {
    return loadWorkflowFromFile(workflowYamlPath);
  }

  // 3. Builtin fallback
  return getBuiltinWorkflow(name);
}

/**
 * Load all workflows with descriptions (for switch command).
 *
 * Priority (later entries override earlier):
 *   1. Builtin workflows
 *   2. User workflows (~/.takt/workflows/)
 *   3. Project-local workflows (.takt/workflows/)
 */
export function loadAllWorkflows(cwd: string): Map<string, WorkflowConfig> {
  const workflows = new Map<string, WorkflowConfig>();
  const disabled = getDisabledBuiltins();

  // 1. Builtin workflows (lowest priority)
  const lang = getLanguage();
  const builtinDir = getBuiltinWorkflowsDir(lang);
  loadWorkflowsFromDir(builtinDir, workflows, disabled);

  // 2. User workflows (overrides builtins)
  const globalWorkflowsDir = getGlobalWorkflowsDir();
  loadWorkflowsFromDir(globalWorkflowsDir, workflows);

  // 3. Project-local workflows (highest priority)
  const projectWorkflowsDir = join(getProjectConfigDir(cwd), 'workflows');
  loadWorkflowsFromDir(projectWorkflowsDir, workflows);

  return workflows;
}

/** Load workflow files from a directory into a Map (later calls override earlier entries) */
function loadWorkflowsFromDir(
  dir: string,
  target: Map<string, WorkflowConfig>,
  disabled?: string[],
): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const entryPath = join(dir, entry);
    if (!statSync(entryPath).isFile()) continue;
    const workflowName = entry.replace(/\.ya?ml$/, '');
    if (disabled?.includes(workflowName)) continue;
    try {
      target.set(workflowName, loadWorkflowFromFile(entryPath));
    } catch {
      // Skip invalid workflows
    }
  }
}

/**
 * List available workflow names (builtin + user + project-local, excluding disabled).
 *
 * @param cwd Project root directory (used to scan project-local .takt/workflows/).
 */
export function listWorkflows(cwd: string): string[] {
  const workflows = new Set<string>();
  const disabled = getDisabledBuiltins();

  // 1. Builtin workflows
  const lang = getLanguage();
  const builtinDir = getBuiltinWorkflowsDir(lang);
  scanWorkflowDir(builtinDir, workflows, disabled);

  // 2. User workflows
  const globalWorkflowsDir = getGlobalWorkflowsDir();
  scanWorkflowDir(globalWorkflowsDir, workflows);

  // 3. Project-local workflows
  const projectWorkflowsDir = join(getProjectConfigDir(cwd), 'workflows');
  scanWorkflowDir(projectWorkflowsDir, workflows);

  return Array.from(workflows).sort();
}

/**
 * Check if a workflow identifier looks like a file path (vs a workflow name).
 *
 * Path indicators:
 * - Starts with `/` (absolute path)
 * - Starts with `~` (home directory)
 * - Starts with `./` or `../` (relative path)
 * - Ends with `.yaml` or `.yml` (file extension)
 */
export function isWorkflowPath(identifier: string): boolean {
  return (
    identifier.startsWith('/') ||
    identifier.startsWith('~') ||
    identifier.startsWith('./') ||
    identifier.startsWith('../') ||
    identifier.endsWith('.yaml') ||
    identifier.endsWith('.yml')
  );
}

/**
 * Load workflow by identifier (auto-detects name vs path).
 *
 * If the identifier looks like a path (see isWorkflowPath), loads from file.
 * Otherwise, loads by name with the standard priority chain:
 *   project-local → user → builtin.
 *
 * @param identifier Workflow name or file path
 * @param projectCwd Project root directory (for project-local resolution and relative path base)
 */
export function loadWorkflowByIdentifier(
  identifier: string,
  projectCwd: string
): WorkflowConfig | null {
  if (isWorkflowPath(identifier)) {
    return loadWorkflowFromPath(identifier, projectCwd);
  }
  return loadWorkflow(identifier, projectCwd);
}

/** Scan a directory for .yaml/.yml files and add names to the set */
function scanWorkflowDir(dir: string, target: Set<string>, disabled?: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

    const entryPath = join(dir, entry);
    if (statSync(entryPath).isFile()) {
      const workflowName = entry.replace(/\.ya?ml$/, '');
      if (disabled?.includes(workflowName)) continue;
      target.add(workflowName);
    }
  }
}
