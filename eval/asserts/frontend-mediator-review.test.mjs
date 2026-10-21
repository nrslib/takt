import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';
import { assertions } from 'promptfoo';
import assertReview, { gradeDesign, parseReview, reviewPayload } from './frontend-mediator-review.mjs';
import { readProjectFiles } from './frontend-mediator-implement.mjs';
import { selectPromptEvalSuites } from '../suite-registry.mjs';

const evalDirectory = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = join(evalDirectory, 'fixtures/frontend-mediator-review');
const suite = parse(readFileSync(join(evalDirectory, 'agents/frontend-review/frontend-mediator-review.yaml'), 'utf8'));

test('format distinguishes raw JSON, one fence and prose while design parsing uses the same object', () => {
  const review = { verdict: 'REJECT', findings: [{
    file: 'page.tsx:1', blocking: true, reason: '文字列中の { "値": "\\" } と改行\nも扱う',
  }] };
  const json = JSON.stringify(review);
  for (const [output, format] of [
    [`  ${json}\n`, 'json'],
    [`\`\`\`json\n${json}\n\`\`\``, 'fenced'],
    [`\`\`\`\n${json}\n\`\`\``, 'fenced'],
    [`確認結果です。\n${json}`, 'prose'],
    [`確認結果です。\n\`\`\`json\n${json}\n\`\`\`\n以上です。`, 'prose'],
    [`${json}\n以上です。`, 'prose'],
  ]) {
    assert.deepEqual(parseReview(output), review);
    assert.equal(reviewPayload(output).format, format);
    assert.equal(assertReview(output).pass, format === 'json');
    assert.equal(assertReview(output).reason, `Review format: ${format}`);
  }
});

test('design metrics use only one validated JSON object and preserve rubric configuration through the assertion loader', async t => {
  const json = JSON.stringify({ verdict: 'APPROVE', findings: [] });
  const grader = { id: () => 'mock-grader', callApi: () => assert.fail('No API calls') };
  const grade = t.mock.method(assertions, 'matchesLlmRubric', async (rubric, output, options, vars) => {
    assert.equal(output, json);
    assert.equal(rubric, suite.tests[3].assert[0].config.rubric);
    assert.equal(options.provider, grader);
    assert.deepEqual(vars, { task: 'test task' });
    return { pass: true, score: 1, reason: 'mock semantic grade' };
  });
  for (const output of [json, `\`\`\`json\n${json}\n\`\`\``, `前置き\n${json}\n後置き`, `前置き { "未完了\n${json}`]) {
    const result = await assertions.runAssertion({
      assertion: {
        ...suite.tests[3].assert[0],
        value: `file://${join(evalDirectory, 'asserts/frontend-mediator-review.mjs')}`,
      },
      prompt: 'review', provider: grader,
      test: { options: { provider: grader }, vars: { task: 'test task' } },
      providerResponse: { output },
    });
    assert.equal(result.pass, true);
  }
  assert.equal(grade.mock.callCount(), 4);
});

test('extracts one review after unmatched braces or unrelated JSON without counting braces in strings', () => {
  const review = { verdict: 'REJECT', findings: [{
    file: 'page.tsx:1', blocking: true,
    reason: '文字列内の } { と引用符 "、末尾のバックスラッシュ \\',
  }] };
  const json = JSON.stringify(review);
  for (const prefix of ['前置き {\n', '前置き { "未完了\n', '{}\n', '{"metadata":{"count":1}}\n']) {
    const output = `${prefix}${json}`;
    assert.deepEqual(parseReview(output), review);
    assert.equal(reviewPayload(output).format, 'prose');
    assert.equal(assertReview(output).pass, false);
  }
  assert.deepEqual(parseReview(JSON.stringify({ result: review })), review);
  assert.throws(() => parseReview(JSON.stringify({ first: review, second: review })), /found 2/);
  assert.throws(() => parseReview(`前置き {\n${json}\n${json}`), /found 2/);
  assert.throws(() => parseReview('{"metadata":{},"verdict":"APPROVE"}'), /found 0/);
});

test('counts malformed review shapes as candidates and ignores review-shaped text inside strings', () => {
  const review = { verdict: 'APPROVE', findings: [] };
  const json = JSON.stringify(review);
  assert.deepEqual(parseReview(JSON.stringify({ ...review, note: json })), { ...review, note: json });
  assert.deepEqual(parseReview(`${JSON.stringify({ note: json })}\n${json}`), review);
  assert.throws(() => parseReview(`{"verdict":null,"findings":null}\n${json}`), /found 2/);
});

