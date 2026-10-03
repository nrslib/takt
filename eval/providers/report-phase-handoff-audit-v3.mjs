import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class ExecutionAuditError extends Error {}

export function assertFreshExecution(trace, phase) {
  if (trace?.startedFresh !== true) throw new ExecutionAuditError(phase + ' must be a fresh session');
}

export const fixedNpmSettings = Object.freeze({ npm_config_script_shell: '/bin/sh', npm_config_ignore_scripts: 'false' });

export function npmExecutionPolicy(cwd, parentEnvironment = process.env) {
  const environment = Object.fromEntries(Object.entries(parentEnvironment)
    .filter(([key, value]) => value !== undefined && !/^npm_config_(script_shell|ignore_scripts)$/i.test(key)));
  Object.assign(environment, fixedNpmSettings);
  try {
    const effectiveScriptShell = execFileSync('npm', ['config', 'get', 'script-shell'], { cwd, env: environment, encoding: 'utf8' }).trim();
    const ignoreScripts = execFileSync('npm', ['config', 'get', 'ignore-scripts'], { cwd, env: environment, encoding: 'utf8' }).trim();
    if (effectiveScriptShell !== fixedNpmSettings.npm_config_script_shell || ignoreScripts !== 'false') {
      throw new Error('npm execution settings did not match fixed policy');
    }
    return { environment, shellEnvironmentPolicy: { set: fixedNpmSettings, include_only: [] },
      metadata: { configuredScriptShell: '/bin/sh', effectiveScriptShell, ignoreScripts: false,
        toolEnvironmentDelivery: 'SDK env plus shell_environment_policy.set; actual model tool execution not observed by this preflight' } };
  } catch (cause) { throw new ExecutionAuditError('Unable to establish effective npm execution settings', { cause }); }
}

export function auditV3Items(items) {
  if (items.some(item => item.type === 'error')) throw new ExecutionAuditError('Executed SDK error item');
  const tools = items.filter(item => !['agent_message', 'reasoning', 'todo_list'].includes(item.type));
  return { toolCount: tools.length, toolTypes: tools.map(item => item.type) };
}

// This audits SDK receipts; it never executes the parsed shell text.
export function shellTokens(text) {
  const tokens = [];
  let word = '', quote = null, started = false;
  const flush = () => { if (started) tokens.push(word); word = ''; started = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (c === '\\') {
      if (i + 1 === text.length) throw new ExecutionAuditError('Unterminated shell escape');
      word += text[++i]; started = true; continue;
    }
    if (quote === '"') { if (c === '"') quote = null; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\n') { flush(); tokens.push(';'); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if (';&|<>'.includes(c)) {
      flush();
      if (text[i + 1] === c && '&|>'.includes(c)) tokens.push(c + text[++i]);
      else tokens.push(c);
      continue;
    }
    word += c; started = true;
  }
  if (quote !== null) throw new ExecutionAuditError('Unterminated shell quote');
  flush();
  return tokens;
}

export function parseReceiptCommand(command) {
  let tokens = shellTokens(command);
  if (/^(?:\/bin\/)?(?:ba|z)?sh$/.test(tokens[0]) && /^-[a-z]*c[a-z]*$/.test(tokens[1])) {
    if (tokens.length !== 3) throw new ExecutionAuditError('Unsupported shell invocation');
    tokens = shellTokens(tokens[2]);
  }
  const segments = [];
  let words = [];
  for (const token of tokens) {
    if ([';', '&&', '|', '||', '&', '<', '>', '>>'].includes(token)) {
      segments.push({ words, following: token }); words = [];
    } else words.push(token);
  }
  segments.push({ words, following: null });
  return segments;
}

function npmOperation(words) {
  if (words[0]?.endsWith('/npm')) throw new ExecutionAuditError('Unsupported absolute npm executable');
  if (words[0] !== 'npm') return null;
  const args = words.slice(1);
  if (JSON.stringify(args) === JSON.stringify(['run', 'build'])) return 'build';
  if (JSON.stringify(args) === JSON.stringify(['test']) || JSON.stringify(args) === JSON.stringify(['run', 'test'])) return 'test';
  throw new ExecutionAuditError('Unsupported actual npm invocation: ' + words.join(' '));
}

