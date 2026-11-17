import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { buildRepairStrategyFixture, repairStrategyWorkDirectory, REPAIR_STRATEGY_CASES, REPAIR_STRATEGY_LANGUAGES } from '../repair-strategy-cases.mjs';
import { observe as observeResource, satisfied as resourceSatisfied } from '../fixtures/repair-strategy/resource-probes.mjs';
import { observe as observeKey, satisfied as keySatisfied } from '../fixtures/repair-strategy/key-probes.mjs';
import { prepareRepairStrategy } from './prepare-repair-strategy.mjs';
import CliPlanReportProvider from '../providers/cli-plan-report.mjs';

const read = path => readFileSync(path, 'utf8');

for (const caseId of REPAIR_STRATEGY_CASES) {
  test(`${caseId}: source observations substantiate findings and successful repairs`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-repair-evidence-'));
    try {
      buildRepairStrategyFixture(directory, caseId);
      const records = JSON.parse(read(join(directory, 'records.json')));
      for (const record of records) {
        const result = spawnSync(process.execPath, ['tests/verify.mjs', record.source, record.probe], {
          cwd: directory, encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, record.exitCode, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), record.observed);
      }
      const current = await import(pathToFileURL(join(directory, 'src/service.mjs')));
      if (caseId === 'p1') {
        const inputs = [['a~b', 'c'], ['a_b', 'c']];
        assert.deepEqual(inputs.map(current.readKey), ['3:a~b1:c', '3:a_b1:c']);
        assert.deepEqual(inputs.map(current.writeKey), ['a_b|c', 'a_b|c']);
      }
      if (caseId === 'f1') {
        assert.equal(existsSync(join(directory, 'history')), false);
        assert.ok(records.every(record => record.source === 'src/service.mjs'));
      } else {
        assert.deepEqual(records.map(({ passed }) => passed), [false, true, false, true, true, false]);
      }
      if (caseId === 'm1') {
        // The mandated byte values and distinct-pair requirement conflict for valid inputs.
        const mandated = parts => parts.map(part => part.replaceAll('~', '_').replaceAll('|', '~')).join('|');
        for (const parts of [['a~b', 'c'], ['a_b', 'c']]) assert.equal(current.key(parts), mandated(parts));
        assert.equal(mandated(['a~b', 'c']), mandated(['a_b', 'c']));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('probes distinguish stable unique keys from nondeterministic keys', () => {
  let counter = 0;
  for (const probe of ['A', 'B', 'C']) {
    assert.equal(keySatisfied(observeKey({ key: parts => JSON.stringify(parts) }, probe)), true);
    assert.equal(keySatisfied(observeKey({ key: () => String(counter++) }, probe)), false);
    assert.equal(keySatisfied(observeKey({ key: () => 'collision' }, probe)), false);
  }
});

test('resource probe observes cancellation during acquire and exactly one release on every terminal', async () => {
  const service = {
    async run(pool, body, signal) {
      const lease = pool.acquire();
      try {
        if (signal.aborted) return { status: 'cancelled' };
        return { status: 'ok', value: await body(lease) };
      } finally {
        lease.release();
      }
    },
  };
  for (const probe of ['A', 'B', 'C']) {
    const result = await observeResource(service, probe);
    assert.equal(resourceSatisfied(result, probe), true);
    assert.equal(resourceSatisfied({ ...result, released: 2 }, probe), false);
    assert.equal(resourceSatisfied({ ...result, calls: probe === 'C' ? 1 : 0 }, probe), false);
    assert.equal(resourceSatisfied({ ...result, outcome: 'wrong-result' }, probe), false);
    assert.equal(result.abortedBeforeAcquire, false);
    assert.equal(result.abortedAfterAcquire, probe === 'C');
    assert.equal(result.released, 1);
    if (probe === 'C') {
      assert.equal(result.calls, 0);
      assert.deepEqual(result.outcome, { status: 'cancelled' });
    }
  }
});

test('prepare resolves completed history, immutable references, and inherited adjudication inputs in both languages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-repair-prepare-'));
  try {
    const promptRoot = join(directory, 'prompts');
    const receipts = await prepareRepairStrategy({ workRoot: join(directory, 'work'), promptRoot });
    assert.equal(receipts.length, REPAIR_STRATEGY_CASES.length * 2 * REPAIR_STRATEGY_LANGUAGES.length);
    assert.equal(new Set(receipts.map(receipt => receipt.project)).size, receipts.length);
    for (const receipt of receipts) {
      const prompt = read(join(promptRoot, `${receipt.id}.phase1.md`));
      const report = read(join(promptRoot, `${receipt.id}.phase2.md`));
      assert.ok(prompt.includes('{{task}}'));
      assert.ok(report.includes('{{previous_response}}'));
      for (const [phase, text] of [['phase1', prompt], ['phase2', report]]) {
        assert.doesNotMatch(text, /(?<![a-z0-9])(?:k1|r1|i1|f1|p1|m1)(?:-en)?(?![a-z0-9])/i, `${receipt.id}/${phase}: internal case ID`);
        for (const other of receipts) assert.ok(!text.includes(other.id), `${receipt.id}/${phase}: ${other.id}`);
      }
      assert.ok(REPAIR_STRATEGY_LANGUAGES.includes(receipt.language));
      assert.equal(parse(read(join(receipt.project, '.takt/config.yaml'))).language, receipt.language);
      const policy = read(new URL(`../../builtins/${receipt.language}/facets/policies/repair-strategy.md`, import.meta.url)).trim();
      // Composition only: semantic decisions belong to the model rubric.
      const policyPath = join(receipt.project, '.takt/eval-snapshots/policies.md');
      const policySnapshot = read(policyPath);
      assert.equal(policySnapshot.split(policy).length - 1, 1);
      assert.ok(prompt.includes(policyPath));
      const reports = receipt.declaredReports;
      assert.deepEqual(reports.map(({ reference }) => reference), receipt.stage === 'plan'
        ? ['review-resolution.md'] : receipt.caseId === 'f1' ? [] : ['fix-plan.md', 'fix-report.md', 'fix-verification.md']);
      if (receipt.caseId === 'f1') assert.deepEqual(receipt.fixedReferences, []);
      else {
        assert.equal(receipt.fixedReferences.length, 6);
        for (const reference of receipt.fixedReferences) {
          const original = read(join(receipt.project, `history/repair-${reference.iteration}`, reference.name));
          assert.equal(read(reference.path), original);
          if (receipt.stage === 'plan' || reference.iteration === 1) assert.ok(prompt.includes(reference.path));
          if (receipt.stage === 'adjudication' && reference.iteration === 2) {
            const supplied = reports.find(report => report.reference === reference.name);
            assert.equal(supplied.path, reference.path);
            assert.ok(prompt.includes(supplied.content.trim()));
          }
          assert.ok(reference.execution.completionOrder > reference.execution.order);
        }
        for (const iteration of [1, 2]) {
          const group = receipt.fixedReferences.filter(reference => reference.iteration === iteration);
          assert.equal(new Set(group.map(reference => reference.execution.id)).size, 1);
        }
        if (receipt.stage === 'adjudication') {
          assert.ok(reports.every(report => report.history.includes('1 / 2 completed previous executions')));

        }
      }
      const resolution = read(join(receipt.project, '.takt/runs/eval/reports/review-resolution.md'));
      if (receipt.stage === 'adjudication') {
        assert.ok(!resolution.includes('CODE-C'));
        assert.ok(!read(join(receipt.project, 'reports-seed/review-resolution.md')).includes('CODE-C'));
      }
      else assert.ok(resolution.includes('CODE-C'));
      if (receipt.caseId === 'p1') {
        for (const kind of ['plan', 'report', 'verification']) {
          const path = `history/migration-${kind}.md`;
          if (receipt.stage === 'adjudication') assert.ok(prompt.includes(read(join(receipt.project, path)).trim()));
          else assert.ok(prompt.includes(path));
        }
        assert.equal(receipt.fixedReferences.length, 6);
        assert.ok(receipt.fixedReferences.every(reference => !reference.path.includes('migration-')));
        assert.ok(reports.every(report => !report.content.includes('incomplete')));
      }
      const calls = [];
      let sessionCreations = 0;
      const analysis = 'Actual analysis from this isolated session.';
      const provider = new CliPlanReportProvider({ config: {
        cli: 'codex', model: 'contract-test', working_dir: receipt.project,
        isolate_working_dir: true, report_prompt: 'prompts/contract-report.md',
        required_snapshots: ['.takt/eval-snapshots/policies.md', '.takt/eval-snapshots/knowledge.md'],
      } }, {
        readPrompt: () => report,
        createCliReviewSession: (_config, { cwd }) => {
          sessionCreations++;
          return { run: async supplied => {
            calls.push(supplied);
            assert.doesNotMatch(supplied, /(?<![a-z0-9])(?:k1|r1|i1|f1|p1|m1)(?:-en)?(?![a-z0-9])/i);
            assert.ok(!supplied.includes(receipt.project));
            for (const kind of ['policies', 'knowledge']) {
              const path = `.takt/eval-snapshots/${kind}.md`;
              assert.equal(read(join(cwd, path)), read(join(receipt.project, path)));
            }
            for (const reference of receipt.fixedReferences) {
              assert.equal(read(reference.path.replace(receipt.project, cwd)), read(reference.path));
            }
            if (calls.length === 1) assert.ok(supplied.includes(join(cwd, '.takt/eval-snapshots/policies.md')));
            else assert.ok(supplied.includes(analysis));
            return calls.length === 1 ? analysis : 'Final report';
          } };
        },
      });
      const result = await provider.callApi(prompt, { vars: { task: 'Read spec.md.', output_phase: 'phase2' } });
      assert.deepEqual(result, { output: 'Final report', metadata: { phase1_response: analysis } });
      assert.equal(calls.length, 2);
      assert.equal(sessionCreations, 1, `${receipt.id}: both phases must use the same session`);
    }
    for (const caseId of REPAIR_STRATEGY_CASES) {
      for (const stage of ['adjudication', 'plan']) {
        const pair = receipts.filter(receipt => receipt.caseId === caseId && receipt.stage === stage);
        assert.deepEqual(pair.map(receipt => receipt.language), REPAIR_STRATEGY_LANGUAGES);
        for (const path of ['src/service.mjs', 'tests/probes.mjs', 'records.json', 'spec.md']) {
          assert.equal(read(join(pair[0].project, path)), read(join(pair[1].project, path)));
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// These checks protect rubric coverage; model judgment still requires scenario evaluation.
for (const language of REPAIR_STRATEGY_LANGUAGES) {
  for (const caseId of REPAIR_STRATEGY_CASES) {
    for (const phase of ['phase1', 'phase2']) {
      test(`adjudication rubric scores ${caseId} trigger decision / ${language} / ${phase}`, () => {
        const suite = parse(read(new URL('../agents/review-adjudication/review-adjudication.yaml', import.meta.url)));
        const label = `${caseId}${language === 'en' ? '-en' : ''}`;
        const entries = suite.tests.filter(entry => entry.prompts.includes(label) && entry.vars.output_phase === phase);
        assert.equal(entries.length, 1);
        const rubrics = entries[0].assert.filter(assertion => assertion.type === 'llm-rubric');
        assert.equal(rubrics.length, 1);
        const rubric = rubrics[0].value;
        const context = `${label}/${phase}`;
        if (caseId === 'k1' || caseId === 'r1' || caseId === 'm1') {
          const conditions = language === 'ja' ? [
            /再発と共通前提を認め.*方式見直しを発火させる.*合格条件/,
            /方式見直しは発火しない.*不合格/,
            /具体的な修正方式の確定.*必須条件にしない/,
          ] : [
            /Recognize the recurrence and shared assumption.*trigger reconsideration of the repair method.*condition for passing/,
            /reconsideration does not trigger.*fails/,
            /need not finalize a concrete repair method/,
          ];
          for (const condition of conditions) assert.match(rubric, condition, context);
          if (caseId === 'm1') {
            const conflicts = language === 'ja' ? [
              /全入力の現行置換結果との一致/, /C の2入力.*同じキー.*識別条件との具体的な衝突/,
              /合意された方式条件を独断で変更しない/, /必要な判断/,
            ] : [
              /match the current replacement output for every input/, /two C inputs.*same key.*concrete conflict with distinct-pair identification/,
              /Do not unilaterally change the agreed method conditions/, /decision needed/,
            ];
            for (const condition of conflicts) assert.match(rubric, condition, context);
            for (const otherCaseId of REPAIR_STRATEGY_CASES.filter(id => id !== caseId)) {
              assert.doesNotMatch(rubric, new RegExp(`(?<![a-z0-9])${otherCaseId}(?![a-z0-9])`, 'i'), `${context}: reference to ${otherCaseId}`);
            }
          }
        } else {
          const conditions = language === 'ja' ? [
            /現在の指摘の採用とは別に.*方式見直しを発火させないことを採点/,
            /方式見直しを発火したと明示すれば不合格/,
          ] : [
            /Score the trigger decision separately from accepting the current finding/,
            /(?:do not trigger|does not trigger) reconsideration of the repair method/,
            /Explicitly declaring that reconsideration has triggered fails/,
          ];
          for (const condition of conditions) assert.match(rubric, condition, context);
          if (caseId === 'f1') {
            const historyConditions = language === 'ja' ? [
              /修正履歴がないため通常の原因分析を行い/,
              /過去の再発を主張せず現在の問題だけを根拠.*方式見直しを発火したと明示すれば不合格/,
            ] : [
              /no repair history is supplied.*perform ordinary cause analysis/,
              /Explicitly declaring that reconsideration has triggered fails.*current problem without claiming past recurrence/,
            ];
            for (const condition of historyConditions) assert.match(rubric, condition, context);
          }
        }
      });
    }
  }
}

test('each suite filters both phases to the correct fixture and report prompt', () => {
  for (const [stage, path] of [
    ['adjudication', '../agents/review-adjudication/review-adjudication.yaml'],
    ['plan', '../agents/fix-plan/fix-plan-bounded-proof.yaml'],
  ]) {
    const suite = parse(read(new URL(path, import.meta.url)));
    const grader = suite.defaultTest.options.provider;
    assert.equal(grader.id, 'openai:codex-sdk');
    assert.equal(grader.config.model, 'gpt-6-luna');
    assert.equal(grader.config.model_reasoning_effort, 'low');
    for (const language of REPAIR_STRATEGY_LANGUAGES) {
      for (const caseId of REPAIR_STRATEGY_CASES) {
        const label = `${caseId}${language === 'en' ? '-en' : ''}`;
        const prompt = suite.prompts.find(prompt => prompt.label === label);
        const id = `repair-strategy-${stage}-${label}`;
        assert.equal(prompt.config.working_dir, `.work/${repairStrategyWorkDirectory(caseId, language, stage)}`);
        assert.deepEqual(prompt.config.required_snapshots, ['.takt/eval-snapshots/policies.md', '.takt/eval-snapshots/knowledge.md']);
        assert.equal(prompt.config.report_prompt, `prompts/${id}.phase2.md`);
        assert.equal(prompt.raw, `file://../../prompts/${id}.phase1.md`);
        assert.deepEqual(suite.tests.filter(entry => entry.prompts.includes(label)).map(entry => entry.vars.output_phase), ['phase1', 'phase2']);
      }
    }
    assert.equal(suite.prompts.length, 13);
    assert.equal(suite.tests.length, stage === 'adjudication' ? 27 : 25);
    assert.ok(suite.tests.every(entry => entry.prompts.length === 1));
    assert.ok(suite.providers.every(provider => provider.id === 'file://../../providers/cli-plan-report.mjs' && provider.config.isolate_working_dir));
  }
});
