import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePhaseEvents } from './phase-events.mjs';
import { fixtureExecutionEntrypoints, shellTokens, snapshotFiles as snapshotAllFiles } from './phase1-execution-log-audit.mjs';

const editingTools = new Set(['Edit', 'Write', 'NotebookEdit', 'file_change', 'apply_patch']);

export function snapshotFiles(cwd) {
  return Object.fromEntries(Object.entries(snapshotAllFiles(cwd))
    .filter(([path]) => !/^\/\.takt\/(?:runs\/eval|eval-snapshots)(?:\/|$)/.test(path)));
}

function commandViolation(command, fixture) {
  // Preserve quoted arguments; descriptor duplication and /dev/null are not file writes.
  const withoutOutputRouting = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\d*>>?\s*\/dev\/null(?=$|[\s;&|])|\d*>&\d+/g,
    (match) => /^["']/.test(match) ? match : ' ');
  const tokens = shellTokens(withoutOutputRouting);
  // Commands are supplementary evidence. Unknown syntax is covered by snapshots and execution markers.
  if (!tokens) return undefined;
  const commands = [[]];
  for (const token of tokens) {
    if (typeof token === 'object') {
      if (['>', '>>'].includes(token.operator)) return 'write/redirection attempt';
      if (token.operator !== '<') commands.push([]);
    }
    else commands.at(-1).push(token);
  }
  let cwd = fixture.cwd;
  for (const args of commands) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]) || ['env', 'command'].includes(args[0])) args.shift();
    const name = args[0]?.split('/').at(-1);
    if (name === 'cd' && args.length === 2) cwd = resolve(cwd, args[1]);
    const currentFixture = { ...fixture, cwd };
    if (['bash', 'zsh', 'sh'].includes(name) && ['-c', '-lc'].includes(args[1])) {
      if (typeof args[2] !== 'string') continue;
      const violation = commandViolation(args[2], currentFixture);
      if (violation) return violation;
    }
    const syntaxCheck = name === 'node' && ['--check', '-c'].includes(args[1]);
    const entrypoints = ['node', 'bun', 'deno', 'tsx', 'sh', 'bash', 'zsh', 'npx', 'pnpx', 'npm', 'pnpm', 'yarn'].includes(name)
      ? args.slice(1) : args.slice(0, 1);
    if (!syntaxCheck && entrypoints.some((path) => fixture.entrypoints.has(resolve(cwd, path)))) return 'test/build execution receipt';
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)
      && /^(?:test|build)(?:$|:)/.test(args[1] === 'run' ? args[2] : args[1])) return 'test/build execution receipt';
    const gitAction = name === 'git' ? args.slice(1).find((arg, index) => !arg.startsWith('-')
      && !['-C', '-c', '--git-dir', '--work-tree'].includes(args[index])) : undefined;
    if (['apply_patch', 'patch', 'tee', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'truncate', 'chmod', 'chown'].includes(name)
      || (name === 'sed' && args.slice(1).some((arg) => /^-\w*i|^--in-place(?:=|$)/.test(arg)))
      || (name === 'perl' && args.slice(1).some((arg) => /^-\w*i/.test(arg)))
      || /^(?:commit|checkout|switch|apply|add|rm|mv|reset|restore|clean|merge|rebase|cherry-pick)$/.test(gitAction)) return 'write attempt';
  }
  return undefined;
}

export function auditAdjudicator({ raw, events, cli, cwd, before, after, error }) {
  const violations = [];
  if (error) violations.push(`execution failed: ${error}`);
  let tools = [];
  try {
    const observation = parsePhaseEvents(raw, cli, false);
    tools = observation.tools;
    const recorded = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    if (JSON.stringify(recorded) !== JSON.stringify(events)) violations.push('missing event receipts');
    // Generic Codex calls can put the tool name beside arguments, which the event parser extracts separately.
    const names = cli === 'codex'
      ? recorded.flatMap(({ item }) => [item?.type, item?.name, item?.tool_name, item?.tool])
      : tools.map((tool) => tool.name);
    for (const name of new Set(names)) {
      if (typeof name === 'string' && editingTools.has(name.split('.').at(-1))) {
        violations.push(`editing tool attempt: ${name}`);
      }
    }
  } catch (failure) {
    violations.push(`invalid event stream: ${failure.message}`);
  }
  let entrypoints;
  try { entrypoints = fixtureExecutionEntrypoints(cwd); }
  catch (failure) {
    violations.push(`fixture entrypoints unavailable: ${failure.message}`);
    entrypoints = new Set();
  }
  const fixture = { cwd, entrypoints };
  for (const tool of tools) {
    if (/^(?:# )?ADJUDICATOR_EXECUTION:\{"script":"(?:test|build)"\}\r?$/m.test(tool.output)) {
      violations.push('test/build execution process record');
    }
    if (!['Bash', 'command_execution'].includes(tool.name)) continue;
    const command = typeof tool.input === 'string' ? tool.input : tool.input?.command;
    if (typeof command !== 'string' || !command.trim()) {
      violations.push('missing command receipt');
      continue;
    }
    const violation = commandViolation(command, fixture);
    if (violation) violations.push(`${violation}: ${command}`);
  }
  if (existsSync(join(cwd, 'execution-marker.jsonl'))) violations.push('test/build execution marker created');
  if (JSON.stringify(before) !== JSON.stringify(after)) violations.push('workspace files changed');
  return { pass: violations.length === 0, violations, tools };
}
