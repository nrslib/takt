import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { expandFacetIncludes } from '#faceted-prompting/cli/facet-includes';
import { selectPromptEvalSuites, promptEvalPrepareTargets } from '../suite-registry.mjs';
import { PREPARE_TARGET_IDS } from '../scripts/prepare.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const suiteName = 'finding-realistic-premise';
const cases = [
  'rt', 'rc', 'rq', 'ne', 'np', 'nb', 'at', 'ac', 'aq', 'ae', 'ap', 'ab',
  'vd1', 'vd2', 'vn1', 'vn2', 'pd1',
];
const fixtures = join(repoRoot, 'eval/fixtures', suiteName);
const read = path => fs.readFileSync(join(repoRoot, path), 'utf8');
const config = parse(read(`eval/agents/shared-policy/${suiteName}.yaml`));

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'realistic-premise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureModule(caseId, name) {
  return import(pathToFileURL(join(fixtures, caseId, 'src', `${name}.mjs`)).href);
}

test('suite binds all 17 prompts, tasks, snapshots and fixtures to its own cases', () => {
  const [suite] = selectPromptEvalSuites({ names: [suiteName] });
  assert.equal(suite.execution.defaultEligible, false);
  assert.deepEqual(suite.execution.credentials, ['claude', 'codex']);
  assert.equal(suite.execution.cost, 'high');
  const targets = cases.map(id => `${suiteName}-${id}`);
  assert.deepEqual(promptEvalPrepareTargets([suite]), targets);
  assert.ok(targets.every(id => PREPARE_TARGET_IDS.includes(id)));
  assert.deepEqual(config.prompts.map(({ label }) => label), cases);
  assert.deepEqual(config.tests.map(({ description }) => description.toLowerCase()), cases);
  for (const id of cases) {
    const target = `${suiteName}-${id}`;
    const prompt = config.prompts.find(({ label }) => label === id);
    const entry = config.tests.find(({ description }) => description === id.toUpperCase());
    assert.equal(prompt.raw, `file://../../prompts/${target}.phase1.j2`);
    assert.equal(prompt.config.working_dir, `fixtures/${suiteName}/${id}`);
    assert.deepEqual(prompt.config.required_snapshots, [`.takt/eval-snapshots/${target}-policies.md`]);
    assert.deepEqual(entry.prompts, [id]);
    assert.equal(entry.vars.task, `file://../../cases/${target}-task.md`);
    assert.equal(entry.vars.previous_response, '');
    assert.ok(read(`eval/cases/${target}-task.md`).length > 0);
    const pkg = JSON.parse(read(`eval/fixtures/${suiteName}/${id}/package.json`));
    assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
    assert.equal(entry.assert.length, 1);
    assert.equal(entry.assert[0].type, 'llm-rubric');
    assert.equal(entry.assert[0].metric, `${suiteName}/${id}-boundary`);
    assert.ok(entry.assert[0].value.startsWith(
      '見出し・ID・文言ではなく判断の実質で判定する。要求していない説明を合格条件にしない。',
    ));
    assert.match(entry.assert[0].value, /この点以外の指摘の有無は合否に関係しない/);
  }
  const reference = parse(read('eval/agents/shared-policy/finding-premise-scope.yaml'));
  assert.deepEqual(config.providers, reference.providers);
  assert.deepEqual(config.defaultTest, reference.defaultTest);
  assert.deepEqual(config.evaluateOptions, reference.evaluateOptions);
  assert.ok(config.providers.every(({ id, config: provider }) =>
    id === 'file://../../providers/cli-review.mjs'
    && provider.isolate_working_dir === true
    && provider.working_dir === undefined));
  assert.match(JSON.parse(read('package.json')).scripts[`eval:prompts:${suiteName}`],
    /run-evals\.mjs --prepare finding-realistic-premise --no-cache$/);
});

test('adjudication seeds use the production report filenames and preserve the review fixture', () => {
  for (const [review, adjudication, report] of [
    ['rt', 'at', 'security-review.md'], ['rc', 'ac', 'coding-review.md'],
    ['rq', 'aq', 'architect-review.md'], ['ne', 'ae', 'security-review.md'],
    ['np', 'ap', 'coding-review.md'], ['nb', 'ab', 'architect-review.md'],
  ]) {
    for (const directory of ['src', 'docs', 'test']) {
      for (const name of fs.readdirSync(join(fixtures, review, directory))) {
        assert.equal(fs.readFileSync(join(fixtures, adjudication, directory, name), 'utf8'),
          fs.readFileSync(join(fixtures, review, directory, name), 'utf8'));
      }
    }
    for (const name of [
      'architect-review.md', 'security-review.md', 'coding-review.md',
      'testing-review.md', 'ai-antipattern-review.md',
    ]) {
      const seed = fs.readFileSync(join(fixtures, adjudication, 'reports-seed', name), 'utf8');
      assert.match(seed, name === report ? /REJECT/ : /APPROVE/);
      if (name === report) {
        assert.match(seed, /finding_id:/);
        assert.match(seed, /status: new/);
      }
    }
  }
});