function assertNpmOutputOrigin(segments, command) {
  if (/[$`]/.test(command) || segments.some(segment => ![null, '&&'].includes(segment.following))) {
    throw new ExecutionAuditError('npm output has unsupported shell composition');
  }
  const operations = segments.map(({ words }) => npmOperation(words));
  if (operations.some(operation => operation === null)
    || (operations.length !== 1 && JSON.stringify(operations) !== JSON.stringify(['build', 'test']))) {
    throw new ExecutionAuditError('npm evidence requires a direct command or only build && test');
  }
}

function expectedFiles(workspace) {
  return ['src/session-label.js', 'tests/session-label.test.js'].map(path => ({
    path, content: readFileSync(join(workspace, path), 'utf8'),
  }));
}

function observedTestResults(output) {
  const observations = [];
  for (const line of output.split(/\r?\n/)) {
    const json = line.replace(/^#\s*/, '').trim();
    if (!json.startsWith('{')) continue;
    try { observations.push(JSON.parse(json)); } catch { /* Unrelated non-JSON log line. */ }
  }
  return /(?:\bpass\s+2\b)/.test(output) && /(?:\bfail\s+0\b)/.test(output)
    && observations.some(row => row.test === 'surrounding whitespace' && row.input === '  Ready Now  ' && row.actual === 'Ready Now')
    && observations.some(row => row.test === 'case and internal whitespace' && row.input === 'Ready  Now' && row.actual === 'Ready  Now');
}

// Saved supplementary symbol searches never establish fixture-body inspection.
const supplementalSearches = new Set([
  JSON.stringify(["rg","-n","normalizeSessionLabel|session-label",".","--glob","!.takt/**"]),
  JSON.stringify(["rg","-n","normalizeSessionLabel|session-label",".","--glob","!node_modules/**","--glob","!.takt/**"]),
  JSON.stringify(["rg","-n","normalizeSessionLabel|session-label|trim\\(",".","--glob","!package-lock.json","--glob","!node_modules/**","--glob","!.takt/**"]),
  JSON.stringify(["rg","-n","normalizeSessionLabel|session-label|vi\\.mock|jest\\.mock|mock\\.module|spy|stub|fake",".","--glob","!node_modules/**","--glob","!.takt/**"]),
  JSON.stringify(["rg","-n","normalizeSessionLabel|session-label",".","--glob","!.takt/**","--glob","!node_modules/**"]),
]);

function readOperation(words) {
  const [command, ...args] = words;
  let paths = args, firstLine = 1, lastLine = Infinity;
  if (command === 'cat') {
    while (['-n', '-b', '--'].includes(paths[0])) paths = paths.slice(1);
  } else if (command === 'nl') {
    if (paths[0] === '-ba') paths = paths.slice(1);
  } else if (command === 'sed') {
    if (args[0] !== '-n' || !/^\d+(?:,\d+)?p$/.test(args[1])) throw new ExecutionAuditError('Unsupported sed read script');
    const range = args[1].slice(0, -1).split(',').map(Number);
    [firstLine, lastLine] = [range[0], range[1] ?? range[0]];
    paths = args.slice(2);
  } else if (command === 'head') {
    lastLine = 10;
    if (args[0] === '-n') {
      if (!/^\d+$/.test(args[1])) throw new ExecutionAuditError('Unsupported head read range');
      lastLine = Number(args[1]); paths = args.slice(2);
    }
  } else if (command === 'rg') {
    if (supplementalSearches.has(JSON.stringify(words))) return { paths: [], inputPaths: [], firstLine, lastLine };
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (['-n', '--line-number', '--no-heading', '--files', '--hidden'].includes(args[i])) continue;
      if (['-g', '--glob'].includes(args[i])) {
        if (!args.includes('--files') || args[i + 1] === undefined) throw new ExecutionAuditError('Unsupported rg glob body filtering');
        i++; continue;
      }
      if (args[i].startsWith('-')) throw new ExecutionAuditError('Unsupported rg output option');
      positional.push(args[i]);
    }
    const inputPaths = args.includes('--files') ? positional : positional.slice(1);
    if (args.includes('--files') || ['^import', '^export'].includes(positional[0])) return { paths: [], inputPaths, firstLine, lastLine };
    if (!['', '^', '.*'].includes(positional[0])) {
      if (positional.slice(1).some(path => /(?:^|\/)(?:session-label\.js|session-label\.test\.js)$/.test(path))) {
        throw new ExecutionAuditError('Unsupported regex for target file inspection');
      }
      return { paths: [], inputPaths, firstLine, lastLine };
    }
    paths = positional.slice(1);
  } else return null;
  if (paths.length === 0 || paths.some(path => path.startsWith('-'))) throw new ExecutionAuditError('Unsupported reader arguments');
  return { paths, firstLine, lastLine };
}

function isMetadataObservation(words) {
  const known = [['pwd'], ['git', 'status', '--short'], ['sort'], ['ls', '-la'],
    ['find', '.takt/runs/eval/reports', '-maxdepth', '1', '-type', 'f', '-print'], ['find', '..', '-name', 'AGENTS.md', '-print']];
  if (known.some(command => JSON.stringify(words) === JSON.stringify(command))) return true;
  let paths;
  if (words[0] === 'wc' && words[1] === '-l') paths = words.slice(2);
  if (words[0] === 'shasum') paths = words[1] === '-a' && words[2] === '256' ? words.slice(3) : words.slice(1);
  return paths !== undefined && paths.length > 0 && paths.every(path => !path.startsWith('-'));
}

function assertReadOutputOrigin(segments, command) {
  if (/[$`]/.test(command) || segments.some(segment => ![null, ';', '&&'].includes(segment.following))) {
    throw new ExecutionAuditError('Read output cannot be attributed through shell expansion, redirection or pipelines');
  }
  for (const { words } of segments) {
    if (readOperation(words)) continue;
    if (words[0] === 'cd' && words.length === 2) continue;
    if (isMetadataObservation(words)) continue;
    throw new ExecutionAuditError('Read output includes an unsupported or output-synthesizing command');
  }
}

