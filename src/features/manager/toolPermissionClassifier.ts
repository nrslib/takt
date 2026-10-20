import type { ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import type { Language } from '../../core/models/types.js';
import type { ProviderType } from '../../shared/types/provider.js';
import { getLabel } from '../../shared/i18n/index.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../mcp/server.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';
import { isManagerReadAllowed } from './readScope.js';

const codexPassthroughTools = new Set<string>([
  ...TAKT_MCP_MANAGER_TOOL_NAMES.map((name) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`),
]);
const claudePassthroughTools = new Set<string>(['ToolSearch', ...codexPassthroughTools]);
const agentCommands = new Set(['claude', 'codex', 'cursor-agent', 'opencode', 'gemini', 'copilot', 'aider']);
const prefixValueOptions: Record<string, readonly string[]> = {
  nohup: [],
  exec: ['-a'],
  command: [],
  time: ['-f', '--format', '-o', '--output'],
  nice: ['-n', '--adjustment'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-R', '--chroot', '-D', '--chdir', '-r', '--role', '-t', '--type'],
  xargs: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'],
  stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
  timeout: ['-k', '--kill-after', '-s', '--signal'],
};

type Classification = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'judge' };
type ShellQuote = "'" | '"' | undefined;

function nextCommandBoundary(command: string, start: number, quote: ShellQuote): number | undefined {
  const scopes: { quote: ShellQuote; depth: number; hasWord: boolean }[] = [{ quote, depth: 0, hasWord: true }];
  for (let index = start; index < command.length; index++) {
    const scope = scopes.at(-1)!;
    const char = command[index]!;
    if (scope.quote === "'") {
      if (char === "'") scope.quote = undefined;
      continue;
    }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined) return undefined;
      if (next !== '\n') scope.hasWord = true;
      continue;
    }
    if (scope.quote === '"' && char === '"') { scope.quote = undefined; continue; }
    if (char === '$' && command[index + 1] === '(') {
      scope.hasWord = true;
      scopes.push({ quote: undefined, depth: 1, hasWord: false });
      index++;
      continue;
    }
    if (char === '$' || char === '`') return undefined;
    if (scope.quote === '"') continue;
    if (char === "'" || char === '"') { scope.quote = char; scope.hasWord = true; continue; }
    if (char === '#' && !scope.hasWord) {
      while (index < command.length && command[index] !== '\n') index++;
      if (scopes.length === 1) return index < command.length ? index : undefined;
      continue;
    }
    if (char === '(' || char === ')') {
      if (scopes.length === 1) return undefined;
      scope.depth += char === '(' ? 1 : -1;
      if (scope.depth === 0) scopes.pop();
      scope.hasWord = false;
      continue;
    }
    if ('<>'.includes(char)) return undefined;
    if (';|&\n'.includes(char) && scopes.length === 1) return index;
    scope.hasWord = !/[\s;|&]/u.test(char);
  }
  return undefined;
}

// 未対応部分の単語は確定せず、外側の区切りが確認できたコマンドだけを追加する。
function commandWords(command: string): { commands: string[][]; complete: boolean } {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: ShellQuote;
  let complete = true;
  const flushWord = (): void => {
    if (hasWord) words.push(word);
    word = ''; hasWord = false;
  };
  const flushCommand = (): void => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const incompleteResult = (): { commands: string[][]; complete: boolean } => ({
    commands: words.length > 0 ? [...commands, words] : commands,
    complete: false,
  });
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined) return incompleteResult();
      if (next !== '\n') {
        word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
        hasWord = true;
      }
      continue;
    }
    if (char === '$' && command[index + 1] === '(') {
      complete = false;
      const boundary = nextCommandBoundary(command, index, quote);
      if (boundary === undefined) return incompleteResult();
      if (words.length > 0) commands.push(words);
      words = []; word = ''; hasWord = false; quote = undefined;
      index = boundary;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '$' || char === '`') return incompleteResult();
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; hasWord = true; continue; }
    if ('$`()<>'.includes(char)) return incompleteResult();
    if (char === '#' && !hasWord) {
      while (index < command.length && command[index] !== '\n') index++;
      flushCommand();
      continue;
    }
    if (';|&\n'.includes(char)) { flushCommand(); continue; }
    if (/\s/u.test(char)) { flushWord(); continue; }
    word += char; hasWord = true;
  }
  if (quote !== undefined) return incompleteResult();
  flushCommand();
  return { commands, complete };
}

function commandLaunchesAgent(command: string): boolean | undefined {
  const { commands, complete } = commandWords(command);
  const results = commands.map(launchesAgent);
  if (results.includes(true)) return true;
  return !complete || results.includes(undefined) ? undefined : false;
}

function launchesAgent(words: string[]): boolean | undefined {
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
    if (Object.hasOwn(prefixValueOptions, executable)) {
      const valueOptions = prefixValueOptions[executable]!;
      while (words[index]?.startsWith('-')) {
        const option = words[index++]!;
        if (option === '--') break;
        if (executable === 'command' && /^-[pVv]*[Vv][pVv]*$/u.test(option)) return false;
        if (valueOptions.includes(option)) index++;
      }
      if (executable === 'timeout') index++;
      continue;
    }
    if (executable === 'bash' || executable === 'sh' || executable === 'zsh') {
      while (words[index]?.startsWith('-')) {
        const option = words[index++]!;
        if (option === '--') break;
        if (/^-[^-]*c/u.test(option)) {
          const command = words[index];
          return command === undefined ? undefined : commandLaunchesAgent(command);
        }
        if (option === '-o' || option === '-O') index++;
      }
      return false;
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

export function classifyManagerToolPermission(request: ToolPermissionDecisionRequest, language: Language, provider: ProviderType): Classification {
  const passthroughTools = provider === 'codex' ? codexPassthroughTools : claudePassthroughTools;
  if (passthroughTools.has(request.toolName)) return { decision: 'allow' };
  if (provider !== 'codex' && ['Read', 'Glob', 'Grep'].includes(request.toolName)) {
    return { decision: isManagerReadAllowed(request) ? 'allow' : 'judge' };
  }
  if (request.toolName === 'Task' || request.toolName === 'Agent'
    || (provider === 'codex' && request.toolName === 'spawn_agent')) {
    return { decision: 'deny', reason: getLabel('manager.toolPermission.agentDenied', language, { toolName: request.toolName }) };
  }
  if (request.toolName === 'Bash' && typeof request.toolInput === 'object' && request.toolInput !== null) {
    const command = (request.toolInput as Record<string, unknown>).command;
    if (typeof command === 'string' && commandLaunchesAgent(command) === true) {
      return { decision: 'deny', reason: getLabel('manager.toolPermission.bashDenied', language) };
    }
  }
  return { decision: 'judge' };
}
