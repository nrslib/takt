import type { ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../mcp/server.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';

const passthroughTools = new Set<string>([
  'Read', 'Glob', 'Grep', 'ToolSearch',
  ...TAKT_MCP_MANAGER_TOOL_NAMES.map((name) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`),
]);
const agentCommands = new Set(['claude', 'codex', 'cursor-agent', 'opencode', 'gemini', 'copilot', 'aider']);

type Classification = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'judge' };

// 未対応の shell 構文は解析結果を使わず、呼び出し全体を判断役へ渡す。
function commandWords(command: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: "'" | '"' | undefined;
  const flushWord = (): void => {
    if (hasWord) words.push(word);
    word = ''; hasWord = false;
  };
  const flushCommand = (): void => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined) return undefined;
      if (next !== '\n') {
        word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
        hasWord = true;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '$' || char === '`') return undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; hasWord = true; continue; }
    if ('$`()<>'.includes(char)) return undefined;
    if (char === '#' && !hasWord) {
      while (index < command.length && command[index] !== '\n') index++;
      flushCommand();
      continue;
    }
    if (';|&\n'.includes(char)) { flushCommand(); continue; }
    if (/\s/u.test(char)) { flushWord(); continue; }
    word += char; hasWord = true;
  }
  if (quote !== undefined) return undefined;
  flushCommand();
  return commands;
}

function launchesAgent(words: string[]): boolean {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? '')) index++;
  while (index < words.length) {
    const executable = words[index++]!.split('/').at(-1)!;
    if (executable === 'env') {
      while (index < words.length) {
        const value = words[index]!;
        if (value === '-u' || value === '--unset' || value === '-C' || value === '--chdir') { index += 2; continue; }
        if (value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) { index++; continue; }
        break;
      }
      continue;
    }
    if (executable === 'npx' || executable === 'bunx') {
      while (words[index]?.startsWith('-')) {
        const option = words[index++]!;
        if (option === '-p' || option === '--package') index++;
      }
      continue;
    }
    const packageName = executable.replace(/@[^@]*$/u, '');
    if (agentCommands.has(packageName)) return true;
    if (packageName === 'takt') {
      if (['run', 'pipeline', 'manager', 'watch', 'caccia', 'resume', 'exec', 'make', 'merge'].includes(words[index] ?? '')) return true;
      return words.slice(index).some((value) => ['--pipeline', '-t', '--task', '-i', '--issue', '--pr'].includes(value)
        || /^(?:--task|--issue|--pr)=/u.test(value));
    }
    return false;
  }
  return false;
}

export function classifyManagerToolPermission(request: ToolPermissionDecisionRequest): Classification {
  if (passthroughTools.has(request.toolName)) return { decision: 'allow' };
  if (request.toolName === 'Task' || request.toolName === 'Agent') {
    return { decision: 'deny', reason: `${request.toolName}: manager から別の AI エージェントを起動する操作は許可されていません。` };
  }
  if (request.toolName === 'Bash' && typeof request.toolInput === 'object' && request.toolInput !== null) {
    const command = (request.toolInput as Record<string, unknown>).command;
    if (typeof command === 'string' && commandWords(command)?.some(launchesAgent)) {
      return { decision: 'deny', reason: 'Bash: 別の AI コマンド行エージェントを起動する操作は許可されていません。' };
    }
  }
  return { decision: 'judge' };
}
