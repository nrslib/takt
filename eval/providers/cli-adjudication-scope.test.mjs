import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import ScopeProvider, { scopeTrace } from './cli-adjudication-scope.mjs';
import { promptEvalPrepareTargets, selectPromptEvalSuites } from '../suite-registry.mjs';
import { InstructionBuilder } from '../../dist/core/workflow/instruction/InstructionBuilder.js';
import { renderTaskReviewScope } from '../../dist/core/workflow/review-scope.js';
import { resolveRefToContent } from '../../dist/infra/config/loaders/resource-resolver.js';
import { resolveWorkflowWideRules } from '../../dist/infra/config/loaders/workflowAllStepsRuleResolver.js';

const fixture = fileURLToPath(new URL('../fixtures/adjudication-scope/input-external/', import.meta.url));

test('scope fixtures reproduce the recorded observations and inherited verification against the current code', async t => {
  const fixturesRoot = new URL('../fixtures/adjudication-scope/', import.meta.url);
  const cases = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'en');
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const result = spawnSync(process.execPath, ['--test', 'evidence.test.mjs'], {
        cwd: fileURLToPath(new URL(`${entry.name}/`, fixturesRoot)),
        encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
    });
  }
});

for (const language of ['ja', 'en']) {
  test(`${language}: changed-target scope is composed into initial and follow-up specialist reviews and kept out of adjudication, verification and final gate`, () => {
    const resourceRoot = fileURLToPath(new URL(`../../builtins/${language}/`, import.meta.url));
    const facetContext = { lang: language, resourceRoot };
    const reviewScope = {
      kind: 'collected',
      paths: ['docs/unrelated-changed-contract.md'],
      source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
    };
    const context = {
      cwd: fixture, projectCwd: fixture, language,
      task: 'Adjudicate supplied findings.', userInputs: [],
      iteration: 1, stepIteration: 2, maxSteps: 10, reviewScope,
      workflowRules: resolveWorkflowWideRules(['findings-handling'], fixture, language, undefined, resourceRoot),
    };
    const instructionsRoot = join(resourceRoot, 'facets/instructions');
    const reviewerNames = readdirSync(instructionsRoot).filter(name => name.endsWith('.md')).filter(name =>
      (name.startsWith('follow-up-') && name.endsWith('-review.md')) ||
      readFileSync(join(instructionsRoot, name), 'utf8').includes('{{include:instructions/review-investigation-discipline}}'));
    assert.ok(reviewerNames.length > 0);
    const resolveInstruction = name => resolveRefToContent(name, undefined, join(resourceRoot, 'workflows'), 'instructions', facetContext);
    const build = name => {
      const instruction = resolveInstruction(name);
      assert.equal(typeof instruction, 'string');
      return new InstructionBuilder({ name, instruction, passPreviousResponse: false }, context).build();
    };
    const scopeBlock = renderTaskReviewScope(reviewScope, language);
    for (const name of reviewerNames) {
      const prompt = build(name.replace(/\.md$/, ''));
      assert.equal(prompt.split(scopeBlock).length - 1, 1, name);
    }
    const alternateScope = { ...reviewScope, paths: ['src/another-unrelated-change.mjs'] };
    for (const name of ['adjudicate-review-findings', 'verify-fix', 'supervise-review-resolution', 'review-remediation-problem-tracking']) {
      const prompt = build(name);
      assert.ok(!prompt.includes(reviewScope.paths[0]), name);
      // Compare whole prompts to detect any use of the changed-target set, not just one sentence.
      const instruction = resolveInstruction(name);
      assert.equal(prompt, new InstructionBuilder(
        { name, instruction, passPreviousResponse: false },
        { ...context, reviewScope: alternateScope },
      ).build(), name);
    }
  });
}

