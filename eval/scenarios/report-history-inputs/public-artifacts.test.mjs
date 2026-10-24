import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { createEvaluationEnvironment, runIsolatedEvaluation } from './isolated-run.mjs';
import { publishEvaluation } from './public-artifacts.mjs';

function workspace(t) {
  const root = mkdtempSync('/tmp/report-history-contract-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(root, withPrivateOutput = false) {
  const raw = join(root, 'raw');
  const current = 'project/reports/.takt-report-internal/executions/versions/current/current.md';
  const prior = 'project/reports/.takt-report-internal/executions/versions/prior/prior.md';
  for (const [path, content] of [[current, 'CURRENT_PROOF=fixture-current'], [prior, 'PRIOR_PROOF=fixture-prior']]) {
    mkdirSync(join(raw, path, '..'), { recursive: true });
    writeFileSync(join(raw, path), content);
  }
  const output = 'CURRENT_PROOF=fixture-current\nPRIOR_PROOF=fixture-prior\nCURRENT_TARGETS: B\nPROGRESS: 改善';
  const commands = [current, prior].map(path => ({ command: `cat ${path.slice('project/'.length)}`,
    exitCode: 0, status: 'completed', output: (withPrivateOutput ? 'PRIVATE_LOCAL_INSTRUCTION' : '')
      + readFileSync(join(raw, path), 'utf8') + (withPrivateOutput ? '\nPRIVATE_LOCAL_INSTRUCTION' : '') }));
  if (withPrivateOutput) commands.push({ command: 'cat /synthetic-home/.codex/AGENTS.md',
    exitCode: 0, status: 'completed', output: 'PRIVATE_LOCAL_INSTRUCTION' });
  writeFileSync(join(raw, 'fix-plan.prompt.md'), `Read ${join(raw, current)} and ${join(raw, prior)}`);
  writeFileSync(join(raw, 'fix-plan.invocation.json'), JSON.stringify({ instruction: `Read ${join(raw, current)}` }));
  writeFileSync(join(raw, 'fix-plan.output.md'), output + (withPrivateOutput ? '\nPRIVATE_LOCAL_INSTRUCTION' : ''));
  writeFileSync(join(raw, 'fix-plan.trace.json'), JSON.stringify({ model: 'gpt-6.1-sol', effort: 'high',
    sandbox: 'read-only', approvalPolicy: 'never', startedFresh: true, observedTurnContexts: 1,
    promptHash: 'executed-prompt-hash', responseHash: 'executed-response-hash', commands }));
  writeFileSync(join(raw, 'summary.json'), JSON.stringify([{ role: 'fix-plan', pass: true, commands }]));
  return { raw, current, prior };
}

for (const withPrivateOutput of [false, true]) {
  test(withPrivateOutput ? '[SCN-問題-2-N1] public artifacts omit local instructions while retaining both fixed reads'
    : '[SCN-問題-2-P1] public artifacts preserve fixed versions, successful reads and comparison', t => {
    const root = workspace(t);
    const { raw, current, prior } = fixture(root, withPrivateOutput);
    const destination = join(root, 'public');
    const result = publishEvaluation(raw, destination, { isolated: true, failed: false, interrupted: false });
    assert.equal(result[0].pass, true);
    assert.equal(result[0].currentTargets, 'B');
    assert.equal(result[0].progress, '改善');
    const [verification] = JSON.parse(readFileSync(join(destination, 'receipt-verification.json')));
    assert.deepEqual(verification.receipts.map(row => row.path), [current, prior]);
    for (const row of verification.receipts) {
      assert.equal(row.exitCode, 0);
      assert.equal(row.status, 'completed');
      assert.ok(row.command.startsWith('cat reports/'));
      assert.ok(row.output.includes(row.marker));
      assert.ok(existsSync(join(destination, row.path)));
      assert.equal(row.output.includes('PRIVATE_LOCAL_INSTRUCTION'), false);
      assert.equal(row.command.includes('/synthetic-home'), false);
    }
    const manifest = JSON.parse(readFileSync(join(destination, 'publication.json')));
    for (const [path, expected] of Object.entries(manifest.files)) {
      const content = readFileSync(join(destination, path), 'utf8');
      assert.equal(createHash('sha256').update(content).digest('hex'), expected);
      assert.equal(content.includes('PRIVATE_LOCAL_INSTRUCTION'), false, path);
      assert.equal(content.includes('/synthetic-home'), false, path);
      assert.equal(content.includes(root), false, path);
    }
    const trace = JSON.parse(readFileSync(join(destination, 'fix-plan.trace.json')));
    assert.equal(trace.executedPromptHash, 'executed-prompt-hash');
    assert.notEqual(trace.promptHash, trace.executedPromptHash);
  });
}

test('answer markers without successful fixed-version reads cannot establish success', t => {
  const root = workspace(t);
  const { raw } = fixture(root);
  const path = join(raw, 'fix-plan.trace.json');
  const trace = JSON.parse(readFileSync(path));
  trace.commands[1].exitCode = 1;
  writeFileSync(path, JSON.stringify(trace));
  const result = publishEvaluation(raw, join(root, 'public'), { isolated: true, failed: false, interrupted: false });
  assert.equal(result[0].pass, false);
});

test('compound reads retain actual reader arguments and the recorded exit status without unrelated output', t => {
  const root = workspace(t);
  const { raw, current, prior } = fixture(root);
  const path = join(raw, 'fix-plan.trace.json');
  const trace = JSON.parse(readFileSync(path));
  trace.commands = [{ command: `printf 'PRIVATE_LOCAL_INSTRUCTION'; cat ${current.slice(8)}; cat ./${prior.slice(8)}`,
    status: 'completed', exitCode: 0, output: 'PRIVATE_LOCAL_INSTRUCTION'
      + readFileSync(join(raw, current), 'utf8') + '\n' + readFileSync(join(raw, prior), 'utf8') }];
  writeFileSync(path, JSON.stringify(trace));
  const [result] = publishEvaluation(raw, join(root, 'public'), { isolated: true, failed: false, interrupted: false });
  assert.equal(result.pass, true);
  for (const receipt of result.commands) {
    assert.equal(receipt.commandExcerpt, true);
    assert.equal(receipt.exitCodeScope, 'recorded command');
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.command.includes('PRIVATE_LOCAL_INSTRUCTION'), false);
    assert.equal(receipt.output.includes('PRIVATE_LOCAL_INSTRUCTION'), false);
  }
});

