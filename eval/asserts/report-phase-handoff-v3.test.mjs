import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate } from 'promptfoo';
import { Codex } from '@openai/codex-sdk';
import { buildReadOnlyModelOptions, digest } from '../providers/report-phase-handoff-model.mjs';
import { assertExecutionDependencies, captureExecutionDependencies, DependencyAuditError } from '../providers/report-phase-handoff-dependencies-v3.mjs';
import { assertNeutralTarget, assertToolFreeGrader, ExecutionAuditError, gradingReference, inspectPhase1Receipts, npmExecutionPolicy, parseReceiptCommand, scoreExecutionBoundaryV3 } from '../providers/report-phase-handoff-audit-v3.mjs';
import { buildGraderPrompt, captureV3, evaluateV3, frozenSamples, resetWorkspace, runV3Model, validateV3Cases } from '../scripts/report-phase-handoff-v3.mjs';
import { fixtureFiles } from '../scripts/report-phase-handoff-eval.mjs';

const cases = JSON.parse(readFileSync(new URL('../cases/report-phase-handoff-v3.json', import.meta.url)));
const fresh = { startedFresh: true, toolCount: 0 };
const neutral = '/private/tmp/report-handoff-contract';
const fixture = 'eval/fixtures/report-phase-handoff';
const source = readFileSync(join(fixture, 'src/session-label.js'), 'utf8');
const tests = readFileSync(join(fixture, 'tests/session-label.test.js'), 'utf8');
const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
const buildOutput = execFileSync('npm', ['run', 'build'], { cwd: fixture, env: environment, encoding: 'utf8' });
const testOutput = execFileSync('npm', ['test'], { cwd: fixture, env: environment, encoding: 'utf8' });
const receipt = (command, output, exitCode = 0) => ({ command, output, exitCode, status: 'completed' });
const commands = [receipt("/bin/zsh -lc 'cat src/session-label.js tests/session-label.test.js'", source + tests),
  receipt("/bin/zsh -lc 'npm run build'", buildOutput), receipt("/bin/zsh -lc 'npm test'", testOutput)];

function withWorkspace(run) {
  const directory = mkdtempSync('/private/tmp/handoff-contract-');
  const workspace = join(directory, 'project');
  resetWorkspace(workspace);
  try { return run(workspace, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('v3 fixes same neutral cwd per paired sample with distinct repeat workspaces', () => {
  assert.equal(validateV3Cases(cases), cases);
  const samples = frozenSamples(cases, neutral);
  assert.equal(samples.length, 18);
  assert.equal(new Set(samples.map(row => row.workspace)).size, 18);
  assert.deepEqual(frozenSamples(cases, neutral), samples);
  assert.throws(() => validateV3Cases({ ...cases, maxConcurrency: 1 }));
  assert.throws(() => assertNeutralTarget('/private/tmp/x/before/fixture', neutral));
  assert.throws(() => assertNeutralTarget('/private/tmp/x/candidate/fixture', neutral));
  assert.throws(() => assertNeutralTarget('24b6990a4767602e8ec52fce7e1f6e56d0e4982a', neutral));
  assert.throws(() => assertNeutralTarget('', '/Users/nrs/work/git/takt/fixture'));
});

test('actual shell receipts recognize ordinary SDK zsh, cat, sed and build/test chaining', () => withWorkspace(workspace => {
  assert.deepEqual(parseReceiptCommand('/bin/zsh -lc "npm run build && npm test"'), [
    { words: ['npm', 'run', 'build'], following: '&&' }, { words: ['npm', 'test'], following: null }]);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands }, workspace).pass, true);
  const chained = [receipt("/bin/zsh -lc 'sed -n 1,50p src/session-label.js; sed -n 1,50p tests/session-label.test.js'", source + tests),
    receipt('/bin/zsh -lc "npm run build && npm test"', buildOutput + testOutput)];
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: chained }, workspace).pass, true);
}));

test('echo command spelling and rg filenames cannot establish execution or file-body inspection', () => withWorkspace(workspace => {
  const echoes = [receipt('echo "npm run build"', buildOutput), receipt('echo "npm test"', testOutput),
    receipt('rg --files src tests', 'src/session-label.js\ntests/session-label.test.js')];
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: echoes }, workspace).pass, false);
  const pathsOnly = commands.map(row => row.command.includes('cat') ? receipt(row.command, 'src/session-label.js tests/session-label.test.js') : row);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: pathsOnly }, workspace).pass, false);
}));

test('redirected reads and later synthetic output cannot establish file-body inspection', () => withWorkspace(workspace => {
  const forged = [
    'cat src/session-label.js tests/session-label.test.js > /dev/null; echo forged',
    'cat src/session-label.js tests/session-label.test.js; printf forged',
    "sed -n 'e echo forged' src/session-label.js tests/session-label.test.js",
    'cat src/session-label.js tests/session-label.test.js $(echo forged)',
    'cat src/session-label.js tests/session-label.test.js; rg --replace forged . src/session-label.js',
  ];
  for (const command of forged) {
    const trace = { commands: [receipt(command, source + tests)] };
    assert.throws(() => inspectPhase1Receipts(trace, workspace), ExecutionAuditError, command);
  }
}));