function events(cli, answer, tools = [], sessionId = 'scope-session') {
  if (cli === 'codex') return [
    { type: 'thread.started', thread_id: sessionId },
    ...tools.map((tool, index) => ({ type: 'item.completed', item: {
      id: `tool-${index}`, type: 'command_execution', command: tool.input,
      aggregated_output: tool.output, status: 'completed',
    } })),
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: answer } },
    { type: 'turn.completed' },
  ];
  return [
    { type: 'system', session_id: sessionId },
    ...tools.flatMap((tool, index) => [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: { command: tool.input } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: tool.output }] } },
    ]),
    { type: 'result', session_id: sessionId, subtype: 'success', result: answer },
  ];
}
const rawEvents = (...args) => events(...args).map(event => JSON.stringify(event)).join('\n');

for (const cli of ['codex', 'claude']) {
  test(`${cli}: records actual returned content, phase/session/tool identity and repeated reads`, () => {
    const command = 'cat src/reader.mjs';
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: fixture, encoding: 'utf8', env: { PATH: process.env.PATH },
      timeout: 5000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 0, result.stderr);
    const tools = [{ input: command, output: result.stdout }, { input: command, output: result.stdout }];
    const trace = scopeTrace(rawEvents(cli, '裁定', tools), cli, 'phase1');
    assert.equal(trace.phase, 'phase1');
    assert.equal(trace.sessionId, 'scope-session');
    assert.equal(trace.answer, '裁定');
    assert.deepEqual(trace.tools.map(tool => tool.output), [result.stdout, result.stdout]);
    assert.deepEqual(trace.tools.map(tool => tool.id), ['tool-0', 'tool-1']);
    assert.deepEqual(trace.tools.map(tool => tool.repeated), [false, true]);
    assert.deepEqual(trace.tools[0].categories, ['code']);
    assert.equal(trace.tools[0].bytes, Buffer.byteLength(result.stdout));
    assert.equal(trace.tools[0].characters, result.stdout.length);
    assert.deepEqual(trace.returnedByCategory.code, { characters: result.stdout.length * 2, bytes: Buffer.byteLength(result.stdout) * 2 });
    const noRead = scopeTrace(rawEvents(cli, '全て読んだ'), cli, 'phase1');
    assert.deepEqual(noRead.tools, [], 'self-report cannot produce read evidence');
    assert.throws(() => scopeTrace('', cli, 'phase1'));
    assert.throws(() => scopeTrace(rawEvents(cli, '裁定', [{ input: command, output: 'Warning: truncated output' }]), cli, 'phase1'));
    assert.throws(() => scopeTrace(events(cli, '裁定').slice(0, -1).map(e => JSON.stringify(e)).join('\n'), cli, 'phase1'));
  });

  for (const failure of [undefined, 'missing-events', 'phase2-failure', 'different-session', 'mismatched-answer']) {
    test(`${cli}: two phases preserve real analysis and fail closed for ${failure ?? 'successful receipts'}`, async t => {
      const artifactRoot = mkdtempSync(join(tmpdir(), 'takt-scope-provider-'));
      t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
      let cleaned = false;
      let sessions = 0;
      const prompts = [];
      const provider = new ScopeProvider({ config: { cli, model: 'offline', working_dir: 'selected', isolate_working_dir: true, report_prompt: 'prompts/scope.md' } }, {
        artifactRoot,
        prepareWorkspace: () => ({ sourceDirectory: '/source', cwd: '/isolated', cleanup() { cleaned = true; } }),
        readPrompt: () => '/source {{task}} {{previous_response}}',
        createSession: (_config, callbacks) => {
          sessions++;
          assert.equal(callbacks.cwd, '/isolated');
          return { run: async prompt => {
            prompts.push(prompt);
            const phase = prompts.length;
            if (phase === 2 && failure === 'phase2-failure') throw new Error('interrupted');
            const answer = phase === 1 ? 'actual analysis' : 'actual report';
            if (failure !== 'missing-events') callbacks.onOutput({
              stdout: rawEvents(cli, answer, [], phase === 2 && failure === 'different-session' ? 'new-session' : 'scope-session'), stderr: '',
            });
            return failure === 'mismatched-answer' ? 'unrecorded answer' : answer;
          } };
        },
      });
      const result = await provider.callApi('/source analysis prompt', { vars: { task: 'task', previous_response: 'seeded answer' } });
      assert.equal(cleaned, true);
      assert.equal(sessions, 1);
      if (failure) {
        assert.equal(typeof result.error, 'string');
        assert.equal(result.output, undefined);
        assert.equal(readFileSync(join(result.metadata.artifactDirectory, 'error.txt'), 'utf8'), result.error);
      } else {
        const output = JSON.parse(result.output);
        assert.deepEqual(prompts, ['/isolated analysis prompt', '/isolated task actual analysis']);
        assert.deepEqual(output.traces.map(trace => trace.phase), ['phase1', 'phase2']);
        assert.equal(output.analysis, 'actual analysis');
        assert.equal(output.report, 'actual report');
        assert.equal(output.initialPrompt, '/isolated analysis prompt');
        assert.equal(readFileSync(join(result.metadata.artifactDirectory, 'report.md'), 'utf8'), output.report);
      }
    });
  }
}