test('failed historical results remain failed and omit private diagnostics', t => {
  const root = workspace(t);
  const { raw } = fixture(root, true);
  writeFileSync(join(raw, 'summary.json'), JSON.stringify([{ role: 'fix-plan', pass: false,
    error: '/synthetic-home/.codex/AGENTS.md PRIVATE_LOCAL_INSTRUCTION' }]));
  const destination = join(root, 'public');
  assert.equal(publishEvaluation(raw, destination, { isolated: false, failed: true, interrupted: true })[0].pass, false);
  const summary = JSON.parse(readFileSync(join(destination, 'summary.json')));
  assert.equal(summary[0].error, 'Evaluation interrupted');
  assert.equal(JSON.stringify(summary).includes('PRIVATE_LOCAL_INSTRUCTION'), false);
  assert.equal(JSON.parse(readFileSync(join(destination, 'publication.json'))).historical, true);
});

test('in-place migration rewrites every existing artifact and recomputes public hashes', t => {
  const root = workspace(t);
  const { raw } = fixture(root, true);
  const before = readdirSync(raw, { recursive: true }).filter(path => !existsSync(join(raw, path, '.')));
  publishEvaluation(raw, raw, { isolated: false, failed: false, interrupted: false });
  const manifest = JSON.parse(readFileSync(join(raw, 'publication.json')));
  assert.ok(before.every(path => Object.hasOwn(manifest.files, path)));
  assert.equal(JSON.parse(readFileSync(join(raw, 'summary.json')))[0].pass, true);
});

function sourceEnvironment(root) {
  const home = join(root, 'source-home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex/auth.json'), '{"access_token":"fixture-auth"}');
  for (const path of ['config.toml', 'AGENTS.md', 'memory.md']) writeFileSync(join(home, '.codex', path), 'PRIVATE_LOCAL_INSTRUCTION');
  return { HOME: home, PATH: process.env.PATH, LANG: 'C', NODE_OPTIONS: '--require=/private-hook.js',
    UNRELATED_SECRET: 'PRIVATE_LOCAL_SETTING' };
}

