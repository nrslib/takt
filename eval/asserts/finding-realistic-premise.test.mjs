import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';
import { selectPromptEvalSuites, promptEvalPrepareTargets } from '../suite-registry.mjs';
import { PREPARE_TARGET_IDS } from '../scripts/prepare.mjs';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../../dist/infra/config/index.js';
import { InstructionBuilder } from '../../dist/core/workflow/instruction/InstructionBuilder.js';
import { getAllParallelSubSteps } from '../../dist/core/models/index.js';

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

function expandedPolicy(language, name) {
  const root = join(repoRoot, 'builtins', language, 'facets');
  return expandFacetIncludes({
    body: fs.readFileSync(join(root, 'policies', `${name}.md`), 'utf8'),
    facetsRoots: [root], repertoireDirs: [], allowedRoots: [root],
  }).body;
}

function firstTableDataRow(policy) {
  const lines = policy.split('\n');
  const separator = lines.findIndex(line => /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
  assert.ok(separator > 0, 'policy must have a table header and separator');
  assert.match(lines[separator - 1], /^\|.+\|$/);
  const row = lines[separator + 1];
  assert.match(row, /^\|.+\|$/);
  return row;
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

test('process policy comes first once, only in the selected Japanese and English steps', () => {
  const stepFiles = [
    'peer-review-adjudication', 'peer-review-fix-verifier', 'peer-review-fix-plan',
    'peer-review-final-gate', 'review-supervise-to-complete',
  ];
  const workflowFiles = [
    'development-core', 'final-gate', 'mini-core', 'review-takt-default', 'review',
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
      assert.deepEqual(japanese, english, name);
      assert.equal(japanese.length, name === 'terraform' ? 2 : 1, name);
      for (const policy of japanese) {
        assert.equal(policy[0], 'process-deviation', name);
        assert.equal(policy.filter(value => value === 'process-deviation').length, 1, name);
      }
    }
  }
  for (const language of ['ja', 'en']) {
    for (const file of fs.readdirSync(join(repoRoot, 'builtins', language, 'workflows'))) {
      if (!file.startsWith('audit-') || !file.endsWith('.yaml')) continue;
      assert.deepEqual(policiesWithProcess(parse(read(`builtins/${language}/workflows/${file}`))), [], file);
    }
  }
});

test('prepared prompts carry the new instructions, inline adjudication row and complete process policy once', () => {
  execFileSync(process.execPath, [
    'eval/scripts/prepare.mjs', ...cases.map(id => `${suiteName}-${id}`),
  ], { cwd: repoRoot });
  const processPolicy = read('builtins/ja/facets/policies/process-deviation.md').trim();
  const adjudicationRow = firstTableDataRow(expandedPolicy('ja', 'review-adjudication'));
  const adjudicationProcedure = read('builtins/ja/facets/instructions/adjudicate-review-findings.md')
    .split('\n\n').find(paragraph => paragraph.startsWith('指摘を修正対象にする前'));
  const reviewProcedure = read('builtins/ja/facets/partials/instructions/review-path-check.md')
    .split('\n\n').find(paragraph => paragraph.startsWith('指摘にする前に'));
  const verificationProcedure = read('builtins/ja/facets/instructions/verify-fix.md')
    .split('\n\n').find(paragraph => paragraph.startsWith('指示された作業の進め方'));
  for (const id of cases) {
    const prompt = read(`eval/prompts/${suiteName}-${id}.phase1.j2`);
    const policySnapshot = read(`eval/fixtures/${suiteName}/${id}/.takt/eval-snapshots/${suiteName}-${id}-policies.md`);
    assert.match(policySnapshot, /保存場所や、それを書いた処理では決めない/);
    assert.match(policySnapshot, /同じ資源への操作が実際の使われ方で重なる/);
    assert.match(policySnapshot, /入力元が実際の使われ方で作る量から選ぶ/);
    if (['rt', 'rc', 'rq', 'ne', 'np', 'nb'].includes(id)) {
      assert.ok(prompt.includes(reviewProcedure), id);
      assert.ok(!prompt.includes(processPolicy), id);
      if (['rt', 'ne'].includes(id)) {
        assert.match(policySnapshot, /誰が値を決められ、どの処理がその値を読むかを示して、その入力が信頼境界の外から来ることを説明できる/);
      }
    } else {
      assert.ok(policySnapshot.slice(0, 2000).includes(processPolicy), id);
      assert.equal(prompt.split(processPolicy).length, 2, id);
      if (id.startsWith('a')) {
        const start = prompt.indexOf('# レビュー指摘の裁定');
        assert.ok(start >= 0, id);
        const excerpt = prompt.slice(start, prompt.indexOf('...（以下省略）...', start));
        assert.ok(excerpt.includes(adjudicationRow), id);
        assert.ok(prompt.includes(adjudicationProcedure), id);
      } else {
        assert.ok(prompt.includes(verificationProcedure), id);
      }
    }
  }
});

test('resolved Japanese and English steps put process policy first once and keep the adjudication premise row inside the production 2000 character excerpt', t => {
  const root = temporaryDirectory(t);
  for (const language of ['ja', 'en']) {
    const project = join(root, language);
    fs.mkdirSync(join(project, '.takt'), { recursive: true });
    fs.writeFileSync(join(project, '.takt/config.yaml'), `language: ${language}\n`);
    const processPolicy = read(`builtins/${language}/facets/policies/process-deviation.md`);
    const adjudicationPolicy = expandedPolicy(language, 'review-adjudication');
    const adjudicationRow = firstTableDataRow(adjudicationPolicy);
    const procedure = read(`builtins/${language}/facets/instructions/verify-fix.md`).split('\n\n')
      .find(paragraph => paragraph.startsWith(language === 'ja'
        ? '指示された作業の進め方' : 'If you find a past action'));
    assert.ok(procedure);
    for (const [name, stepNames, callStepName] of [
      ['peer-review', ['review-adjudication', 'final-gate']],
      ['peer-review', ['fix-verifier', 'verification-replan'], 'remediation'],
      ['review-remediation', ['fix-plan', 'fix-replan', 'verification-replan', 'fix-verifier']],
      ['development-remediation', ['fix-plan', 'fix-replan', 'verification-replan', 'fix-verifier']],
      ['development-remediation-dynamic', ['fix-plan', 'fix-replan', 'verification-replan', 'fix-verifier']],
      ['development-remediation-team', ['fix-plan', 'fix-replan', 'verification-replan', 'fix-verifier']],
      ['development-core', ['replan']],
      ['final-gate', ['supervise']],
      ['mini-core', ['supervise']],
      ['review-takt-default', ['supervise']],
      ['review', ['supervise']],
      ['review-backend', ['supervise']],
      ['simple-core', ['supervise']],
      ['simple', ['supervise']],
      ['terraform', ['supervise', 'final-supervise']],
    ]) {
      let workflow = loadWorkflowByIdentifier(name, project);
      assert.ok(workflow, name);
      if (callStepName) {
        const callStep = workflow.steps.find(step => step.name === callStepName);
        assert.equal(callStep?.kind, 'workflow_call', `${name}/${callStepName}`);
        workflow = resolveWorkflowCallTarget(workflow, callStep, project);
        assert.ok(workflow, `${name}/${callStepName}`);
      }
      for (const stepName of stepNames) {
        const index = workflow.steps.findIndex(step => step.name === stepName
          || (step.parallel && getAllParallelSubSteps(step.parallel).some(child => child.name === stepName)));
        assert.ok(index >= 0, `${name}/${stepName}`);
        const parent = workflow.steps[index];
        const step = parent.name === stepName ? parent
          : getAllParallelSubSteps(parent.parallel).find(child => child.name === stepName);
        assert.equal(step.policyContents[0].content, processPolicy, `${language}/${name}/${stepName}`);
        const combined = step.policyContents.map(({ content }) => content).join('\n\n---\n\n');
        assert.equal(combined.indexOf(processPolicy), 0, `${language}/${name}/${stepName}`);
        assert.ok(combined.slice(0, 2000).includes(processPolicy), `${language}/${name}/${stepName}`);
        assert.equal(step.policyContents.filter(({ content }) => content === processPolicy).length,
          1, `${language}/${name}/${stepName}`);
        const prepared = new InstructionBuilder(step, {
          task: 'Verify the requested change.', iteration: 1, maxSteps: 10, stepIteration: 1,
          cwd: project, projectCwd: project, userInputs: [], workflowSteps: workflow.steps,
          currentStepIndex: index, reportDir: join(project, 'reports'), language,
          policySourcePath: join(project, 'policies.md'),
        }).prepare();
        assert.equal(prepared.text.split(processPolicy).length, 2,
          `${language}/${name}/${stepName}`);
        if (['fix-verifier', 'verification-replan', 'final-gate'].includes(stepName)) {
          assert.ok(prepared.text.includes(procedure), `${language}/${name}/${stepName}`);
        }
        if (stepName === 'review-adjudication') {
          assert.ok(step.policyContents.some(({ content }) => content === adjudicationPolicy),
            `${language}/${name}/${stepName}`);
          const excerpt = combined.slice(0, 2000);
          const omittedMarker = language === 'ja' ? '...（以下省略）...' : '...TRUNCATED...';
          assert.ok(combined.length > 2000, `${language}/${name}/${stepName}`);
          assert.ok(prepared.text.includes(`${excerpt}\n${omittedMarker}`), `${language}/${name}/${stepName}`);
          assert.ok(excerpt.includes(adjudicationRow), `${language}/${name}/${stepName}`);
        }
      }
    }
  }
});