test('actual unknown partial reader is infrastructure without fixture names or full body output', () => withWorkspace((workspace, directory) => {
  const executable = join(directory, 'mystery-reader');
  writeFileSync(executable, '#!/bin/sh\nhead -n 1 src/session-label.js\n');
  chmodSync(executable, 0o755);
  const result = spawnSync('mystery-reader', [], { cwd: workspace, env: { ...environment, PATH: directory + ':' + environment.PATH }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, source.split('\n')[0] + '\n');
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt('mystery-reader', result.stdout, result.status)] }, workspace), ExecutionAuditError);
}));

test('ordinary partial reads lack complete evidence without becoming infrastructure failures', () => withWorkspace(workspace => {
  const output = execFileSync('/bin/zsh', ['-lc', "sed -n '2p' src/session-label.js; sed -n '2p' tests/session-label.test.js"],
    { cwd: workspace, env: environment, encoding: 'utf8' });
  const trace = { startedFresh: true, commands: [...commands.slice(1),
    receipt("sed -n '2p' src/session-label.js; sed -n '2p' tests/session-label.test.js", output)] };
  assert.equal(inspectPhase1Receipts(trace, workspace).reads.length, 0);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, trace, workspace).pass, false);
  writeFileSync(join(workspace, 'copied-evidence.txt'), source + tests);
  const script = "sed -n '2p' src/session-label.js; rg -n '^import' tests/session-label.test.js; cat copied-evidence.txt";
  const copied = execFileSync('/bin/zsh', ['-lc', script], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(inspectPhase1Receipts({ commands: [receipt(script, copied)] }, workspace).reads.length, 0);
}));

test('real glob file-body output is unauditable while explicit other files remain missing evidence', () => withWorkspace(workspace => {
  const command = 'cat src/*.js';
  const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(output, source);
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
  writeFileSync(join(workspace, 'copied-evidence.txt'), source);
  const copied = execFileSync('/bin/zsh', ['-lc', 'cat copied-evidence.txt'], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(inspectPhase1Receipts({ commands: [receipt('cat copied-evidence.txt', copied)] }, workspace).reads.length, 0);
}));

test('partial glob reads are infrastructure while explicit partial paths remain missing evidence', () => withWorkspace(workspace => {
  for (const command of ['head -n 1 src/*.js', "rg '^export' src/*.js"]) {
    const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
    assert.equal(output, source.split('\n')[0] + '\n');
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
  }
  const explicit = 'head -n 1 src/session-label.js';
  const partial = execFileSync('/bin/zsh', ['-lc', explicit], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(inspectPhase1Receipts({ commands: [receipt(explicit, partial)] }, workspace).reads.length, 0);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh,
    { startedFresh: true, commands: [...commands.slice(1), receipt(explicit, partial)] }, workspace).pass, false);
}));

test('actual rg glob options are infrastructure for full and partial output while ordinary rg remains classified', () => withWorkspace(workspace => {
  for (const option of ['-g', '--glob']) {
    for (const pattern of ['.*', '^export']) {
      const command = `rg -n '${pattern}' ${option} '*.js' src`;
      const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
      assert.ok(output.includes(source.split('\n')[0]));
      if (pattern === '.*') assert.ok(output.includes(source.split('\n')[1]));
      assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError, command);
    }
  }
  const names = "rg --files -g '*.js' src tests";
  const namesOutput = execFileSync('/bin/zsh', ['-lc', names], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.deepEqual(namesOutput.trim().split('\n').sort(), ['src/session-label.js', 'tests/session-label.test.js']);
  assert.equal(inspectPhase1Receipts({ commands: [receipt(names, namesOutput)] }, workspace).reads.length, 0);
  const supplemental = "rg -n 'normalizeSessionLabel|session-label' . --glob '!node_modules/**' --glob '!.takt/**'";
  const supplementalOutput = execFileSync('/bin/zsh', ['-lc', supplemental], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.ok(supplementalOutput.includes('normalizeSessionLabel'));
  const supplementalReceipt = receipt(supplemental, supplementalOutput);
  assert.equal(inspectPhase1Receipts({ commands: [supplementalReceipt] }, workspace).reads.length, 0);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh,
    { startedFresh: true, commands: [...commands, supplementalReceipt] }, workspace).pass, true);
  const full = "rg -n '.*' src/session-label.js";
  const fullOutput = execFileSync('/bin/zsh', ['-lc', full], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(inspectPhase1Receipts({ commands: [receipt(full, fullOutput)] }, workspace).reads.length, 1);
  const partial = "rg -n '^export' src/session-label.js";
  const partialOutput = execFileSync('/bin/zsh', ['-lc', partial], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(inspectPhase1Receipts({ commands: [receipt(partial, partialOutput)] }, workspace).reads.length, 0);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh,
    { startedFresh: true, commands: [...commands.slice(1), receipt(partial, partialOutput)] }, workspace).pass, false);
}));

test('actual directory body searches are infrastructure instead of missing file inspection', () => withWorkspace(workspace => {
  const command = "rg '.*' src";
  const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.ok(output.includes(source.split('\n')[0]));
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
}));

