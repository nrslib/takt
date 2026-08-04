import type { ProviderType } from './types.js';

/**
 * Static per-provider model suggestions for interactive setup and exec config prompts.
 *
 * Lives in `infra/providers` (provider metadata's home) so infra entry points such as first-run
 * `initialization` can read it without an `infra → features` upward dependency. Providers absent
 * from the table (e.g. cursor / copilot / kiro) resolve to an empty candidate list.
 */
const EXEC_MODEL_CANDIDATES: Partial<Record<ProviderType, readonly string[]>> = {
  claude: ['opus', 'sonnet', 'haiku'],
  'claude-sdk': ['opus', 'sonnet', 'haiku'],
  'claude-terminal': ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5'],
  opencode: ['opencode/big-pickle'],
  mock: ['mock-model'],
};

export function getExecModelCandidates(provider: ProviderType): readonly string[] {
  return EXEC_MODEL_CANDIDATES[provider] ?? [];
}
