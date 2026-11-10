import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';
import { copyManagerTurnContextHarness } from './prepare-manager-turn-context-red.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scenario = 'eval/scenarios/manager-work-split/manager-work-split.yaml';

function dependencies(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const references = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      references.push(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) references.push(node.arguments[0]);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') references.push(node.arguments?.[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references.filter((node) => node && ts.isStringLiteral(node) && node.text.startsWith('.'))
    .map((node) => resolve(dirname(path), node.text))
    .filter((path) => path.startsWith(join(root, 'eval/')) && path.endsWith('.mjs'));
}

test('red preparation copies exactly the manager suite fixtures and its harness dependencies', () => {
  const suite = parse(readFileSync(join(root, scenario), 'utf8'));
  const required = new Set([scenario, 'eval/manager-work-split-config.mjs', 'eval/manager-turn-context-baseline.mjs']);
  function collectReferences(value) {
    if (typeof value === 'string' && value.startsWith('file://')) {
      required.add(relative(root, resolve(root, dirname(scenario), value.slice('file://'.length))));
    } else if (Array.isArray(value)) value.forEach(collectReferences);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectReferences);
  }
  collectReferences(suite);
  const cases = new Set(suite.tests.map(({ vars }) => vars.case));
  for (const name of cases) required.add(`eval/cases/manager-work-split/${name}.yaml`);
  // Follow imports and the SDK worker entrypoint; the main runner uses the manager config filter.
  for (const path of required) {
    if (path.endsWith('.mjs')) {
      for (const dependency of dependencies(join(root, path))) required.add(relative(root, dependency));
    }
  }

  const target = mkdtempSync(join(tmpdir(), 'takt-manager-red-copy-'));
  const untouched = ['src/production.ts', 'builtins/ja/facets/instructions/manager.md',
    'eval/asserts/external-confirmation.mjs', 'eval/cases/another-suite/fixture.yaml',
    'eval/scripts/run-evals.mjs', 'eval/scripts/merge-ci-public-results.mjs',
    'eval/suite-registry.mjs', 'eval/adjudicator-no-fix-cases.mjs'];
  try {
    for (const path of untouched) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      writeFileSync(join(target, path), `baseline:${path}`);
    }
    const copied = copyManagerTurnContextHarness(root, target);
    assert.deepEqual(new Set(copied), required, 'missing dependencies or unrelated assets in the copy manifest');
    for (const path of required) assert.deepEqual(readFileSync(join(target, path)), readFileSync(join(root, path)), path);
    assert.deepEqual(new Set(readdirSync(join(target, 'eval/cases/manager-work-split'))),
      new Set([...cases].map((name) => `${name}.yaml`)));
    for (const path of untouched) assert.equal(readFileSync(join(target, path), 'utf8'), `baseline:${path}`);
    const files = readdirSync(target, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      .map((entry) => relative(target, join(entry.parentPath, entry.name)));
    assert.deepEqual(new Set(files), new Set([...required, ...untouched]));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

function redExampleFixture(t, temporaryMode) {
  const directory = mkdtempSync(join(tmpdir(), 'takt-manager-red-example-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const green = join(directory, 'green with spaces');
  const temporary = join(directory, 'tmp with spaces');
  const bin = join(directory, 'bin');
  const log = join(directory, 'evaluations.jsonl');
  for (const path of [green, temporary, bin]) mkdirSync(path);
  const git = (...args) => execFileSync('git', args, { cwd: green, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init');
  git('config', 'core.hooksPath', '/dev/null');
  mkdirSync(join(green, 'eval/scripts'), { recursive: true });
  writeFileSync(join(green, 'eval/scripts/run-evals.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.EVAL_TEST_LOG, JSON.stringify({
      cwd: process.cwd(), args: process.argv.slice(2),
      adapter: process.env.TAKT_EVAL_MANAGER_PROMPT_MODULE,
    }) + '\\n');
    if (process.env.EVAL_TEST_SIGNAL) process.kill(process.ppid, process.env.EVAL_TEST_SIGNAL);
    process.exit(Number(process.env.EVAL_TEST_EXIT));
  `);
  git('add', '.');
  git('-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid', 'commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const existing = join(temporary, 'takt-manager-turn-context-red');
  git('worktree', 'add', '--detach', existing, 'HEAD');
  writeFileSync(join(existing, 'keep.txt'), 'existing worktree data');
  const worktrees = git('worktree', 'list', '--porcelain');
  copyManagerTurnContextHarness(root, green);
  copyFileSync(join(root, 'eval/scripts/prepare-manager-turn-context-red.mjs'),
    join(green, 'eval/scripts/prepare-manager-turn-context-red.mjs'));
  symlinkSync(join(root, 'node_modules'), join(green, 'node_modules'), 'dir');
  // Dependency installation and model execution are outside this lifecycle test.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const blocks = [...readFileSync(join(root, 'eval/README.md'), 'utf8').matchAll(/```bash\n([\s\S]*?)\n```/g)];
  const example = blocks.find(([, code]) => code.includes('prepare-manager-turn-context-red.mjs'))?.[1];
  assert.ok(example, 'README must provide an executable red preparation example');
  const cwd = join(green, 'eval');
  const temporaryPath = temporaryMode === 'relative' ? relative(cwd, temporary) : temporary;
  return {
    green,
    run(shell, exit, signal) {
      return spawnSync(shell, ['-c', example], {
        cwd, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, TMPDIR: temporaryPath, PATH: `${bin}:${process.env.PATH}`,
          EVAL_TEST_LOG: log, EVAL_TEST_EXIT: String(exit), EVAL_TEST_SIGNAL: signal },
      });
    },
    records: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    assertClean() {
      assert.equal(git('worktree', 'list', '--porcelain'), worktrees);
      assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'existing worktree data');
      assert.deepEqual(readdirSync(temporary).filter((name) => name.startsWith('takt-manager-turn-context-red')),
        ['takt-manager-turn-context-red']);
    },
  };
}

for (const temporaryMode of ['absolute', 'relative']) {
  for (const shell of ['bash', 'zsh']) {
    test(`README red example with ${temporaryMode} TMPDIR can run twice in ${shell} without removing an existing worktree`, (t) => {
      if (shell === 'zsh' && spawnSync(shell, ['--version']).error?.code === 'ENOENT') {
        t.skip('zsh is not installed');
        return;
      }
      const fixture = redExampleFixture(t, temporaryMode);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = fixture.run(shell, 0, '');
        assert.equal(result.status, 0, result.stderr);
        fixture.assertClean();
      }
      const [first, second] = fixture.records();
      assert.notEqual(first.cwd, second.cwd);
      for (const record of [first, second]) {
        assert.equal(existsSync(record.cwd), false);
        assert.equal(record.adapter, './manager-turn-context-baseline.mjs');
        assert.ok(record.args.includes('manager-work-split'));
      }
    });
  }

  for (const [name, exit, signal, expected] of [
    ['evaluation failure', 7, '', 7],
    ['HUP', 0, 'SIGHUP', 129],
    ['INT', 0, 'SIGINT', 130],
    ['TERM', 0, 'SIGTERM', 143],
  ]) {
    test(`README red example with ${temporaryMode} TMPDIR cleans up after ${name} and permits a rerun`, (t) => {
      const fixture = redExampleFixture(t, temporaryMode);
      const result = fixture.run('bash', exit, signal);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(fixture.records().length, 1);
      fixture.assertClean();
      const rerun = fixture.run('bash', 0, '');
      assert.equal(rerun.status, 0, rerun.stderr);
      fixture.assertClean();
    });
  }

  test(`README red example with ${temporaryMode} TMPDIR cleans up a worktree when harness preparation fails`, (t) => {
    const fixture = redExampleFixture(t, temporaryMode);
    rmSync(join(fixture.green, scenario));
    const result = fixture.run('bash', 0, '');
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    fixture.assertClean();
  });
}