test('actual split file ranges aggregate only matching complete fixture line coverage', () => withWorkspace(workspace => {
  const partials = ["sed -n '1,2p' src/session-label.js", "sed -n '3,999p' src/session-label.js",
    "sed -n '1,10p' tests/session-label.test.js", "sed -n '11,999p' tests/session-label.test.js"]
    .map(command => receipt(command, execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' })));
  const trace = { startedFresh: true, commands: [...commands.slice(1), ...partials] };
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, trace, workspace).pass, true);
  const missing = { ...trace, commands: trace.commands.filter(row => row !== partials[1]) };
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, missing, workspace).pass, false);
  const mismatch = { ...trace, commands: trace.commands.map(row => row === partials[0] ? { ...row, output: 'invented evidence\n' } : row) };
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, mismatch, workspace).pass, false);
}));

test('actual cd glob expansion is infrastructure while literal subdirectory reads remain auditable', () => withWorkspace(workspace => {
  for (const command of ['cd src* && cat session-label.js', 'cd "$PWD/src" && cat session-label.js']) {
    const result = spawnSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, source);
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, result.stdout, result.status)] }, workspace), ExecutionAuditError, command);
  }
  // Parser-level coverage for expansion forms; these are not actual execution receipts.
  for (const path of ['~', 'src?', 'src[ab]', 'src{a,b}']) {
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(`cd ${path} && cat session-label.js`, '')] }, workspace), ExecutionAuditError);
  }
}));

test('actual reads from a fixture subdirectory resolve to the target file independently of npm cwd', () => withWorkspace(workspace => {
  const command = 'cd src && cat session-label.js';
  const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(output, source);
  assert.deepEqual(inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace).reads.map(row => row.path), ['src/session-label.js']);
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt('cd src && npm test', testOutput)] }, workspace), ExecutionAuditError);
}));

test('actual unparsed shell wrappers are infrastructure regardless of fixture names or output amount', () => withWorkspace(workspace => {
  for (const [script, expected] of [['cat src/*.js tests/*.js', source + tests],
    ['head -n 1 src/*.js', source.split('\n')[0] + '\n'], ['printf auxiliary', 'auxiliary']]) {
    const command = "/bin/bash -c '" + script + "' ignored";
    const output = execFileSync('/bin/bash', ['-c', script, 'ignored'], { cwd: workspace, env: environment, encoding: 'utf8' });
    assert.equal(output, expected);
    assert.throws(() => scoreExecutionBoundaryV3(cases.cases[2], fresh,
      { startedFresh: true, commands: [...commands.slice(1), receipt(command, output)] }, workspace), ExecutionAuditError);
  }
}));

test('real redirected cat plus printf body is rejected by the current audit without Git history', () => {
  const directory = mkdtempSync('/private/tmp/handoff-read-forgery-');
  const workspace = join(directory, 'project');
  resetWorkspace(workspace);
  try {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const script = 'cat src/session-label.js tests/session-label.test.js > /dev/null; printf %s ' + quote(source + tests);
    const output = execFileSync('/bin/zsh', ['-lc', script], { cwd: workspace, env: environment, encoding: 'utf8' });
    const trace = { commands: [receipt('/bin/zsh -lc ' + quote(script), output)] };
    assert.equal(output, source + tests);
    assert.throws(() => inspectPhase1Receipts(trace, workspace), ExecutionAuditError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('saved real verification receipts keep their hashes and accepted file reads across all three v3 stages', () => withWorkspace(workspace => {
  let checked = 0;
  for (const stage of ['red', 'green-first', 'green-final']) {
    const summary = JSON.parse(readFileSync(new URL('../results/report-phase-handoff-v3/' + stage + '-summary.json', import.meta.url)));
    for (const row of summary.rows.filter(row => row.phase1)) {
      const verification = row.phase1.selectedVerification;
      assert.equal(verification.originalTraceHash, row.phase1.actualTraceHash);
      const commands = verification.receipts.map(entry => {
        assert.equal(digest(JSON.stringify(entry.receipt)), entry.receiptHash);
        return entry.receipt;
      });
      const inspected = inspectPhase1Receipts({ commands }, workspace);
      assert.deepEqual([...new Set(inspected.reads.map(read => read.path))].sort(), ['src/session-label.js', 'tests/session-label.test.js']);
      checked++;
    }
  }
  assert.equal(checked, 18);
}));

test('real bare npm success without fixture output is infrastructure while actual test failure is semantic', () => withWorkspace(workspace => {
  const packagePath = join(workspace, 'package.json');
  const metadata = JSON.parse(readFileSync(packagePath));
  for (const operation of ['build', 'test']) metadata.scripts[operation] += ` && node -e "require('node:fs').writeFileSync('${operation}-executed', 'yes')"`;
  writeFileSync(packagePath, JSON.stringify(metadata));
  const bypass = existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  for (const args of [['run', 'build'], ['test']]) {
    const result = spawnSync('npm', args, { cwd: workspace, env: { ...environment,
      npm_config_script_shell: bypass, npm_config_loglevel: 'silent' }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(workspace, `${args.at(-1)}-executed`)), false);
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt('npm ' + args.join(' '), result.stdout, result.status)] }, workspace), ExecutionAuditError);
  }
  writeFileSync(join(workspace, 'src/session-label.js'), source.replace('label.trim()', 'label'));
  const failed = spawnSync('npm', ['test'], { cwd: workspace, env: { ...environment,
    npm_config_script_shell: '/bin/sh', npm_config_ignore_scripts: 'false' }, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  const trace = { startedFresh: true, commands: [receipt('npm test', failed.stdout, failed.status)] };
  assert.equal(inspectPhase1Receipts(trace, workspace).test.length, 0);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, trace, workspace).pass, false);
}));

