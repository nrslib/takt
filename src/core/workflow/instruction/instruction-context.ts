/**
 * Instruction context types and execution metadata rendering
 *
 * Defines the context structures used by instruction builders,
 * and renders execution metadata (working directory, rules) as markdown.
 */

import type { AgentResponse, Language } from '../../models/types.js';
import { getPromptObject } from '../../../shared/prompts/index.js';

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
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** User inputs accumulated during workflow */
  userInputs: string[];
  /** Previous step output if available */
  previousOutput?: AgentResponse;
  /** Report directory path */
  reportDir?: string;
  /** Language for metadata rendering. Defaults to 'en'. */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
}

/** Execution environment metadata prepended to agent instructions */
export interface ExecutionMetadata {
  /** The agent's working directory (may be a clone) */
  readonly workingDirectory: string;
  /** Language for metadata rendering */
  readonly language: Language;
  /** Whether file editing is allowed for this step (undefined = no prompt) */
  readonly edit?: boolean;
}

/**
 * Build execution metadata from instruction context and step config.
 *
 * Pure function: (InstructionContext, edit?) → ExecutionMetadata.
 */
export function buildExecutionMetadata(context: InstructionContext, edit?: boolean): ExecutionMetadata {
  return {
    workingDirectory: context.cwd,
    language: context.language ?? 'en',
    edit,
  };
}

/** Shape of localized metadata strings from YAML */
export interface MetadataStrings {
  heading: string;
  workingDirectory: string;
  rulesHeading: string;
  noCommit: string;
  noCd: string;
  editEnabled: string;
  editDisabled: string;
  note: string;
}

/** Load metadata strings for the given language from YAML */
export function getMetadataStrings(language: Language): MetadataStrings {
  return getPromptObject<MetadataStrings>('instruction.metadata', language);
}

/**
 * Render execution metadata as a markdown string.
 *
 * Pure function: ExecutionMetadata → string.
 * Always includes heading + Working Directory + Execution Rules.
 * Language determines the output language; 'en' includes a note about language consistency.
 */
export function renderExecutionMetadata(metadata: ExecutionMetadata): string {
  const strings = getMetadataStrings(metadata.language);
  const lines = [
    strings.heading,
    `- ${strings.workingDirectory}: ${metadata.workingDirectory}`,
    '',
    strings.rulesHeading,
    `- ${strings.noCommit}`,
    `- ${strings.noCd}`,
  ];
  if (metadata.edit === true) {
    lines.push(`- ${strings.editEnabled}`);
  } else if (metadata.edit === false) {
    lines.push(`- ${strings.editDisabled}`);
  }
  if (strings.note) {
    lines.push('');
    lines.push(strings.note);
  }
  lines.push('');
  return lines.join('\n');
}
