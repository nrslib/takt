/**
 * Workflow configuration loader
 *
 * Loads workflows from ~/.takt/workflows/ directory only.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../models/schemas.js';
import type { WorkflowConfig, WorkflowStep, WorkflowRule, ReportConfig } from '../models/types.js';
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
 * Normalize the raw report field from YAML into internal format.
 *
 * YAML formats:
 *   report: "00-plan.md"                  → string (single file)
 *   report:                               → ReportConfig[] (multiple files)
 *     - Scope: 01-scope.md
 *     - Decisions: 02-decisions.md
 *
 * Array items are parsed as single-key objects: [{Scope: "01-scope.md"}, ...]
 */
function normalizeReport(
  raw: string | Record<string, string>[] | undefined,
): string | ReportConfig[] | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  // Convert [{Scope: "01-scope.md"}, ...] to [{label: "Scope", path: "01-scope.md"}, ...]
  return raw.flatMap((entry) =>
    Object.entries(entry).map(([label, path]) => ({ label, path })),
  );
}

/**
 * Convert raw YAML workflow config to internal format.
 * Agent paths are resolved relative to the workflow directory.
 */
function normalizeWorkflowConfig(raw: unknown, workflowDir: string): WorkflowConfig {
  const parsed = WorkflowConfigRawSchema.parse(raw);

  const steps: WorkflowStep[] = parsed.steps.map((step) => {
    const rules: WorkflowRule[] | undefined = step.rules?.map((r) => ({
      condition: r.condition,
      next: r.next,
      appendix: r.appendix,
    }));

    return {
      name: step.name,
      agent: step.agent,
      agentDisplayName: step.agent_name || extractAgentDisplayName(step.agent),
      agentPath: resolveAgentPathForWorkflow(step.agent, workflowDir),
      allowedTools: step.allowed_tools,
      provider: step.provider,
      model: step.model,
      permissionMode: step.permission_mode,
      instructionTemplate: step.instruction_template || step.instruction || '{task}',
      rules,
      report: normalizeReport(step.report),
      passPreviousResponse: step.pass_previous_response,
    };
  });

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