test('real Node builtin partial reader cannot masquerade as the supplemental pure probe', () => withWorkspace(workspace => {
  const script = 'import assert from "node:assert/strict"; const fs = process.getBuiltinModule("fs"); const fd = fs.openSync("src/session-label.js", "r"); const buffer = Buffer.alloc(20); fs.readSync(fd, buffer, 0, 20, 0); const normalizeSessionLabel = value => value; assert.equal(normalizeSessionLabel(1), 1); process.stdout.write(JSON.stringify({ chunk: buffer.toString() }) + "\\n");';
  const output = execFileSync('node', ['--input-type=module', '-e', script], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(JSON.parse(output).chunk, source.slice(0, 20));
  const command = `node --input-type=module -e '${script}'`;
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
}));

test('saved pure Node probe remains supplementary and supplies no file inspection', () => withWorkspace(workspace => {
  const script = "import assert from \"node:assert/strict\"; import { normalizeSessionLabel } from \"./src/session-label.js\"; const input = \"\\t  Ready  Now \\n\"; const actual = normalizeSessionLabel(input); assert.equal(actual, \"Ready  Now\"); process.stdout.write(JSON.stringify({ input, actual }) + \"\\n\");";
  const output = execFileSync('node', ['--input-type=module', '-e', script], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(JSON.parse(output).actual, 'Ready  Now');
  const command = `node --input-type=module -e '${script}'`;
  assert.equal(inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace).reads.length, 0);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: [...commands, receipt(command, output)] }, workspace).pass, true);
}));

test('observations must come from successful actual fixture npm test receipt', () => withWorkspace(workspace => {
  const elsewhere = commands.map(row => row.command.includes('npm test') ? receipt(row.command, '> test\n> node --test tests/session-label.test.js\npass 2\nfail 0') : row);
  elsewhere.push(receipt('echo observations', testOutput));
  assert.throws(() => scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: elsewhere }, workspace), ExecutionAuditError);
  const failed = commands.map(row => row.command.includes('npm test') ? { ...row, exitCode: 1 } : row);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: failed }, workspace).pass, false);
  const wrongObservation = commands.map(row => row.command.includes('npm test') ? { ...row, output: row.output.replace('"actual":"Ready Now"', '"actual":"WRONG"') } : row);
  assert.throws(() => scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: wrongObservation }, workspace), ExecutionAuditError);
}));

test('unsupported actual npm compositions are audit errors, not model failure results', () => withWorkspace(workspace => {
  for (const command of ['env npm test', `npm --prefix ${workspace} test`, 'npm test; echo passed', 'npm test | cat']) {
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, testOutput)] }, workspace), ExecutionAuditError);
  }
}));

test('real npm script-shell bypass plus printf cannot establish successful test execution', () => withWorkspace(workspace => {
  const packagePath = join(workspace, 'package.json');
  const metadata = JSON.parse(readFileSync(packagePath));
  metadata.scripts.test += ' && node -e "require(\'node:fs\').writeFileSync(\'test-executed\', \'yes\')"';
  writeFileSync(packagePath, JSON.stringify(metadata));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const bypassShell = ['/usr/bin/true', '/bin/true'].find(existsSync);
  assert.ok(bypassShell);
  const script = 'export npm_config_script_shell=' + bypassShell + ' && npm test && printf %s ' + quote(testOutput);
  const output = execFileSync('/bin/zsh', ['-lc', script], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(existsSync(join(workspace, 'test-executed')), false);
  assert.ok(output.includes('"actual":"Ready Now"'));
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt('/bin/zsh -lc ' + quote(script), output)] }, workspace), ExecutionAuditError);
}));

test('actual unsupported awk whole-file inspection is infrastructure rather than missing evidence', () => withWorkspace(workspace => {
  const command = "awk '{print}' src/session-label.js";
  const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(output, source);
  assert.throws(() => scoreExecutionBoundaryV3(cases.cases[2], fresh,
    { startedFresh: true, commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
}));

test('unrecognized file and npm command forms are infrastructure rather than missing evidence', () => withWorkspace(workspace => {
  for (const command of ['dd if=src/session-label.js', 'nice npm test']) {
    const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (command.startsWith('dd')) assert.equal(output, source);
    else assert.ok(output.includes('node --test tests/session-label.test.js'));
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError, command);
  }
  for (const [command, output] of [['unrecognized-wrapper npm test', testOutput], ['unrecognized-reader', source]]) {
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError, command);
  }
  for (const command of ['wc -l src/session-label.js', 'shasum -a 256 src/session-label.js']) {
    const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
    assert.equal(inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace).reads.length, 0);
  }
}));

test('unsupported language readers and regexes are audit errors while filename mentions are missing evidence', () => withWorkspace(workspace => {
  for (const command of ['python3 -c "print(open(\'src/session-label.js\').read())"',
    'perl -0777 -ne print src/session-label.js', "rg '(?P<line>.*)' src/session-label.js", 'rg --json . src/session-label.js']) {
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, source)] }, workspace), ExecutionAuditError);
  }
  const command = "node -e \"process.stdout.write(require('node:fs').readFileSync('src/session-label.js', 'utf8'))\"";
  const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.equal(output, source);
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
  assert.equal(inspectPhase1Receipts({ commands: [receipt('echo src/session-label.js', 'src/session-label.js'),
    receipt('rg --files src/session-label.js', 'src/session-label.js')] }, workspace).reads.length, 0);
}));