test('snippet state is produced under its generated ignore rule, and archive entries can escape the import directory', async t => {
  const root = temporaryDirectory(t);
  const snippets = await fixtureModule('ne', 'snippets');
  snippets.init(root);
  const entry = snippets.newSnippet(root);
  assert.equal(fs.readFileSync(join(root, '.snip/.gitignore'), 'utf8'), '*\n');
  assert.equal(dirname(entry.directory), join(root, '.snip/work'));
  const archive = join(root, 'collection.json');
  fs.writeFileSync(archive, JSON.stringify([{ path: '../received.txt', content: 'from collection' }]));
  snippets.importArchive(root, archive);
  assert.equal(fs.readFileSync(join(root, '.snip/received.txt'), 'utf8'), 'from collection');
});

test('sync launches two reads of the same file before either update is written', async t => {
  const { sync } = await fixtureModule('np', 'bookmarks');
  let reads = 0;
  let stored = '[]';
  const writes = [];
  t.mock.method(fs.promises, 'readFile', async () => {
    reads += 1;
    return stored;
  });
  t.mock.method(fs.promises, 'writeFile', async (file, content) => {
    assert.equal(reads, 2);
    writes.push(file);
    stored = content;
  });
  await sync('/bookmarks', ['https://example.test/one', 'https://example.test/two'], 2);
  assert.deepEqual(writes, ['/bookmarks/bookmarks.json', '/bookmarks/bookmarks.json']);
  assert.equal(JSON.parse(stored).length, 1);
});

test('documented daily log output exceeds the actual default subprocess output limit', () => {
  const manifest = JSON.parse(read(`eval/fixtures/${suiteName}/nb/docs/daily-manifest.json`));
  const outputBytes = manifest.count * (Buffer.byteLength(manifest.firstPath) + 1);
  assert.ok(outputBytes > 1024 * 1024);
  assert.throws(() => execFileSync(process.execPath, [
    '-e', 'process.stdout.write("x".repeat(Number(process.argv[1])))', String(outputBytes),
  ], { timeout: 10000, killSignal: 'SIGKILL', env: {} }),
  error => error.code === 'ENOBUFS');
});

test('process policy occurs once, only in the selected Japanese and English steps regardless of order', () => {
  const stepFiles = [
    'peer-review-adjudication', 'peer-review-fix-verifier', 'peer-review-fix-plan',
    'peer-review-final-gate', 'review-supervise-to-complete',
  ];
  const workflowFiles = [
    'development-core', 'final-gate', 'mini-core', 'review-remediation', 'review-takt-default', 'review',
    'simple-core', 'simple', 'terraform',
  ];
  function policiesWithProcess(node) {
    if (node === null || typeof node !== 'object') return [];
    const found = Array.isArray(node.policy) && node.policy.includes('process-deviation')
      ? [node.policy] : [];
    return [...found, ...Object.values(node).flatMap(policiesWithProcess)];
  }
  for (const [directory, names] of [['steps', stepFiles], ['workflows', workflowFiles]]) {
    for (const name of names) {
      const japanese = policiesWithProcess(parse(read(`builtins/ja/${directory}/${name}.yaml`)));
      const english = policiesWithProcess(parse(read(`builtins/en/${directory}/${name}.yaml`)));
      assert.deepEqual(japanese.map(policy => [...policy].sort()), english.map(policy => [...policy].sort()), name);
      assert.equal(japanese.length, name === 'terraform' ? 2 : 1, name);
      for (const policy of japanese) {
        assert.equal(policy.filter(value => value === 'process-deviation').length, 1, name);
      }
    }
  }
  for (const language of ['ja', 'en']) {
    const workflowsWithProcess = fs.readdirSync(join(repoRoot, 'builtins', language, 'workflows'))
      .filter(file => file.endsWith('.yaml'))
      .filter(file => policiesWithProcess(parse(read(`builtins/${language}/workflows/${file}`))).length > 0)
      .map(file => file.slice(0, -'.yaml'.length));
    assert.deepEqual(new Set(workflowsWithProcess), new Set(workflowFiles), language);
  }
});

test('prepared prompts receive the instruction facets and partials for each case role', () => {
  execFileSync(process.execPath, [
    'eval/scripts/prepare.mjs', ...cases.map(id => `${suiteName}-${id}`),
  ], { cwd: repoRoot, timeout: 30_000, killSignal: 'SIGKILL' });
  const facetsRoot = join(repoRoot, 'builtins/ja/facets');
  const roles = [
    { ids: ['rt', 'rc', 'rq', 'ne', 'np', 'nb'], path: 'partials/instructions/review-path-check.md' },
    { ids: ['at', 'ac', 'aq', 'ae', 'ap', 'ab'], path: 'instructions/adjudicate-review-findings.md' },
    { ids: ['vd1', 'vd2', 'vn1', 'vn2'], path: 'instructions/verify-fix.md' },
    { ids: ['pd1'], path: 'instructions/verification-replan.md' },
  ];
  assert.deepEqual(roles.flatMap(({ ids }) => ids).sort(), [...cases].sort());
  for (const { ids, path } of roles) {
    const instruction = expandFacetIncludes({
      body: fs.readFileSync(join(facetsRoot, path), 'utf8'),
      facetsRoots: [facetsRoot], repertoireDirs: [], allowedRoots: [facetsRoot],
    }).body;
    // Report references are rendered from each case's seeded reports at prepare time.
    const fragments = instruction.split(/\{report:[^}]+\}/g).map(fragment => fragment.trim()).filter(Boolean);
    assert.ok(fragments.length > 0, path);
    for (const id of ids) {
      const prompt = read(`eval/prompts/${suiteName}-${id}.phase1.j2`);
      for (const fragment of fragments) assert.ok(prompt.includes(fragment), `${id}: ${path}`);
    }
  }
});
