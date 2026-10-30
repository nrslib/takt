import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePhaseEvents } from './phase-events.mjs';
import { reportPhaseEventTools } from '../../dist/core/workflow/report-phase-tools.js';

export { parsePhaseEvents };

export function snapshotFiles(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else files[path.slice(root.length)] = stat.isSymbolicLink() ? readlinkSync(path)
        : createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  visit(root);
  return files;
}

// This is an eval audit, not a shell sandbox: reject identifiable prohibited actions.
export function shellTokens(command) {
  const tokens = [];
  const pattern = /\s+|'([^']*)'|"((?:\\.|[^"\\])*)"|(&&|\|\||>>|[|;<>\n])|((?:\\.|[^\s'";&|<>])+)/gy;
  let index = 0;
  while (index < command.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(command);
    if (!match) return undefined;
    index = pattern.lastIndex;
    if (/^\s+$/.test(match[0])) {
      if (match[0].includes('\n')) tokens.push({ operator: ';' });
      continue;
    }
    tokens.push(match[3] ? { operator: match[3] } : match[1] ?? match[2] ?? match[4]);
  }
  return tokens;
}

export function fixtureExecutionEntrypoints(cwd) {
  const { scripts = {} } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  return new Set(Object.entries(scripts)
    .filter(([name]) => /^(?:pre|post)?(?:test|build)(?:$|:)/.test(name))
    .flatMap(([, command]) => shellTokens(command) ?? [])
    .filter((token) => typeof token === 'string' && !token.startsWith('-'))
    .map((path) => resolve(cwd, path))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile()));
}

export function classifyReadCommand(command, fixture) {
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const tokens = shellTokens(command);
  if (!tokens) return undefined;
  const commands = [[]];
  for (const token of tokens) {
    if (typeof token === 'object') {
      if (['>', '>>'].includes(token.operator)) return 'write/redirection attempt';
      if (token.operator !== '<') commands.push([]);
    } else commands.at(-1).push(token);
  }
  let commandCwd = fixture?.cwd;
  for (const args of commands) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) args.shift();
    const name = args[0]?.split('/').at(-1);
    if (fixture && args.length > 0) {
      if (name === 'cd' && args.length === 2) commandCwd = resolve(commandCwd, args[1]);
      const paths = ['python', 'python3', 'node', 'bun', 'deno', 'tsx', 'ts-node', 'ruby', 'perl', 'bash', 'zsh', 'sh'].includes(name)
        ? args.slice(1) : args.slice(0, 1);
      if (paths.some((path) => fixture.entrypoints.has(resolve(commandCwd, path)))) return 'test/build attempt';
    }
    if (['bash', 'zsh', 'sh'].includes(name) && args.length === 3 && ['-c', '-lc'].includes(args[1])) {
      const violation = classifyReadCommand(args[2], fixture && { ...fixture, cwd: commandCwd });
      if (violation) return violation;
    } else if (['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv'].includes(name)) {
      const action = args[1] === 'run' || (name === 'uv' && args[1] === 'pip') ? args[2] : args[1];
      if (/^(?:test|build|install|add|ci|sync|update|uninstall|remove)(?:$|:)/.test(action)) {
        return 'test/build/install attempt';
      }
    } else if (['npx', 'pnpx'].includes(name)) {
      const violation = classifyReadCommand(args.slice(1).join(' '), fixture && { ...fixture, cwd: commandCwd });
      if (violation) return violation;
    } else if (['vitest', 'jest', 'mocha', 'pytest', 'make', 'cmake', 'tsc', 'webpack', 'vite', 'rollup'].includes(name)
      || /(?:^|[-_.])(?:test|build)(?:[-_.]|$)/.test(name)) {
      return 'test/build attempt';
    } else if (['tee', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'install', 'truncate', 'chmod', 'chown'].includes(name)) {
      return 'write attempt';
    } else if (name === 'sed') {
      if (args.slice(1).some((arg) => /^-\w*i|^--in-place(?:=|$)|(?:^|[;\n])\s*(?:\d+(?:,\d+)?)?[we]\s/.test(arg))) {
        return 'write attempt';
      }
    } else if (name === 'git') {
      const action = args.slice(1).find((arg, index) => !arg.startsWith('-')
        && !['-C', '-c', '--git-dir', '--work-tree'].includes(args[index]));
      if (/^(?:commit|add|rm|mv|reset|restore|checkout|switch|clean|merge|rebase|cherry-pick|push|pull|fetch|clone|init)$/.test(action)
        || args.some((arg) => /^--output(?:=|$)/.test(arg))) {
        return 'write attempt';
      }
    } else if (['python', 'python3', 'node'].includes(name)) {
      if (args.some((arg) => /^(?:--test(?:=|$)|pytest$|unittest$)/.test(arg))) return 'test/build attempt';
      const codeFlag = args.findIndex((arg) => ['-c', '-e', '--eval', '-p', '--print'].includes(arg));
      if (codeFlag !== -1) {
        const code = args[codeFlag + 1] ?? '';
        const writesFile = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|writeSync|unlink(?:Sync)?|rename(?:Sync)?|mkdir(?:Sync)?|rmdir(?:Sync)?|rm(?:Sync)?|remove|truncate(?:Sync)?|write_text|write_bytes)\s*\(/.test(code);
        const opensForWrite = /\b(?:open|openSync)\s*\([^,\n]*,\s*(?:mode\s*=\s*)?["'](?:[wax][^"']*|r[^"']*\+[^"']*)["']/.test(code);
        if (writesFile || opensForWrite) {
          return 'write attempt';
        }
      }
    }
  }
  return undefined;
}

