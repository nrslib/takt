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

function backtickSubstitution(command: string, start: number): { body: string; end: number } | undefined {
  let body = '';
  for (let index = start + 1; index < command.length; index++) {
    const char = command[index]!;
    if (char === '`') return { body, end: index };
    const next = command[index + 1];
    // バッククォートでは、これら以外の文字の前のバックスラッシュは本文に残る。
    if (char === '\\' && next !== undefined && ['$', '`', '\\', '\n'].includes(next)) {
      index++;
      if (next !== '\n') body += next;
    } else body += char;
  }
  return undefined;
}

function nextCommandBoundary(command: string, start: number, quote: ShellQuote): { boundary?: number; substitutions: string[] } {
  const substitutions: string[] = [];
  const scopes: { quote: ShellQuote; depth: number; hasWord: boolean; start: number }[] = [{ quote, depth: 0, hasWord: true, start }];
  for (let index = start; index < command.length; index++) {
    const scope = scopes.at(-1)!;
    const char = command[index]!;
    if (scope.quote === "'") {
      if (char === "'") scope.quote = undefined;
      continue;
    }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined) return { substitutions };
      if (next !== '\n') scope.hasWord = true;
      continue;
    }
    if (scope.quote === '"' && char === '"') { scope.quote = undefined; continue; }
    if (char === '$' && command[index + 1] === '(') {
      scope.hasWord = true;
      scopes.push({ quote: undefined, depth: 1, hasWord: false, start: index + 2 });
      index++;
      continue;
    }
    if (char === '`') {
      const substitution = backtickSubstitution(command, index);
      if (substitution === undefined) return { substitutions };
      if (scopes.length === 1) substitutions.push(substitution.body);
      index = substitution.end;
      scope.hasWord = true;
      continue;
    }
    if (char === '$') {
      const parameter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/u.exec(command.slice(index));
      if (parameter === null) return { substitutions };
      index += parameter[0].length - 1;
      scope.hasWord = true;
      continue;
    }
    if (scope.quote === '"') continue;
    if (char === "'" || char === '"') { scope.quote = char; scope.hasWord = true; continue; }
    if (char === '#' && !scope.hasWord) {
      while (index < command.length && command[index] !== '\n') index++;
      if (scopes.length === 1) return { boundary: index < command.length ? index : undefined, substitutions };
      continue;
    }
    if (char === '(' || char === ')') {
      if (scopes.length === 1) return { substitutions };
      scope.depth += char === '(' ? 1 : -1;
      if (scope.depth === 0) {
        scopes.pop();
        if (scopes.length === 1) substitutions.push(command.slice(scope.start, index));
      }
      scope.hasWord = false;
      continue;
    }
    if ('<>'.includes(char)) return { substitutions };
    if (';|&\n'.includes(char) && scopes.length === 1) return { boundary: index, substitutions };
    scope.hasWord = !/[\s;|&]/u.test(char);
  }
  return { substitutions };
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
    if (char === '$' || char === '`') {
      complete = false;
      const { boundary, substitutions } = nextCommandBoundary(command, index, quote);
      for (const body of substitutions) commands.push(...commandWords(body).commands);
      if (boundary === undefined) return incompleteResult();
      if (words.length > 0) commands.push(words);
      words = []; word = ''; hasWord = false; quote = undefined;
      index = boundary;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; hasWord = true; continue; }
    if ('()<>'.includes(char)) return incompleteResult();
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

function normalizeNpmWorkspaceBooleanOption(name: string): string | undefined {
  if (name === 'workspaces' || name === 'ws') return 'workspaces';
  if (name === 'include-workspace-root' || name === 'iwr') return 'include-workspace-root';
  // include と include-staged に衝突しない、一意な長形式省略だけを認識する。
  if (name.startsWith('include-w') && 'include-workspace-root'.startsWith(name)) return 'include-workspace-root';
  return undefined;
}

function npmWorkspaceOptionEnd(words: string[], index: number): number | undefined {
  const option = words[index]!;
  if (option === '--workspace' || option === '-w') {
    const value = words[index + 1];
    return value === undefined || value.length === 0 || value.startsWith('-') ? undefined : index + 2;
  }
  if (/^(?:--workspace|-w)=.+/u.test(option)) return index + 1;
  const booleanOption = /^--(?:no-)?([^=]+)(?:=(?:true|false))?$/u.exec(option);
  if (booleanOption !== null && normalizeNpmWorkspaceBooleanOption(booleanOption[1]!) !== undefined) {
    return !option.includes('=') && (words[index + 1] === 'true' || words[index + 1] === 'false')
      ? index + 2 : index + 1;
  }
  return undefined;
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
    if (executable === 'bunx') {
      while (words[index]?.startsWith('-')) {
        const option = words[index++]!;
        if (option === '-p' || option === '--package') index++;
      }
      continue;
    }
    if (executable === 'npm' || executable === 'npx' || executable === 'pnpm' || executable === 'yarn') {
      if (executable === 'npm') {
        while (words[index]?.startsWith('-')) {
          const end = npmWorkspaceOptionEnd(words, index);
          if (end === undefined) return undefined;
          index = end;
        }
      }
      let subcommand = executable === 'npx' ? 'exec' : words[index++];
      if (executable === 'npm' && subcommand === 'x') subcommand = 'exec';
      const npmRunner = executable === 'npm' || executable === 'npx';
      if (executable === 'npm' && subcommand === 'install') return false;
      if (!((npmRunner || executable === 'pnpm') && subcommand === 'exec')
        && !((executable === 'pnpm' || executable === 'yarn') && subcommand === 'dlx')) return undefined;
      let shellCommand: string | undefined;
      let shellMode = false;
      while (words[index]?.startsWith('-')) {
        if (npmRunner) {
          const end = npmWorkspaceOptionEnd(words, index);
          if (end !== undefined) { index = end; continue; }
        }
        const option = words[index++]!;
        if (option === '--') break;
        if (npmRunner && (/^--(?:no-)?(?:par|parseable|porcelain)(?:=(?:true|false))?$/u.test(option)
          || (executable === 'npm' && /^-p(?:=(?:true|false))?$/u.test(option)))) {
          if (!option.includes('=') && (words[index] === 'true' || words[index] === 'false')) index++;
          continue;
        }
        if (npmRunner && (option === '-c' || option === '--call')) {
          if (words[index] === undefined || words[index]!.startsWith('-')) return undefined;
          shellCommand = words[index++];
          continue;
        }
        if (npmRunner && option.startsWith('--call=')) {
          shellCommand = option.slice('--call='.length);
          continue;
        }
        if (executable === 'pnpm' && subcommand === 'dlx' && (option === '-c' || option === '--shell-mode')) {
          shellMode = true;
          continue;
        }
        if (npmRunner || subcommand === 'dlx') {
          if ((executable !== 'npm' && option === '-p') || option === '--package') {
            if (words[index] === undefined || words[index]!.startsWith('-')) return undefined;
            index++;
            continue;
          }
          if (/^--package=.+/u.test(option)) continue;
        }
        if (npmRunner && ['-y', '--yes', '--no'].includes(option)) continue;
        return undefined;
      }
      if (shellCommand !== undefined) {
        return shellCommand.trim().length === 0 || index < words.length ? undefined : commandLaunchesAgent(shellCommand);
      }
      if (index >= words.length) return undefined;
      if (shellMode) return commandLaunchesAgent(words.slice(index).join(' '));
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