test('design fails closed without a grader for zero, multiple, malformed or contradictory objects', async () => {
  const json = JSON.stringify({ verdict: 'APPROVE', findings: [] });
  for (const output of [
    '', 'APPROVE', '{invalid}', '{}',
    `${json}\n${json}`, `\`\`\`json\n${json}\n\`\`\`\n${json}`,
    `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
    '{"verdict":"REJECT","findings":[]}',
  ]) {
    const result = await gradeDesign(output, {});
    assert.equal(result.pass, false, output);
    assert.equal(result.score, 0);
    assert.equal(assertReview(output).pass, false);
  }
});

test('accepts valid reviews without making vocabulary a condition of structural grading', () => {
  for (const verdict of ['APPROVE', 'REJECT']) {
    const output = JSON.stringify({ verdict, findings: verdict === 'APPROVE' ? [] : [{
      file: 'src/routes/order-edit.tsx:1', blocking: true,
      reason: '状態の所有元へ全て委譲しており、画面自身の判断がない。画面へ戻す必要がある。',
    }] });
    assert.equal(assertReview(output).pass, true);
    assert.equal(assertReview(`\`\`\`json\n${output}\n\`\`\``).pass, false);
    assert.equal(parseReview(output).verdict, verdict);
  }
});

test('format assertion leaves unrelated rejection and optional placement suggestions to semantic grading', () => {
  for (const review of [
    { verdict: 'REJECT', findings: [{ file: 'view.tsx:1', blocking: true, reason: '入力ラベルの不備' }] },
    { verdict: 'APPROVE', findings: [{ file: 'view.tsx:1', blocking: false, reason: '別の層への分離も検討可能' }] },
  ]) assert.equal(assertReview(JSON.stringify(review)).pass, true);
});

for (const output of [
  '', 'APPROVE', '{}', 'null', '[]',
  '{"verdict":"APPROVE","findings":[{"blocking":true,"file":"a","reason":"x"}]}',
  '{"verdict":"REJECT","findings":[]}',
  '{"verdict":"REJECT","findings":[{"blocking":"true","file":"a","reason":"x"}]}',
  '{"verdict":"REJECT","findings":[{"blocking":true,"file":"a","reason":""}]}',
  'before {"verdict":"APPROVE","findings":[]}',
]) {
  test(`rejects malformed or contradictory review: ${output}`, () => {
    assert.equal(assertReview(output).pass, false);
  });
}

test('registration binds each case to exactly one isolated prompt and keeps grading outside fixtures', () => {
  const registered = selectPromptEvalSuites({ names: ['frontend-mediator-review'] })[0];
  assert.equal(registered.tier, 'active');
  assert.equal(registered.execution.defaultEligible, false);
  assert.deepEqual(registered.execution.credentials, ['codex', 'claude']);
  assert.deepEqual(registered.prepareTargets, ['good', 'bad', 'bad2', 'good-hook'].map(v => `frontend-mediator-review-${v}`));
  assert.deepEqual(suite.providers.map(p => [p.label, p.config.model]), [
    ['codex-luna-max', 'gpt-5.6-luna'], ['claude-opus-5', 'claude-opus-5'],
  ]);
  assert.ok(suite.providers.every(p => p.config.isolate_working_dir === true));
  assert.equal(suite.defaultTest.assert[0].metric, 'frontend-mediator-review/format');
  assert.equal(suite.defaultTest.assert[0].value, 'file://../../asserts/frontend-mediator-review.mjs');
  for (const [index, variant] of ['good', 'bad', 'bad2', 'good-hook'].entries()) {
    assert.deepEqual(suite.tests[index].prompts, [variant]);
    assert.equal(suite.prompts[index].config.working_dir, `.work/frontend-mediator-review-${variant}`);
    assert.equal(suite.tests[index].assert[0].value, 'file://../../asserts/frontend-mediator-review.mjs');
    assert.ok(suite.tests[index].assert[0].config.rubric.startsWith('見出し・文言ではなく実質で判定する。'));
    const files = readProjectFiles(join(fixtureRoot, variant));
    assert.ok(Object.keys(files).every(path => !path.includes('node_modules') && !path.includes('dist/')));
    assert.ok(Object.keys(files).every(path => !/rubric|expected|good|bad/.test(path)));
    for (const source of Object.values(files)) assert.doesNotMatch(source, /TODO|FIXME|これは別層/);
  }
  for (const value of Object.values(suite.defaultTest.vars)) {
    const source = readFileSync(join(evalDirectory, value.replace('file://../../', '')), 'utf8');
    assert.doesNotMatch(source, /Mediator|controller|store|置き場所|APPROVE.*good|REJECT.*bad/i);
  }
});