function assertSupportedEvidenceCommands(segments, command, bodyPresent, fixtureProbe) {
  if (fixtureProbe) return;
  if (segments.some(({ words }) => /(?:^|\/)node$/.test(words[0]))) {
    throw new ExecutionAuditError('Only the fixed supplemental Node probe is auditable');
  }
  for (const { words } of segments) {
    const read = readOperation(words);
    if (read !== null) {
      if ((read.inputPaths ?? read.paths).some(path => /[?*\[\]{}()~$`]/.test(path))) {
        throw new ExecutionAuditError('Reader uses an unsupported expanded path');
      }
      continue;
    }
    if (npmOperation(words) !== null) continue;
    if (words[0] === 'cd' && words.length === 2) continue;
    if (isMetadataObservation(words)) continue;
    // A literal filename/command mention supplies no execution or body evidence.
    if (words[0] === 'echo' && !bodyPresent && !/[$`]/.test(command)) continue;
    throw new ExecutionAuditError('Unsupported command in Phase 1 execution receipts');
  }
}

function verifiedReadLines(file, read, words, output) {
  const content = file.content.replace(/\r?\n$/, '').split(/\r?\n/);
  const first = read.firstLine;
  const last = Math.min(read.lastLine, content.length);
  if (first < 1 || first > last || output.length === 0) return [];
  const expected = content.slice(first - 1, last);
  const numbered = words[0] === 'nl' || (words[0] === 'cat' && words.some(word => ['-n', '-b'].includes(word)));
  const lines = output.split(/\r?\n/).map(line => {
    if (numbered) return line.trim() === '' ? '' : line.replace(/^\s*\d+\t/, '');
    if (words[0] !== 'rg') return line;
    for (const path of read.paths) if (line.startsWith(path + ':')) { line = line.slice(path.length + 1); break; }
    return words.some(word => ['-n', '--line-number'].includes(word)) ? line.replace(/^\d+:/, '') : line;
  });
  const matches = lines.some((_, index) => expected.every((line, offset) => lines[index + offset] === line));
  return matches ? expected.map((_, index) => first + index) : [];
}

const supplementalProbe = "import assert from \"node:assert/strict\"; import { normalizeSessionLabel } from \"./src/session-label.js\"; const input = \"\\t  Ready  Now \\n\"; const actual = normalizeSessionLabel(input); assert.equal(actual, \"Ready  Now\"); process.stdout.write(JSON.stringify({ input, actual }) + \"\\n\");";

export function inspectPhase1Receipts(trace, workspace) {
  assert.ok(Array.isArray(trace.commands), 'Phase 1 command receipts missing');
  const files = expectedFiles(workspace);
  const successful = { build: [], test: [], reads: [] };
  const coverage = new Map(files.map(file => [file.path, { lines: new Set(), receipts: new Set() }]));
  for (const receipt of trace.commands) {
    const segments = parseReceiptCommand(receipt.command);
    if (segments.some(({ words }) => words[0] === 'npm')) assertNpmOutputOrigin(segments, receipt.command);
    if (/\b(?:export|unset)\b.*npm_config_/i.test(receipt.command)) throw new ExecutionAuditError('npm execution environment was modified');
    const bodyPresent = files.some(file => file.content.trimEnd().split('\n').filter(line => line.trim()).every(line => receipt.output.includes(line.trim())));
    // Only the saved pure function probe is supported; it is not source-body evidence.
    const fixtureProbe = segments.length === 1 && /(?:^|\/)node$/.test(segments[0].words[0])
      && segments[0].words.length === 4 && segments[0].words[1] === '--input-type=module'
      && segments[0].words[2] === '-e' && segments[0].words[3] === supplementalProbe && !bodyPresent;
    assertSupportedEvidenceCommands(segments, receipt.command, bodyPresent, fixtureProbe);
    const hasTargetRead = segments.some(({ words }) => ['cat', 'sed', 'nl', 'head', 'rg'].includes(words[0])
      && words.some(word => /(?:^|\/)(?:session-label\.js|session-label\.test\.js)$/.test(word)));
    const hasBodyRead = bodyPresent && segments.some(({ words }) => ['cat', 'sed', 'nl', 'head', 'rg'].includes(words[0]));
    if (hasTargetRead || hasBodyRead) assertReadOutputOrigin(segments, receipt.command);
    let commandCwd = workspace;
    for (let i = 0; i < segments.length; i++) {
      const { words } = segments[i];
      if (words[0] === 'npm' && /[$`]/.test(receipt.command)) throw new ExecutionAuditError('Unsupported shell expansion in npm receipt');
      if (words[0] === 'cd') {
        if (words.length !== 2 || segments[i].following !== '&&' || /[?*\[\]{}()~$`]/.test(words[1])) {
          throw new ExecutionAuditError('Unsupported cd path or composition before evidence commands');
        }
        commandCwd = resolve(commandCwd, words[1]);
        continue;
      }
      const operation = npmOperation(words);
      if (operation !== null) {
        if (commandCwd !== workspace) throw new ExecutionAuditError('npm receipt uses a different fixture cwd');
        const predecessors = segments.slice(0, i);
        const successors = segments.slice(i);
        if (successors.some(segment => ![null, '&&'].includes(segment.following))) throw new ExecutionAuditError('npm exit cannot be established through this shell composition');
        if (predecessors.some(segment => ![';', '&&'].includes(segment.following))) throw new ExecutionAuditError('Unsupported shell composition before npm');
        if (receipt.exitCode === 0 && receipt.status === 'completed') {
          const banner = operation === 'build' ? /> build\s*\n> node --check src\/session-label\.js/.test(receipt.output)
            : /> test\s*\n> node --test tests\/session-label\.test\.js/.test(receipt.output);
          if (!banner || (operation === 'test' && !observedTestResults(receipt.output))) {
            throw new ExecutionAuditError('Successful npm ' + operation + ' lacks the fixed fixture execution output');
          }
          successful[operation].push(receipt);
        }
      }
      const read = readOperation(words);
      if (read === null) continue;
      if (read.paths.some(path => statSync(resolve(commandCwd, path), { throwIfNoEntry: false })?.isDirectory())) {
        throw new ExecutionAuditError('Directory body inspection cannot be attributed to individual fixture files');
      }
      if (receipt.exitCode !== 0 || receipt.status !== 'completed') continue;
      for (const file of files) {
        if (!read.paths.some(path => resolve(commandCwd, path) === join(workspace, file.path))) continue;
        const lines = verifiedReadLines(file, read, words, receipt.output);
        if (lines.length === 0) continue;
        const covered = coverage.get(file.path);
        for (const line of lines) covered.lines.add(line);
        covered.receipts.add(receipt);
      }
    }
  }
  for (const file of files) {
    const covered = coverage.get(file.path);
    if (covered.lines.size !== file.content.replace(/\r?\n$/, '').split(/\r?\n/).length) continue;
    for (const receipt of covered.receipts) successful.reads.push({ path: file.path, receipt });
  }
  return successful;
}

export function scoreExecutionBoundaryV3(sample, targetTrace, phase1Trace, workspace) {
  assertFreshExecution(targetTrace, 'Phase 2');
  const failures = [];
  if (targetTrace?.toolCount !== 0) failures.push('Phase 2 used tools');
  let receipts;
  if (sample.kind === 'live-phase1-chain') {
    assertFreshExecution(phase1Trace, 'Phase 1');
    receipts = inspectPhase1Receipts(phase1Trace, workspace);
    for (const operation of ['build', 'test']) {
      if (receipts[operation].length === 0) failures.push('Missing successful actual npm ' + operation + ' receipt with fixture result');
    }
    for (const path of ['src/session-label.js', 'tests/session-label.test.js']) {
      if (!receipts.reads.some(row => row.path === path)) failures.push('Missing actual file-body inspection: ' + path);
    }
  }
  const successReason = receipts ? 'Fresh tool-free Phase 2; actual fixture receipts verified'
    : 'Fresh tool-free Phase 2; synthetic handoff, no actual Phase 1 receipt verification';
  return { pass: failures.length === 0, score: failures.length === 0 ? 1 : 0, reason: failures.join('; ') || successReason,
    ...(receipts ? { verifiedReceipts: [...new Set([...receipts.build, ...receipts.test, ...receipts.reads.map(row => row.receipt)])] } : {}) };
}

export function assertNeutralTarget(prompt, workspace) {
  if (!workspace.startsWith('/private/tmp/')) throw new Error('Target cwd must be an external neutral workspace');
  if (/(?:\/(?:before|candidate|red|green)\/|\b[0-9a-f]{40}\b)/i.test(prompt + '\n' + workspace)) throw new Error('Comparison label or revision exposed to target');
}

export function assertToolFreeGrader(trace) {
  assertFreshExecution(trace, 'Grader');
  if (trace.toolCount !== 0) throw new ExecutionAuditError('Grader must be a tool-free session');
}

export function gradingReference(sample, captured, phase1, fixtureFiles) {
  return {
    boundary: 'Grader-only data. Do not fill missing Phase 1 or Phase 2 evidence from reference. No tools are permitted.',
    task: sample.task,
    ...(sample.upstream === undefined ? {} : { actualUpstreamPlanningRecord: sample.upstream }),
    ordinaryAdditionalUserInputs: sample.userInputs ?? [],
    actuallyDispatchedLiveInstructions: captured.liveInstructions,
    ...(sample.reportContent === undefined ? {} : { actualPlanningReport: { path: sample.reportName, content: sample.reportContent,
      contentWithLines: sample.reportContent.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n') } }),
    ...(phase1 === undefined ? { syntheticPhase1Handoff: {
      origin: 'Evaluation-authored work-result summary, not an actual model Phase 1 response', content: sample.workResult,
    } } : { actualPhase1FinalResponse: phase1.output, immutableFixtureFiles: fixtureFiles, executedCommandReceipts: phase1.verifiedReceipts }),
  };
}
