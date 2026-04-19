import type { ClaudeEffort } from '../models/workflow-types.js';

const CLAUDE_MODEL_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku']);

const ALL_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'max'];

const CLAUDE_EFFORT_BY_MODEL: Readonly<Record<string, readonly ClaudeEffort[]>> = {
  'claude-opus-4-7': ALL_EFFORTS,
  'claude-opus-4-6': NO_XHIGH_EFFORTS,
  'claude-sonnet-4-6': NO_XHIGH_EFFORTS,
  'claude-haiku-4-5': NO_XHIGH_EFFORTS,
};

function getAllowedEfforts(model: string): readonly ClaudeEffort[] | undefined {
  const exact = CLAUDE_EFFORT_BY_MODEL[model];
  if (exact) return exact;
  for (const [prefix, efforts] of Object.entries(CLAUDE_EFFORT_BY_MODEL)) {
    if (model.startsWith(`${prefix}-`)) return efforts;
  }
  return undefined;
}

export function validateClaudeEffortCompatibility(
  model: string | undefined,
  effort: ClaudeEffort | undefined,
): void {
  if (!model || !effort) return;
  if (CLAUDE_MODEL_ALIASES.has(model)) return;

  const allowed = getAllowedEfforts(model);
  if (!allowed) return;

  if (!allowed.includes(effort)) {
    const xhighHint = effort === 'xhigh'
      ? " 'xhigh' is supported only by Opus 4.7 (claude-opus-4-7)."
      : '';
    throw new Error(
      `Configuration error: provider_options.claude.effort '${effort}' is not supported by model '${model}'. `
      + `Allowed values for this model: ${allowed.join(', ')}.${xhighHint}`,
    );
  }
}