for (const variant of ['good', 'bad', 'bad2', 'good-hook']) {
  test(`${variant} reviewed sources compile with strict and unused-code checks`, () => {
    const directory = join(fixtureRoot, variant);
    const config = ts.readConfigFile(join(directory, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
    const program = ts.createProgram(parsed.fileNames.filter(path => !path.endsWith('/src/main.tsx')), {
      ...parsed.options, noUnusedLocals: true, noUnusedParameters: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => directory, getNewLine: () => '\n',
    }));
  });
}

test('all variants share API, domain calculations and display/region components', () => {
  const good = readProjectFiles(join(fixtureRoot, 'good'));
  for (const variant of ['bad', 'bad2', 'good-hook']) {
    const files = readProjectFiles(join(fixtureRoot, variant));
    for (const [path, source] of Object.entries(good)) {
      if (path !== 'src/routes/order-edit.tsx') assert.equal(files[path], source, `${variant}/${path}`);
    }
  }
});

test('all pages show the same alert for a missing product instead of throwing during rendering', () => {
  const data = {
    customers: [{ id: 'a', name: 'A', priceGroup: 'standard' }], products: [],
    saved: { id: '42', customerId: 'a', lines: [{ productId: 'missing', quantity: 1 }] },
    draft: { id: '42', customerId: 'a', lines: [{ productId: 'missing', quantity: 1 }] },
  };
  const pages = [];
  for (const variant of ['good', 'bad', 'bad2', 'good-hook']) {
    const exports = {};
    const state = [data, null, { kind: 'idle' }, null];
    const compiled = ts.transpileModule(readFileSync(join(fixtureRoot, variant, 'src/routes/order-edit.tsx'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    runInNewContext(compiled, { exports, require: specifier => {
      if (specifier === 'react') return {
        useState: () => [state.shift(), () => {}], useRef: () => ({ current: false }),
        useCallback: fn => fn, useEffect: () => {},
      };
      if (specifier === 'react/jsx-runtime') return {
        jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
      };
      if (specifier.includes('use-order-edit-')) return new Proxy({}, {
        get: () => () => ({ data, error: null, saveStatus: { kind: 'idle' }, inputError: null }),
      });
      return {};
    } });
    const page = exports.OrderEditPage({ orderId: '42' });
    assert.equal(page.props.children.props.role, 'alert');
    assert.equal(page.props.children.props.children.at(-1), 'missing');
    pages.push(JSON.stringify(page));
  }
  assert.equal(new Set(pages).size, 1);
});

test('page-specific hook preserves edits, save acceptance for button and keyboard, retry and confirmed-order state', async () => {
  const slots = [];
  const pendingEffects = [];
  const listeners = new Map();
  let cursor = 0;
  const react = {
    useReducer: (reducer, initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], event => { slots[index] = reducer(slots[index], event); }];
    },
    useRef: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: fn => fn,
    useEffect: (effect, dependencies) => {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const calls = [];
  let resolveSave;
  let rejectSave;
  const order = { id: '42', customerId: 'a', lines: [{ productId: 'p', quantity: 1 }] };
  const api = {
    getOrder: async () => order, getCustomers: async () => [], getProducts: async () => [],
    saveOrder: draft => {
      calls.push(draft);
      return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
    },
  };
  const exports = {};
  const path = join(fixtureRoot, 'good-hook/src/routes/use-order-edit-page.ts');
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports, window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: name => listeners.delete(name),
    },
    require: specifier => {
      if (specifier === 'react') return react;
      if (specifier.endsWith('/api')) return api;
      return loadModule(join(dirname(path), `${specifier}.ts`), api);
    },
  });
  const render = () => {
    cursor = 0;
    const result = exports.useOrderEditPage('42');
    for (const effect of pendingEffects.splice(0)) effect();
    return result;
  };
  assert.equal(render().data, null);
  await new Promise(resolve => setImmediate(resolve));
  let page = render();
  page.requestSave();
  assert.equal(calls.length, 0);
  page.handleAddLine('p', '2');
  page = render();
  assert.equal(page.data.draft.lines[0].quantity, 3);
  page.handleChangeQuantity('p', '0');
  assert.ok(render().inputError);
  page.handleSelectCustomer('b');
  page = render();
  page.requestSave();
  listeners.get('keydown')({ ctrlKey: true, key: 's', preventDefault() {} });
  page.handleSelectCustomer('c');
  page.handleChangeQuantity('p', '9');
  page.handleRemoveLine('p');
  assert.equal(calls.length, 1);
  page = render();
  assert.equal(page.data.draft.customerId, 'b');
  assert.equal(page.data.draft.lines[0].quantity, 3);
  assert.equal(page.saveStatus.kind, 'saving');
  rejectSave(new Error('save failed'));
  await new Promise(resolve => setImmediate(resolve));
  page = render();
  assert.equal(page.saveStatus.kind, 'failed');
  assert.equal(page.data.draft.customerId, 'b');
  listeners.get('keydown')({ ctrlKey: true, key: 's', preventDefault() {} });
  assert.equal(calls.length, 2);
  const confirmed = { ...calls[1], id: 'confirmed' };
  resolveSave(confirmed);
  await new Promise(resolve => setImmediate(resolve));
  page = render();
  assert.equal(page.data.saved, confirmed);
  assert.equal(page.data.draft, confirmed);
  assert.equal(page.saveStatus.kind, 'saved');
  page.requestSave();
  assert.equal(calls.length, 2);
  for (const slot of slots) slot?.cleanup?.();
  assert.equal(listeners.size, 0);
});

// Exercise the real fixture's external-state owner; no network or React renderer is needed.
function loadModule(path, api) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require: specifier => specifier === './api' ? api : loadModule(join(dirname(path), `${specifier}.ts`), api),
  });
  return exports;
}

