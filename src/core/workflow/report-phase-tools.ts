import type { RunAgentOptions } from '../../agents/runner.js';
import { PI_READONLY_TOOLS } from '../../infra/providers/pi-tool-policy.js';

export function reportPhaseEventTools(provider: RunAgentOptions['resolvedProvider']): readonly string[] {
  switch (provider) {
    case 'claude':
    case 'claude-sdk':
    case 'claude-headless':
    case 'claude-terminal':
      return ['Read', 'Glob', 'Grep', 'Bash'];
    case 'mock':
      return ['Read', 'Glob', 'Grep'];
    case 'codex':
      return ['Bash'];
    case 'opencode':
      return ['read', 'list', 'skill', 'glob', 'grep'];
    case 'pi':
      return PI_READONLY_TOOLS;
    case 'copilot':
      return ['view', 'glob', 'grep'];
    case 'kiro':
      return ['read', 'grep'];
    case 'cursor':
      return ['readToolCall', 'lsToolCall', 'globToolCall', 'grepToolCall',
        'semSearchToolCall', 'readLintsToolCall', 'readTodosToolCall'];
    case 'devin':
      return ['read', 'glob', 'grep'];
    default:
      return [];
  }
}