test('actual unknown cat output options are infrastructure rather than missing body evidence', () => withWorkspace(workspace => {
  const command = 'cat -e src/session-label.js';
  const output = execFileSync('/bin/zsh', ['-lc', command], { cwd: workspace, env: environment, encoding: 'utf8' });
  assert.ok(output.includes('$\n'));
  assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, output)] }, workspace), ExecutionAuditError);
}));

test('isolated synthetic handoffs never claim actual Phase 1 fixture receipt verification', () => {
  for (const sample of cases.cases.slice(0, 2)) {
    const result = scoreExecutionBoundaryV3(sample, fresh);
    assert.equal(result.pass, true);
    assert.equal('verifiedReceipts' in result, false);
    assert.match(result.reason, /synthetic handoff/i);
    assert.doesNotMatch(result.reason, /actual fixture receipts verified/i);
  }
});

test('opt-in npm policy overrides ambient settings without mutating global environment or legacy SDK options', () => withWorkspace(workspace => {
  const before = process.env.npm_config_script_shell;
  const parent = { ...environment, npm_config_script_shell: '/usr/bin/true', NPM_CONFIG_SCRIPT_SHELL: '/usr/bin/true', NPM_CONFIG_IGNORE_SCRIPTS: 'true' };
  const policy = npmExecutionPolicy(workspace, parent);
  assert.equal(policy.metadata.effectiveScriptShell, '/bin/sh');
  assert.equal(policy.metadata.ignoreScripts, false);
  assert.equal(policy.environment.NPM_CONFIG_SCRIPT_SHELL, undefined);
  assert.equal(parent.npm_config_script_shell, '/usr/bin/true');
  assert.equal(process.env.npm_config_script_shell, before);
  const legacy = buildReadOnlyModelOptions({ cwd: workspace });
  assert.equal('env' in legacy, false);
  assert.equal('shell_environment_policy' in legacy.config, false);
}));