test('registered scope suite prepares both real phases for each isolated language and fixture', () => {
  const suite = parse(readFileSync(new URL('../agents/review-adjudication/adjudication-scope.yaml', import.meta.url), 'utf8'));
  const targets = promptEvalPrepareTargets(selectPromptEvalSuites({ names: ['adjudication-scope'] }));
  assert.deepEqual(targets, suite.prompts.map(prompt => prompt.label));
  const caseIds = readdirSync(new URL('../fixtures/adjudication-scope/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'en').map(entry => entry.name);
  assert.deepEqual(new Set(suite.prompts.map(prompt => prompt.label)),
    new Set(caseIds.flatMap(caseId => ['ja', 'en'].map(language => `adjudication-scope-${caseId}-${language}`))));
  assert.deepEqual(suite.tests.flatMap(entry => entry.prompts), suite.prompts.map(prompt => prompt.label));
  for (const provider of suite.providers) assert.equal(provider.config.isolate_working_dir, true);
  const prepare = spawnSync(process.execPath, ['eval/scripts/prepare.mjs', ...targets], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8',
    timeout: 60000, killSignal: 'SIGKILL',
  });
  assert.equal(prepare.status, 0, prepare.stderr + prepare.stdout);
  for (const prompt of suite.prompts) {
    const [, caseId, language] = /^adjudication-scope-(.+)-(ja|en)$/.exec(prompt.label);
    const fixtureRoot = new URL(`../fixtures/adjudication-scope/${caseId}/`, import.meta.url);
    const workRoot = new URL(`../${prompt.config.working_dir}/`, import.meta.url);
    const fixtureFiles = readdirSync(fixtureRoot, { recursive: true })
      .filter(path => /\.(?:md|mjs|json)$/.test(path));
    for (const path of fixtureFiles) {
      const isDocument = path.endsWith('.md');
      const source = language === 'en' && isDocument
        ? new URL(`../fixtures/adjudication-scope/en/${caseId}/${path}`, import.meta.url)
        : new URL(path, fixtureRoot);
      const prepared = readFileSync(new URL(path, workRoot), 'utf8');
      assert.equal(prepared, readFileSync(source, 'utf8'), `${prompt.label}/${path}`);
      if (language === 'en' && isDocument) {
        assert.doesNotMatch(prepared, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, `${prompt.label}/${path}`);
        const original = readFileSync(new URL(path, fixtureRoot), 'utf8');
        const references = text => [...text.matchAll(/(?:src|history|docs)\/[a-z0-9./-]+|\b(?:SEC|CODE|P)-[A-Z]+\b|sha256=[a-f0-9]+/g)]
          .map(match => match[0].replace(/\.$/, '')).sort();
        assert.deepEqual(references(prepared), references(original), `${prompt.label}/${path}: IDs and references`);
      }
      if (path.startsWith('reports-seed/')) {
        assert.equal(readFileSync(new URL(path.replace('reports-seed/', '.takt/runs/eval/reports/'), workRoot), 'utf8'), prepared);
      }
    }
    const review = readFileSync(new URL('reports-seed/coding-review.md', workRoot), 'utf8');
    const concernsContract = readFileSync(new URL(
      `../../builtins/${language}/facets/partials/output-contracts/base-review-non-finding-concerns.md`, import.meta.url,
    ), 'utf8').split('\n');
    const concerns = review.split(`${concernsContract[0]}\n`)[1]?.split(/^## /m)[0];
    assert.ok(concerns, `${prompt.label}: non-finding concerns section`);
    const table = concerns.trim().split('\n');
    assert.equal(table.length, 3, `${prompt.label}: one concern in a table`);
    const cells = row => row.split('|').slice(1, -1).map(cell => cell.trim());
    assert.deepEqual(cells(table[0]), cells(concernsContract[1]), `${prompt.label}: contract columns`);
    assert.equal(cells(table[1]).length, 4);
    assert.ok(cells(table[1]).every(cell => /^-+$/.test(cell)));
    const row = cells(table[2]);
    assert.equal(row.length, 4);
    assert.ok(row.every(cell => cell.length > 0));
    assert.equal(row[1], '`src/catalog-label.mjs:1`');
    assert.equal(row[2], 'no_issue_after_verification', `${prompt.label}: not a carry-forward`);
    assert.match(row[3], /\bhistory\/round-0\/catalog-plan\.md\b/);
    if (language === 'en') {
      for (const heading of ['## Current Iteration Findings (new)', '## Resolved Findings (resolved)', '## Non-Finding Concerns']) {
        const contract = heading === '## Non-Finding Concerns'
          ? '../../builtins/en/facets/partials/output-contracts/base-review-non-finding-concerns.md'
          : '../../builtins/en/facets/output-contracts/coding-review.md';
        assert.ok(readFileSync(new URL(contract, import.meta.url), 'utf8').includes(heading));
        assert.ok(review.includes(heading));
      }
      const scenario = suite.tests.find(entry => entry.prompts.includes(prompt.label));
      assert.equal(typeof scenario.vars.task, 'string');
      assert.doesNotMatch(scenario.vars.task, /\p{Script=Han}/u);
    }
    const phase1 = readFileSync(new URL(`../prompts/${prompt.label}.phase1.md`, import.meta.url), 'utf8');
    const phase2 = readFileSync(new URL(`../${prompt.config.report_prompt}`, import.meta.url), 'utf8');
    assert.ok(phase1.includes('{{task}}'));
    assert.ok(phase2.includes('{{previous_response}}'));
    const resourceRoot = fileURLToPath(new URL(`../../builtins/${language}/`, import.meta.url));
    for (const [index, snapshot] of prompt.config.required_snapshots.entries()) {
      const full = readFileSync(new URL(`../${prompt.config.working_dir}/${snapshot}`, import.meta.url), 'utf8');
      const kind = ['policies', 'knowledge'][index];
      const expected = resolveRefToContent('review-adjudication', undefined, join(resourceRoot, 'workflows'), kind, { lang: language, resourceRoot });
      assert.equal(full, expected, `${prompt.label}: only adjudication ${kind}`);
      assert.ok(phase1.includes(full.length > 2000 ? snapshot : full));
    }
    for (const report of ['coding-review.md', 'review-resolution.md', 'fix-verification.md']) {
      assert.ok(readFileSync(new URL(`../${prompt.config.working_dir}/.takt/runs/eval/reports/${report}`, import.meta.url), 'utf8'));
    }
  }
});