test('isolated home copies only authentication and removes it after use', t => {
  const root = workspace(t);
  const sourceEnv = sourceEnvironment(root);
  const isolated = createEvaluationEnvironment(sourceEnv);
  t.after(isolated.cleanup);
  assert.notEqual(isolated.env.HOME, sourceEnv.HOME);
  assert.deepEqual(readdirSync(isolated.env.CODEX_HOME), ['auth.json']);
  assert.equal(readFileSync(join(isolated.env.CODEX_HOME, 'auth.json'), 'utf8'), '{"access_token":"fixture-auth"}');
  assert.equal(isolated.env.NODE_OPTIONS, undefined);
  assert.equal(isolated.env.UNRELATED_SECRET, undefined);
  isolated.cleanup();
  assert.equal(existsSync(isolated.root), false);
  assert.ok(existsSync(join(sourceEnv.HOME, '.codex/AGENTS.md')));
});

for (const interrupted of [false, true]) {
  test(`isolated child ${interrupted ? 'interruption' : 'failure'} publishes only a minimal failure and cleans its home`, async t => {
    const root = workspace(t);
    const worker = join(root, 'worker.mjs');
    const observed = join(root, 'observed.json');
    writeFileSync(worker, `import { writeFileSync } from 'node:fs';
      import { homedir } from 'node:os';
      writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), env: process.env, home: homedir() }));
      console.error('PRIVATE_LOCAL_INSTRUCTION /synthetic-home/.codex/AGENTS.md');
      ${interrupted ? 'setInterval(() => {}, 1000);' : 'process.exitCode = 3;'}
    `);
    const controller = new AbortController();
    const running = runIsolatedEvaluation({ worker, args: [observed], destination: join(root, 'public'),
      sourceEnv: sourceEnvironment(root), signal: controller.signal });
    if (interrupted) {
      const deadline = Date.now() + 5000;
      while (!existsSync(observed) && Date.now() < deadline) await setTimeout(10);
      assert.ok(existsSync(observed));
      controller.abort();
    }
    const result = await running;
    assert.equal(result[0].pass, false);
    const execution = JSON.parse(readFileSync(observed));
    assert.equal(execution.home, execution.env.HOME);
    assert.equal(execution.env.CODEX_HOME, join(execution.home, '.codex'));
    assert.equal(execution.env.NODE_OPTIONS, undefined);
    assert.equal(execution.env.UNRELATED_SECRET, undefined);
    assert.equal(existsSync(execution.cwd), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_LOCAL_INSTRUCTION'), false);
    assert.deepEqual(readdirSync(join(root, 'public')).sort(), ['publication.json', 'summary.json']);
  });
}

test('missing authentication never launches a child or falls back to the source home', async t => {
  const root = workspace(t);
  const result = await runIsolatedEvaluation({ worker: join(root, 'missing-worker.mjs'), args: [],
    destination: join(root, 'public'), sourceEnv: { HOME: root }, signal: new AbortController().signal });
  assert.equal(result[0].pass, false);
  assert.equal(JSON.parse(readFileSync(join(root, 'public/publication.json'))).isolated, false);
  assert.equal(JSON.parse(readFileSync(join(root, 'public/publication.json'))).historical, false);
});

test('the worker refuses direct execution in a personal environment before writing artifacts', t => {
  const root = workspace(t);
  const sourceEnv = sourceEnvironment(root);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), 'gpt-6.1-sol'], {
    cwd: root, env: { HOME: sourceEnv.HOME, CODEX_HOME: join(sourceEnv.HOME, '.codex'), PATH: sourceEnv.PATH }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run the isolated evaluation through run\.mjs/);
  assert.equal(existsSync(join(root, 'raw')), false);
});

test('successful child publication also removes the private workspace and authentication', async t => {
  const root = workspace(t);
  const { raw } = fixture(root);
  const observed = join(root, 'observed.json');
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import { cpSync, writeFileSync } from 'node:fs';
    writeFileSync(process.argv[2], JSON.stringify({ root: process.cwd(), home: process.env.HOME }));
    cpSync(process.argv[3], 'raw', { recursive: true });
  `);
  const result = await runIsolatedEvaluation({ worker, args: [observed, raw], destination: join(root, 'public'),
    sourceEnv: sourceEnvironment(root), signal: new AbortController().signal });
  assert.equal(result[0].pass, true);
  const execution = JSON.parse(readFileSync(observed));
  assert.equal(existsSync(execution.root), false);
  assert.equal(existsSync(execution.home), false);
});