test('installed SDK delivers opt-in npm environment and tool policy to a local CLI probe without a model call', async () => {
  const directory = mkdtempSync('/private/tmp/handoff-sdk-environment-');
  try {
    const executable = join(directory, 'local-cli-probe.cjs');
    writeFileSync(executable, `#!${process.execPath}\nconst { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const data = { scriptShell: process.env.npm_config_script_shell, ignoreScripts: process.env.npm_config_ignore_scripts,
  effective: execFileSync('npm', ['config', 'get', 'script-shell'], { encoding: 'utf8' }).trim(),
  scriptShellConfig: args.includes('shell_environment_policy.set.npm_config_script_shell="/bin/sh"'),
  ignoreScriptsConfig: args.includes('shell_environment_policy.set.npm_config_ignore_scripts="false"'),
  includeOnlyCleared: args.includes('shell_environment_policy.include_only=[]') };
process.stdin.resume(); process.stdin.on('end', () => {
  for (const event of [{ type: 'item.completed', item: { id: 'probe', type: 'agent_message', text: JSON.stringify(data) } },
    { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }]) console.log(JSON.stringify(event));
});\n`);
    chmodSync(executable, 0o700);
    const policy = npmExecutionPolicy(directory, { ...environment, NPM_CONFIG_SCRIPT_SHELL: '/usr/bin/true' });
    const options = buildReadOnlyModelOptions({ cwd: directory, executionEnvironment: policy.environment, shellEnvironmentPolicy: policy.shellEnvironmentPolicy });
    const turn = await new Codex({ ...options, codexPathOverride: executable }).startThread({ workingDirectory: directory, skipGitRepoCheck: true }).run('Local probe only');
    assert.deepEqual(JSON.parse(turn.finalResponse), { scriptShell: '/bin/sh', ignoreScripts: 'false', effective: '/bin/sh',
      scriptShellConfig: true, ignoreScriptsConfig: true, includeOnlyCleared: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('grader tool use cannot pass and target Phase 2 tool use fails boundary', () => {
  assertToolFreeGrader(fresh);
  assert.throws(() => assertToolFreeGrader({ ...fresh, toolCount: 1 }), ExecutionAuditError);
  assert.throws(() => assertToolFreeGrader({ ...fresh, startedFresh: false }), ExecutionAuditError);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[0], { ...fresh, toolCount: 1 }).pass, false);
});

test('missing or reused Phase 1 and Phase 2 sessions are execution audit errors', () => {
  for (const startedFresh of [false, undefined, 'true']) {
    assert.throws(() => scoreExecutionBoundaryV3(cases.cases[0], { ...fresh, startedFresh }), ExecutionAuditError);
    assert.throws(() => scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh }), ExecutionAuditError);
    assert.throws(() => assertToolFreeGrader({ ...fresh, startedFresh }), ExecutionAuditError);
  }
  assert.throws(() => scoreExecutionBoundaryV3(cases.cases[2], fresh), ExecutionAuditError);
});

test('actual v3 wrapper accepts TODO progress but rejects execution items and SDK errors', async () => {
  const directory = mkdtempSync('/private/tmp/handoff-items-');
  const artifactPrefix = join(directory, 'model');
  const mocked = items => async () => {
    writeFileSync(artifactPrefix + '.private-turn.json', JSON.stringify({ items }));
    return { output: 'Report', trace: { ...fresh, toolCount: 999 } };
  };
  const progress = [{ type: 'agent_message', text: 'Report' }, { type: 'reasoning' }, { type: 'todo_list', items: [{ text: 'Prepare report', completed: true }] }];
  try {
    const result = await runV3Model({ artifactPrefix }, mocked(progress));
    assertToolFreeGrader(result.trace);
    assert.equal(scoreExecutionBoundaryV3(cases.cases[0], result.trace).pass, true);
    assert.deepEqual(JSON.parse(readFileSync(artifactPrefix + '.trace.json')).toolTypes, []);
    for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search']) {
      const executed = await runV3Model({ artifactPrefix }, mocked([...progress, { type }]));
      assert.equal(scoreExecutionBoundaryV3(cases.cases[0], executed.trace).pass, false);
      assert.throws(() => assertToolFreeGrader(executed.trace), ExecutionAuditError);
      assert.deepEqual(executed.trace.toolTypes, [type]);
    }
    await assert.rejects(() => runV3Model({ artifactPrefix }, mocked([...progress, { type: 'error', message: 'SDK failure' }])), ExecutionAuditError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reused sessions from the actual model wrapper become infrastructure failures in promptfoo summaries', async () => {
  const directory = mkdtempSync('/private/tmp/handoff-fresh-infra-');
  const executionDependencies = captureExecutionDependencies(process.cwd());
  try {
    for (const invalidPhase of ['phase1', 'phase2', 'grader']) {
      const sample = invalidPhase === 'phase1' ? cases.cases[2] : cases.cases[0];
      const protocol = { ...cases, cases: [{ ...sample, rubrics: Object.fromEntries(Object.entries(sample.rubrics).slice(0, 1)) }] };
      const runDirectory = join(directory, invalidPhase);
      const workspace = join(directory, invalidPhase + '-workspace');
      resetWorkspace(workspace);
      const sampleId = 'en-' + sample.id + '-r1';
      const frozenDirectory = join(runDirectory, 'frozen', 'baseline', sampleId);
      const captured = captureV3({ revisionRoot: process.cwd(), workspace, sample, language: 'en',
        configDirectory: join(runDirectory, 'configs', 'baseline', sampleId), directory: frozenDirectory });
      for (const phase of ['phase1', 'phase2']) writeFileSync(join(frozenDirectory, phase + '.prompt.md'), captured[phase + 'Prompt']);
      const capture = { sampleId, captureHash: digest(readFileSync(join(frozenDirectory, 'runtime-capture.json'))),
        phase1PromptHash: digest(captured.phase1Prompt), phase2PromptHash: digest(captured.phase2Prompt) };
      const manifest = { protocol: 'fresh-contract', samples: [{ sampleId, language: 'en', caseId: sample.id, kind: sample.kind, workspace }],
        neutralRoot: join(runDirectory, 'neutral'), fixtureHash: digest(JSON.stringify(fixtureFiles(workspace))), executionDependencies,
        conditions: { maxConcurrency: 1, engineReset: 'Reset fixture per sample' },
        revisions: { baseline: { root: process.cwd(), commit: 'local-contract', captures: [capture] } } };
      const calls = [];
      const runModel = options => runV3Model(options, async () => {
        const phase = options.artifactPrefix.includes('/grader-') ? 'grader' : options.artifactPrefix.endsWith('/phase1') ? 'phase1' : 'phase2';
        calls.push(phase);
        const output = phase === 'grader' ? '{"pass":true,"score":1,"reason":"Mocked grader"}' : 'Mocked model report';
        writeFileSync(options.artifactPrefix + '.private-turn.json', JSON.stringify({ items: [{ type: 'agent_message', text: output }] }));
        return { output, trace: { ...fresh, startedFresh: phase !== invalidPhase, responseHash: digest(output) } };
      });
      const exitCode = await evaluateV3({ phase: 'red', directory: runDirectory, runModel,
        auditProtocol: () => ({ manifest, cases: protocol }) });
      const summary = JSON.parse(readFileSync(join(runDirectory, 'red/summary.json')));
      assert.equal(exitCode, 2);
      assert.equal(summary.infrastructureFailures, 1);
      assert.equal(summary.modelFailures, 0);
      assert.equal(summary.passed, 0);
      assert.equal(summary.rows[0].status, 'infrastructure_failure');
      assert.deepEqual(calls, invalidPhase === 'phase1' ? ['phase1'] : invalidPhase === 'phase2' ? ['phase2'] : ['phase2', 'grader']);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('execution dependency guard detects real lockfile, installed version and nested tree drift without installs', () => {
  const directory = mkdtempSync('/private/tmp/handoff-dependencies-');
  const packageDirectory = join(directory, 'node_modules', 'fixture-library');
  mkdirSync(packageDirectory, { recursive: true });
  const writePackage = value => writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(value));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'dependency-contract', version: '1.0.0', dependencies: { 'fixture-library': '*' } }));
  writeFileSync(join(directory, 'package-lock.json'), '{}');
  writeFileSync(join(packageDirectory, 'index.js'), 'export const value = 1;');
  writePackage({ name: 'fixture-library', version: '1.0.0', main: 'index.js' });
  try {
    const snapshot = captureExecutionDependencies(directory, ['fixture-library']);
    assertExecutionDependencies(snapshot, captureExecutionDependencies(directory, ['fixture-library']));
    assert.ok(!JSON.stringify(snapshot).includes(directory));
    writeFileSync(join(directory, 'package-lock.json'), '{"changed":true}');
    assert.throws(() => assertExecutionDependencies(snapshot, captureExecutionDependencies(directory, ['fixture-library'])), DependencyAuditError);
    writeFileSync(join(directory, 'package-lock.json'), '{}');
    writePackage({ name: 'fixture-library', version: '2.0.0', main: 'index.js' });
    const newer = captureExecutionDependencies(directory, ['fixture-library']);
    assert.equal(newer.resolvedRuntimePackages[0].version, '2.0.0');
    assert.throws(() => assertExecutionDependencies(snapshot, newer), DependencyAuditError);
    writePackage({ name: 'fixture-library', version: '1.0.0', main: 'index.js', dependencies: { 'nested-library': '*' } });
    const nested = join(packageDirectory, 'node_modules', 'nested-library');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'nested-library', version: '1.0.0' }));
    const nestedTree = captureExecutionDependencies(directory, ['fixture-library']);
    assert.equal(nestedTree.installedTree.dependencies['fixture-library'].dependencies['nested-library'].version, '1.0.0');
    assert.throws(() => assertExecutionDependencies(snapshot, nestedTree), DependencyAuditError);
    assert.throws(() => assertExecutionDependencies(snapshot, { ...snapshot, npm: 'different' }), DependencyAuditError);
    assert.throws(() => assertExecutionDependencies(undefined, snapshot), DependencyAuditError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('npm policy failure during both baseline preparation entrypoints exits as infrastructure before model calls', () => {
  const directory = mkdtempSync('/private/tmp/handoff-npm-preparation-');
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
  assert.ok(!realNpm.includes("'"));
  const executable = join(bin, 'npm');
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = config ]; then\n  case "$PWD" in */revisions/baseline) exit 7;; esac\nfi\nexec '${realNpm}' "$@"\n`);
  chmodSync(executable, 0o755);
  try {
    for (const name of ['report-phase-handoff-v3', 'report-feasibility']) {
      const output = join(directory, name);
      const neutralRoot = join(directory, name + '-neutral');
      const result = spawnSync(process.execPath, ['eval/scripts/' + name + '.mjs', 'freeze-baseline', 'HEAD', output, neutralRoot],
        { env: { ...environment, PATH: bin + ':' + environment.PATH }, encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      const failure = JSON.parse(result.stderr.trim().split('\n').at(-1));
      assert.equal(failure.status, 'infrastructure_failure');
      assert.equal(failure.phaseInvalid, true);
      assert.match(failure.reason, /Unable to establish effective npm execution settings/);
      assert.equal(existsSync(join(output, 'manifest.json')), false);
      assert.equal(existsSync(join(output, 'red')), false);
      assert.equal(existsSync(join(output, 'green')), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing dependency freeze exits as infrastructure before any SDK target call', () => {
  const directory = mkdtempSync('/private/tmp/handoff-dependency-cli-');
  const paths = ['scripts/report-phase-handoff-v3.mjs', 'scripts/report-phase-handoff-runtime-v3.mjs',
    'providers/report-phase-handoff-audit-v3.mjs', 'providers/report-phase-handoff-dependencies-v3.mjs',
    'providers/report-phase-handoff-model.mjs', 'scripts/report-phase-handoff-eval.mjs'];
  const bytes = readFileSync(new URL('../cases/report-phase-handoff-v3.json', import.meta.url));
  writeFileSync(join(directory, 'cases.frozen.json'), bytes);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    harnessHashes: paths.map(path => ({ path, sha256: digest(readFileSync(join('eval', path))) })),
    casesHash: digest(bytes), fixtureHash: digest(JSON.stringify(fixtureFiles())), neutralRoot: neutral,
    samples: frozenSamples(cases, neutral),
  }));
  try {
    const result = spawnSync(process.execPath, ['eval/scripts/report-phase-handoff-v3.mjs', 'red', directory], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /"status":"infrastructure_failure"/);
    assert.match(result.stderr, /"phaseInvalid":true/);
    assert.equal(existsSync(join(directory, 'red')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('B grader receives actual obligation text with precise real row/line sources', () => {
  const sample = cases.cases[1];
  const reference = gradingReference(sample, { liveInstructions: [] });
  assert.equal(reference.actualPlanningReport.content, sample.reportContent);
  assert.match(reference.actualPlanningReport.contentWithLines, /3: 1\. Preserve the existing version/);
  assert.match(reference.actualPlanningReport.contentWithLines, /4: 2\. Confirm a delivery record/);
  assert.match(reference.actualPlanningReport.contentWithLines, /5: 3\. Confirm that the existing timestamp/);
  assert.equal('actualPhase1FinalResponse' in reference, false);
  assert.equal(reference.syntheticPhase1Handoff.content, sample.workResult);
  assert.match(reference.syntheticPhase1Handoff.origin, /not an actual model Phase 1 response/);
  assert.match(sample.rubrics['unknown-implementation'], /unknown or unconfirmed/);
});

test('C grader reference keeps actual final response separate from receipts and fixture', () => {
  const sample = cases.cases[2];
  const reference = gradingReference(sample, { liveInstructions: [] }, { output: 'No implementation line retained', verifiedReceipts: commands }, [{ path: 'src/session-label.js', contentWithLines: '1: function' }]);
  assert.equal(reference.actualPhase1FinalResponse, 'No implementation line retained');
  assert.equal('syntheticPhase1Handoff' in reference, false);
  assert.equal(reference.executedCommandReceipts, commands);
  assert.match(reference.boundary, /Do not fill missing Phase 1 or Phase 2 evidence/);
  assert.match(sample.rubrics['observed-evidence'], /Phase 2 inventing evidence to repair a Phase 1 omission fails/);
  const output = 'Report missing implementation evidence';
  const rubric = sample.rubrics['observed-evidence'];
  const prompt = buildGraderPrompt('Grade the actual report', { vars: { output, rubric } },
    { caseId: sample.id, reference, phase2: { responseHash: digest(output) } }, cases);
  assert.ok(prompt.includes('"actualPhase1FinalResponse": "No implementation line retained"'));
  assert.ok(!prompt.includes('syntheticPhase1Handoff'));
});

test('promptfoo real grading boundary receives exact output, frozen rubric and actual B source context', async () => {
  const sample = cases.cases[1];
  const output = '# Report with deliberately wrong obligation';
  const reference = gradingReference(sample, { liveInstructions: [] });
  const observation = { caseId: sample.id, phase2: { responseHash: digest(output) }, reference };
  let called = 0;
  const grader = { id: () => 'v3-deterministic-grader', callApi: async (prompt, context) => {
    const composed = buildGraderPrompt(prompt, context, observation, cases);
    assert.ok(composed.includes(sample.reportContent.replaceAll('\n', '\\n')));
    assert.ok(composed.includes(sample.rubrics['idless-source']));
    assert.ok(composed.includes('"syntheticPhase1Handoff"'));
    assert.ok(composed.includes('not an actual model Phase 1 response'));
    assert.ok(composed.includes(sample.workResult.replaceAll('\n', '\\n')));
    assert.ok(!composed.includes('actualPhase1FinalResponse'));
    assert.equal(context.vars.output, output);
    called++;
    return { output: '{"pass": false, "score": 0, "reason": "Wrong obligation meaning"}' };
  } };
  const result = await evaluate({ prompts: ['{{sampleId}}'], providers: [{ id: () => 'v3-deterministic-target', callApi: async () => ({ output }) }],
    tests: [{ vars: { sampleId: 'en-rule-source-status-r1' }, assert: [{ type: 'llm-rubric', value: sample.rubrics['idless-source'] }] }],
    defaultTest: { options: { provider: grader } }, writeLatestResults: false,
  }, { cache: false, maxConcurrency: 3, showProgressBar: false, writeLatestResults: false });
  assert.equal(called, 1);
  assert.equal(result.results[0].success, false);
  assert.throws(() => buildGraderPrompt('', { vars: { output: '# Other response', rubric: sample.rubrics['idless-source'] } }, observation, cases));
});

test('actual AgentRunner wrapper and live dispatch are captured without grader reference in target', () => withWorkspace((workspace, directory) => {
  for (const sample of cases.cases.slice(0, 2)) {
    resetWorkspace(workspace);
    const captured = captureV3({ revisionRoot: process.cwd(), workspace, sample, language: 'en',
      configDirectory: join(directory, 'config'), directory: join(directory, sample.id) });
    assert.equal(existsSync(join(workspace, '.takt/runs/eval/reports/implementation-report.md')), false);
    if (sample.liveInput) {
      resetWorkspace(workspace);
      const repeated = captureV3({ revisionRoot: process.cwd(), workspace, sample, language: 'en',
        configDirectory: join(directory, 'config'), directory: join(directory, 'repeat') });
      assert.equal(repeated.phase1Prompt, captured.phase1Prompt);
      assert.equal(repeated.phase2Prompt, captured.phase2Prompt);
    }
    assert.deepEqual(captured.phase2Options, { allowedTools: [], sessionIdPresent: false });
    for (const [index, prompt] of [captured.phase1Prompt, captured.phase2Prompt].entries()) {
      const parts = captured.phaseParts[index];
      assert.equal(prompt, parts.systemPrompt + '\n\n' + parts.userInstruction);
      assert.match(parts.systemPrompt, /report-phase-handoff/);
      assert.match(parts.systemPrompt, /implement/);
      assert.ok(!prompt.includes(cases.gradingBoundary));
    }
    if (sample.liveInput) {
      assert.equal(captured.liveInstructions[0].content, sample.liveInput);
      assert.equal(captured.liveInstructions[0].state, 'deliveredNextStep');
      assert.ok(captured.phase2Prompt.includes(sample.liveInput));
    } else {
      assert.ok(captured.phase2Prompt.includes(sample.reportName));
      for (const line of sample.reportContent.split('\n').filter(line => /^\d\./.test(line))) assert.ok(captured.phase2Prompt.includes(line));
    }
  }
}));