function auditPhase2Tools(tools, cli, cwd) {
  const violations = [];
  const allowedTools = new Set(reportPhaseEventTools(cli));
  const fixture = cwd === undefined ? undefined : { cwd, entrypoints: fixtureExecutionEntrypoints(cwd) };
  for (const tool of tools) {
    // Codex CLI calls the runner's Bash event command_execution.
    const name = cli === 'codex' && tool.name === 'command_execution' ? 'Bash' : tool.name;
    if (!allowedTools.has(name)) {
      violations.push(`unauthorized tool: ${tool.name}`);
      continue;
    }
    if (name === 'Bash') {
      const command = typeof tool.input === 'string' ? tool.input : tool.input?.command;
      if (typeof command !== 'string' || !command.trim()) violations.push('missing command receipt');
      else {
        const violation = classifyReadCommand(command, fixture);
        if (violation) violations.push(violation);
      }
    }
  }
  return violations;
}

export function auditPhase2Trace(trace, cwd) {
  if (trace?.toolCount === 0) return [];
  if (!Array.isArray(trace?.toolTypes) || trace.toolTypes.length !== trace.toolCount
    || !Array.isArray(trace.commands)
    || trace.commands.length !== trace.toolTypes.filter((type) => type === 'command_execution').length) {
    return ['missing Phase 2 tool receipts'];
  }
  let commandIndex = 0;
  const tools = trace.toolTypes.map((name) => ({
    name, input: name === 'command_execution' ? trace.commands[commandIndex++].command : undefined,
  }));
  return auditPhase2Tools(tools, 'codex', cwd);
}

function isRecordEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  switch (entry.kind) {
    case 'instruction':
      return typeof entry.reason === 'string' && typeof entry.prompt === 'object' && typeof entry.dispatched === 'boolean';
    case 'provider_event':
      return typeof entry.event?.type === 'string' && entry.event.data !== undefined;
    case 'attempt_result':
      return typeof entry.status === 'string' && (typeof entry.content === 'string' || Number.isInteger(entry.content?.chunks));
    case 'content_chunk':
      return Number.isInteger(entry.entry) && Array.isArray(entry.field) && Number.isInteger(entry.part)
        && Number.isInteger(entry.total) && typeof entry.content === 'string';
    default:
      return false;
  }
}

function measureOutput(content) {
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + (block.type === 'text' ? measureOutput(block.text) : 0), 0);
  }
  let returnedBytes = 0;
  for (const line of content.split(/\r?\n/).filter((line) => line.trim())) {
    // Read and search tools can prefix JSONL rows with file names and line numbers.
    const start = line.indexOf('{');
    const json = start === -1 ? line : line.slice(start);
    let entry;
    try { entry = JSON.parse(json); }
    catch { continue; }
    if (isRecordEntry(entry)) returnedBytes += Buffer.byteLength(json) + 1;
  }
  return returnedBytes;
}

export function auditPhase2({ events, cli, reference, cwd, before, after }) {
  const violations = [];
  let observation;
  try { observation = parsePhaseEvents(events.map((event) => JSON.stringify(event)).join('\n'), cli, false); }
  catch (error) { return { pass: false, violations: [error.message], returnedBytes: 0, tools: [] }; }
  let returnedBytes = 0;
  if (cli === 'claude') {
    const calls = new Set();
    for (const event of events) {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') calls.add(block.id);
        if (block.type === 'tool_result') {
          if (!calls.has(block.tool_use_id)) violations.push('unmatched tool result');
          returnedBytes += measureOutput(block.content);
        }
      }
    }
  }
  for (const tool of observation.tools) {
    if (cli === 'codex') returnedBytes += measureOutput(tool.output);
  }
  violations.push(...auditPhase2Tools(observation.tools, cli, cwd));
  // Count identifiable record rows, including repeated/overlapping reads, rather than unrelated output or bytes scanned by rg.
  const smallRecordBytes = 64 * 1024;
  const maxReturnedFraction = 0.5;
  if (reference.byteSize > smallRecordBytes && returnedBytes > reference.byteSize * maxReturnedFraction) {
    violations.push('whole record equivalent returned');
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) violations.push('fixture files changed');
  return { pass: violations.length === 0, violations, returnedBytes, tools: observation.tools };
}