for (const [variant, name] of [['bad', 'Mediator'], ['bad2', 'Session']]) {
  test(`${variant} preserves save guards, edit rejection, retry and confirmed-order behavior`, async () => {
    const order = { id: '42', customerId: 'a', lines: [{ productId: 'p', quantity: 1 }] };
    const calls = [];
    let resolveSave;
    let rejectSave;
    const api = {
      getOrder: async () => order, getCustomers: async () => [], getProducts: async () => [],
      saveOrder: value => {
        calls.push(JSON.parse(JSON.stringify(value)));
        return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
      },
    };
    const Class = loadModule(join(fixtureRoot, variant, `src/features/orders/order-edit-${name.toLowerCase()}.ts`), api)[`OrderEdit${name}`];
    const editor = new Class();
    let notifications = 0;
    const unsubscribe = editor.subscribe(() => notifications++);
    const cleanup = editor.load('42');
    await new Promise(resolve => setImmediate(resolve));
    editor.requestSave();
    assert.equal(calls.length, 0);
    editor.handleAddLine('p', '2');
    assert.equal(editor.getSnapshot().data.draft.lines[0].quantity, 3);
    editor.handleChangeQuantity('p', '0');
    assert.ok(editor.getSnapshot().inputError);
    assert.equal(editor.getSnapshot().data.draft.lines[0].quantity, 3);
    editor.handleSelectCustomer('b');
    editor.requestSave();
    editor.requestSave();
    editor.handleSelectCustomer('c');
    editor.handleChangeQuantity('p', '9');
    editor.handleRemoveLine('p');
    assert.equal(calls.length, 1);
    assert.equal(editor.getSnapshot().data.draft.customerId, 'b');
    assert.equal(editor.getSnapshot().data.draft.lines[0].quantity, 3);
    rejectSave(new Error('save failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(editor.getSnapshot().saveStatus.kind, 'failed');
    assert.equal(editor.getSnapshot().data.draft.customerId, 'b');
    editor.requestSave();
    assert.equal(calls.length, 2);
    const confirmed = { ...calls[1], id: 'confirmed' };
    resolveSave(confirmed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(editor.getSnapshot().data.saved, confirmed);
    assert.equal(editor.getSnapshot().data.draft, confirmed);
    editor.requestSave();
    assert.equal(calls.length, 2);
    editor.handleChangeQuantity('p', '4');
    editor.handleChangeQuantity('p', '3');
    editor.requestSave();
    assert.equal(calls.length, 2);
    assert.ok(notifications > 0);
    unsubscribe(); cleanup();
  });
}
