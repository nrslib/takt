/**
 * Instruction template builder for workflow steps
 *
 * Builds the instruction string for agent execution by replacing
 * template placeholders with actual values.
 */

import { join } from 'node:path';
import type { WorkflowStep, AgentResponse, Language } from '../models/types.js';
import { getGitDiff } from '../agents/runner.js';

/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number (workflow-wide turn count) */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Current step's iteration number (how many times this step has been executed) */
  stepIteration: number;
  /** Working directory (agent work dir, may be a worktree) */
  cwd: string;
  /** Project root directory (where .takt/ lives). Defaults to cwd. */
  projectCwd?: string;
  /** User inputs accumulated during workflow */
  userInputs: string[];
  /** Previous step output if available */
  previousOutput?: AgentResponse;
  /** Report directory path */
  reportDir?: string;
  /** Language for metadata rendering. Defaults to 'en'. */
  language?: Language;
}

/** Execution environment metadata prepended to agent instructions */
export interface ExecutionMetadata {
  /** The agent's working directory (may be a worktree) */
  readonly workingDirectory: string;
  /** Language for metadata rendering */
  readonly language: Language;
}

/**
 * Build execution metadata from instruction context.
 *
 * Pure function: InstructionContext → ExecutionMetadata.
 */
export function buildExecutionMetadata(context: InstructionContext): ExecutionMetadata {
  return {
    workingDirectory: context.cwd,
    language: context.language ?? 'en',
  };
}

/** Localized strings for execution metadata rendering */
const METADATA_STRINGS = {
  en: {
    heading: '## Execution Context',
    workingDirectory: 'Working Directory',
    note: 'Note: This section is metadata. Follow the language used in the rest of the prompt.',
  },
  ja: {
    heading: '## 実行コンテキスト',
    workingDirectory: '作業ディレクトリ',
    note: '',
  },
} as const;

/**
 * Render execution metadata as a markdown string.
 *
 * Pure function: ExecutionMetadata → string.
 * Always includes heading + Working Directory.
 * Language determines the output language; 'en' includes a note about language consistency.
 */
export function renderExecutionMetadata(metadata: ExecutionMetadata): string {
  const strings = METADATA_STRINGS[metadata.language];
  const lines = [
    strings.heading,
    `- ${strings.workingDirectory}: ${metadata.workingDirectory}`,
  ];
  if (strings.note) {
    lines.push('');
    lines.push(strings.note);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Escape special characters in dynamic content to prevent template injection.
 */
function escapeTemplateChars(str: string): string {
  return str.replace(/\{/g, '｛').replace(/\}/g, '｝');
}

/**
 * Build instruction from template with context values.
 *
 * Supported placeholders:
 * - {task} - The main task/prompt
 * - {iteration} - Current iteration number (workflow-wide turn count)
 * - {max_iterations} - Maximum iterations allowed
 * - {step_iteration} - Current step's iteration number (how many times this step has been executed)
 * - {previous_response} - Output from previous step (if passPreviousResponse is true)
 * - {git_diff} - Current git diff output
 * - {user_inputs} - Accumulated user inputs
 * - {report_dir} - Report directory name (e.g., "20250126-143052-task-summary")
 */
export function buildInstruction(
  step: WorkflowStep,
  context: InstructionContext
): string {
  let instruction = step.instructionTemplate;

  // Replace {task}
  instruction = instruction.replace(/\{task\}/g, escapeTemplateChars(context.task));

  // Replace {iteration}, {max_iterations}, and {step_iteration}
  instruction = instruction.replace(/\{iteration\}/g, String(context.iteration));
  instruction = instruction.replace(/\{max_iterations\}/g, String(context.maxIterations));
  instruction = instruction.replace(/\{step_iteration\}/g, String(context.stepIteration));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousOutput) {
      instruction = instruction.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousOutput.content)
      );
    } else {
      instruction = instruction.replace(/\{previous_response\}/g, '');
    }
  }

  // Replace {git_diff}
  const gitDiff = getGitDiff(context.cwd);
  instruction = instruction.replace(/\{git_diff\}/g, gitDiff);

  // Replace {user_inputs}
  const userInputsStr = context.userInputs.join('\n');
  instruction = instruction.replace(
    /\{user_inputs\}/g,
    escapeTemplateChars(userInputsStr)
  );

  // Replace .takt/reports/{report_dir} with absolute path first,
  // then replace standalone {report_dir} with the directory name.
  // This ensures agents always use the correct project root for reports,
  // even when their cwd is a worktree.
  if (context.reportDir) {
    const projectRoot = context.projectCwd ?? context.cwd;
    const reportDirFullPath = join(projectRoot, '.takt', 'reports', context.reportDir);
    instruction = instruction.replace(/\.takt\/reports\/\{report_dir\}/g, reportDirFullPath);
    instruction = instruction.replace(/\{report_dir\}/g, context.reportDir);
  }

  // Append status_rules_prompt if present
  if (step.statusRulesPrompt) {
    instruction = `${instruction}\n\n${step.statusRulesPrompt}`;
  }

  // Prepend execution context metadata so agents see it first.
  // Now language-aware, so no need to hide it at the end.
  const metadata = buildExecutionMetadata(context);
  instruction = `${renderExecutionMetadata(metadata)}\n${instruction}`;

  return instruction;
}
