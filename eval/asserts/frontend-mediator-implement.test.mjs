import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import assertArtifacts, { inspectFrontendArtifacts, readProjectFiles } from './frontend-mediator-implement.mjs';
import FrontendMediatorCoderProvider from '../providers/frontend-mediator-coder.mjs';
import { MAX_RUBRIC_CHARACTERS } from '../providers/frontend-mediator-coder.mjs';
import { promptEvalPrepareTargets, selectPromptEvalSuites } from '../suite-registry.mjs';

const artifactRoots = [];
test.afterEach(() => {
  for (const root of artifactRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TestCoderProvider extends FrontendMediatorCoderProvider {
  constructor(options) {
    const artifactRoot = join(tmpdir(), `takt-coder-test-results-${randomUUID()}`);
    super({ ...options, artifactRoot });
    artifactRoots.push(artifactRoot);
  }
}

const fixtureDirectory = fileURLToPath(new URL('../fixtures/frontend-mediator/', import.meta.url));
const evalDirectory = fileURLToPath(new URL('../', import.meta.url));
const pagePath = 'src/routes/order-edit.tsx';

// These mutations isolate architecture; the full editing behavior is judged during real evals.
const pageOwned = `import { useEffect, useRef, useState } from 'react';
import { getOrder, saveOrder } from '../features/orders/api';
import type { Order } from '../features/orders/types';
export function OrderEditPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [saved, setSaved] = useState<Order | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const dirty = JSON.stringify(order) !== JSON.stringify(saved);
  useEffect(() => {
    let active = true;
    getOrder(orderId).then(value => {
      if (active) { setOrder(value); setSaved(value); }
    }).catch(() => { if (active) setMessage('読み込み失敗'); });
    return () => { active = false; };
  }, [orderId]);
  async function save() {
    if (inFlight.current || !dirty || !order) return;
    inFlight.current = true;
    setSaving(true);
    setMessage('保存中');
    try {
      const result = await saveOrder(order);
      setOrder(result); setSaved(result); setMessage('保存しました');
    } catch { setMessage('保存失敗'); }
    finally { inFlight.current = false; setSaving(false); }
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault(); void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, saved]);
  return <main>
    <input aria-label="顧客ID" disabled={saving || !order} value={order?.customerId ?? ''}
      onChange={e => { if (order) setOrder({ ...order, customerId: e.target.value }); }} />
    <button disabled={saving || !dirty} onClick={() => void save()}>保存</button>
    <p role="status">{message}</p>
  </main>;
}`;

function mutation(t, files) {
  const directory = mkdtempSync(join(tmpdir(), 'takt-frontend-mutation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(fixtureDirectory, directory, { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), source);
  }
  return directory;
}

test('accepts page-owned state and save guards for both operation entrances', t => {
  assert.equal(inspectFrontendArtifacts(mutation(t, { [pagePath]: pageOwned })).pass, true);
});

for (const path of [
  'src/routes/order-edit.test.tsx', 'src/features/orders/api.spec.ts',
  'src/test-setup.ts', 'src/test-setup/index.ts', 'src/setupTests.ts',
  'src/__tests__/order-mediator.ts', 'tests/order-mediator.ts',
]) {
  test(`accepts test-only classes and Mediator identifiers in ${path}`, t => {
    const directory = mutation(t, {
      [pagePath]: pageOwned,
      [path]: 'class FakeOrderApi { calls = 0; save() { this.calls++; } } const fakeMediator = new FakeOrderApi();',
    });
    assert.equal(inspectFrontendArtifacts(directory).pass, true);
  });
}

test('test helpers do not exempt production classes elsewhere', t => {
  const result = inspectFrontendArtifacts(mutation(t, {
    [pagePath]: pageOwned,
    'src/test-setup.ts': 'class FakeOrderApi { calls = 0; }',
    'src/features/orders/session.ts': 'class OrderSession { saving = false; subscribe(listener) { return attach(listener); } }',
  }));
  assert.equal(result.pass, false);
  assert.match(result.reason, /session.ts: non-React class/);
});

test('rubric receives only changed source/config files, excluding dependencies, locks and generated output', async t => {
  const source = mutation(t, {});
  const provider = new TestCoderProvider({ config: { working_dir: relative(evalDirectory, source) } });
  provider.runAgent = async (_prompt, cwd) => {
    for (const [path, content] of Object.entries({
      [pagePath]: pageOwned,
      'src/added.ts': 'export const added = true;',
      'vite.config.ts': 'export default {};',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'package.json': '{"name":"changed"}',
      'src/deleted.ts': undefined,
      'node_modules/pkg/index.js': 'x'.repeat(300_000),
      'src/node_modules/pkg/index.js': 'x'.repeat(300_000),
      'dist/output.js': 'x'.repeat(300_000),
      'src/build/output.js': 'x'.repeat(300_000),
      'package-lock.json': 'x'.repeat(5_800_000),
      'src/output.js.map': 'x'.repeat(300_000),
      'tsconfig.tsbuildinfo': 'x'.repeat(300_000),
      'notes.md': 'agent notes',
    })) {
      if (content === undefined) { rmSync(join(cwd, path)); continue; }
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    return { output: 'completed' };
  };
  writeFileSync(join(source, 'src/deleted.ts'), 'export const removed = true;');
  const result = await provider.callApi('work', {});
  assert.equal(result.error, undefined);
  const output = JSON.parse(result.output);
  assert.deepEqual(Object.keys(output.files).sort(), [
    'package.json', 'src/added.ts', pagePath, 'tsconfig.json', 'vite.config.ts',
  ].sort());
  assert.deepEqual(output.deletedPaths, ['src/deleted.ts']);
  assert.ok(output.changedPaths.includes('src/deleted.ts'));
  assert.equal(output.files['src/features/orders/api.ts'], undefined);
  assert.ok(result.output.length < MAX_RUBRIC_CHARACTERS);
});

test('rubric overflow fails explicitly while preserving the project artifact', async t => {
  const source = mutation(t, {});
  const provider = new TestCoderProvider({ config: { working_dir: relative(evalDirectory, source) } });
  provider.runAgent = async (_prompt, cwd) => {
    writeFileSync(join(cwd, 'src/large.ts'), 'x'.repeat(MAX_RUBRIC_CHARACTERS));
    return { output: 'completed' };
  };
  const result = await provider.callApi('work', {});
  assert.match(result.error, /Rubric input exceeds 200000 characters/);
  assert.equal(result.output, undefined);
  assert.ok(existsSync(join(result.metadata.artifactDirectory, 'project/src/large.ts')));
});

test('accepts a page-specific custom hook called once directly by the page', t => {
  const hook = pageOwned.replace('export function OrderEditPage', 'export function useOrderEditor')
    .replace(/  return <main>[\s\S]*$/, '  return { order, saving, dirty, message, save };\n}');
  const directory = mutation(t, {
    'src/routes/use-order-editor.ts': hook,
    [pagePath]: `import { useOrderEditor } from './use-order-editor';
export function OrderEditPage({ orderId }: { orderId: string }) {
  const { save, saving, dirty } = useOrderEditor({ orderId });
  return <button disabled={saving || !dirty} onClick={() => void save()}>保存</button>;
}`,
  });
  assert.equal(inspectFrontendArtifacts(directory).pass, true);
});

test('accepts useReducer with state and operation acceptance inside the page', t => {
  const directory = mutation(t, { [pagePath]: `import { useReducer } from 'react';
export function OrderEditPage() {
  const [state, dispatch] = useReducer((state, action) => {
    if (action.type === 'save' && !state.saving && state.dirty) return { ...state, saving: true };
    return state;
  }, { saving: false, dirty: true });
  return <button disabled={state.saving || !state.dirty} onClick={() => dispatch({ type: 'save' })}>保存</button>;
}` });
  assert.equal(inspectFrontendArtifacts(directory).pass, true);
});

test('accepts component-local input state in an independent page region', t => {
  const directory = mutation(t, {
    [pagePath]: pageOwned,
    'src/features/orders/components/customer-search.tsx': `import { useState } from 'react';
export function CustomerSearch({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  return <section><input aria-label="検索" value={query} onChange={e => setQuery(e.target.value)} />
    <button onClick={() => onSelect(query)}>選択</button></section>;
}`,
  });
  assert.equal(inspectFrontendArtifacts(directory).pass, true);
});

// Static rules cannot establish ownership or reusability for these ordinary functions/objects.
// These counterexamples must FAIL operation-ownership in the structural rubric, not artifacts.
for (const [label, files] of [
  ['createOrderStore module', {
    'src/features/orders/order-store.ts': `export function createOrderStore() {
  let state = { saving: false, dirty: true };
  return { getState: () => state, save() {
    if (state.saving || !state.dirty) return;
    state = { ...state, saving: true };
  } };
}`,
    [pagePath]: `import { createOrderStore } from '../features/orders/order-store';
const store = createOrderStore();
export function OrderEditPage() { return <button onClick={store.save}>保存</button>; }`,
  }],
  ['transition-table module and dispatch-only page', {
    'src/features/orders/transitions.ts': `let state = 'dirty';
const transitions = { dirty: { save: 'saving' }, saving: { success: 'clean', failure: 'dirty' }, clean: {} };
export function dispatch(event: string) {
  const next = transitions[state][event];
  if (next) state = next;
}`,
    [pagePath]: `import { dispatch } from '../features/orders/transitions';
export function OrderEditPage() { return <button onClick={() => dispatch('save')}>保存</button>; }`,
  }],
  ['generic useOrderController reused across pages', {
    'src/features/orders/use-order-controller.ts': `import { useState } from 'react';
export function useOrderController() {
  const [saving, setSaving] = useState(false);
  const [dirty] = useState(true);
  return { saving, save() { if (!saving && dirty) setSaving(true); } };
}`,
    [pagePath]: `import { useOrderController } from '../features/orders/use-order-controller';
export function OrderEditPage() {
  const controller = useOrderController();
  return <button onClick={controller.save}>保存</button>;
}`,
    'src/routes/quick-order.tsx': `import { useOrderController } from '../features/orders/use-order-controller';
export function QuickOrderPage() {
  const controller = useOrderController();
  return <button onClick={controller.save}>保存</button>;
}`,
  }],
]) {
  test(`defers ${label} to the structural rubric rather than guessing from names`, t => {
    const result = inspectFrontendArtifacts(mutation(t, files));
    assert.equal(result.pass, true);
    assert.match(result.reason, /operation ownership is graded by llm-rubric/);
  });
}

test('accepts a passive display component and ignores comments and descriptive strings', t => {
  const directory = mutation(t, {
    'src/features/orders/components/formatted-amount.tsx': `
// Mediator class Example { save() {} } import { create } from 'zustand';
/* useOrderMediator */
export function FormattedAmount({ amount }: { amount: number }) {
  const description = 'Mediator';
  return <span title={description}>{new Intl.NumberFormat('ja-JP', {
    style: 'currency', currency: 'JPY', maximumFractionDigits: 0,
  }).format(amount)}</span>;
}`,
  });
  assert.equal(inspectFrontendArtifacts(directory).pass, true);
});

test('rejects a separate Mediator class with a delegating page', t => {
  const directory = mutation(t, {
    'src/features/orders/order-actions.ts': `export class OrderMediator {
  saving = false; dirty = true;
  save() { if (this.saving || !this.dirty) return; this.saving = true; }
}`,
    [pagePath]: `import { OrderMediator } from '../features/orders/order-actions';
const order = new OrderMediator();
export function OrderEditPage() { return <button onClick={() => order.save()}>保存</button>; }`,
  });
  const result = inspectFrontendArtifacts(directory);
  assert.equal(result.pass, false);
  assert.match(result.reason, /mediator identifier/);
});

test('rejects useOrderMediator with a page that only delegates', t => {
  const directory = mutation(t, {
    'src/features/orders/use-order-actions.ts': `import { useState } from 'react';
export function useOrderMediator() {
  const [saving, setSaving] = useState(false);
  return { saving, save() { if (!saving) setSaving(true); } };
}`,
    [pagePath]: `import { useOrderMediator } from '../features/orders/use-order-actions';
export function OrderEditPage() {
  const actions = useOrderMediator();
  return <button onClick={actions.save}>保存</button>;
}`,
  });
  assert.equal(inspectFrontendArtifacts(directory).pass, false);
  assert.match(inspectFrontendArtifacts(directory).reason, /mediator identifier useOrderMediator/);
});

for (const [label, source] of [
  ['subscription', 'export class EditorSession { saving = false; subscribe(listener) { return attach(listener); } }'],
  ['notification', 'export class EditorSession { saving = false; notify() { publish(this.saving); } }'],
  ['listeners', 'export class EditorSession { saving = false; listeners = new Set(); save() { this.saving = true; } }'],
  ['constructor listeners', 'export class EditorSession { constructor() { this.listeners = []; } save() { this.saving = true; } }'],
  ['readonly collection with subscription', 'export class EditorSession { readonly selected = new Set(); subscribe(listener) { return attach(listener); } select(id) { this.selected.add(id); } }'],
]) {
  test(`rejects non-React state owners with subscriptions or notifications: ${label}`, t => {
    const result = inspectFrontendArtifacts(mutation(t, { 'src/features/orders/editor.ts': source }));
    assert.equal(result.pass, false);
    assert.match(result.reason, /non-React class/);
  });
}

for (const [label, source] of [
  ['renamed class', 'export class EditorSession { saving = false; save() { this.saving = true; } }'],
  ['anonymous class', 'export const EditorSession = class { saving = false; save = () => { this.saving = true; }; };'],
  ['constructor state', 'export class EditorSession { constructor(public saving: boolean) {} save() { this.saving = true; } }'],
  ['implicit constructor field', 'export class EditorSession { constructor() { this.saving = false; } save() { this.saving = true; } }'],
  ['nested mutation', 'export class EditorSession { state = { saving: false }; save() { this.state.saving = true; } }'],
  ['element mutation', "export class EditorSession { state = {}; save() { this['state']['saving'] = true; } }"],
  ['increment', 'export class EditorSession { revision = 0; change() { this.revision++; } }'],
  ['readonly collection', 'export class EditorSession { readonly selected = new Set(); select(id) { this.selected.add(id); } }'],
  ['array mutation', 'export class EditorSession { selected = []; select(id) { this.selected.push(id); } }'],
  ['setter', 'export class EditorSession { value = false; set saving(next) { this.value = next; } }'],
]) {
  test(`defers classes with mutable state but no subscriptions or notifications to the structural rubric: ${label}`, t => {
    const result = inspectFrontendArtifacts(mutation(t, { 'src/features/orders/editor.ts': source }));
    assert.equal(result.pass, true, result.reason);
  });
}

for (const [label, source] of [
  ['communication only', `export class OrderApi {
    async load(id: string) { return (await fetch('/api/orders/' + id)).json(); }
    async save(value: unknown) { return fetch('/api/orders', { method: 'POST', body: JSON.stringify(value) }); }
  }`],
  ['API configuration', `export class OrderApi {
    constructor(private readonly baseUrl: string) {}
    load(id: string) { return fetch(this.baseUrl + '/' + id); }
  }`],
  ['constructor configuration', `export class OrderApi {
    baseUrl: string;
    constructor(baseUrl: string) { this.baseUrl = baseUrl; }
    load() { return fetch(this.baseUrl); }
  }`],
  ['HTTP client methods', `export class OrderApi {
    constructor(private readonly client: HttpClient) {}
    remove(id: string) { return this.client.delete('/api/orders/' + id); }
  }`],
  ['request cancellation state', `export class OrderApi {
    controller: AbortController | undefined;
    load(id: string) {
      this.controller = new AbortController();
      return fetch('/api/orders/' + id, { signal: this.controller.signal });
    }
    cancel() { this.controller?.abort(); }
  }`],
  ['notifications without instance state', 'export class Service { subscribe(listener) { return attach(listener); } }'],
  ['method only', 'export const Service = class { save() { return true; } };'],
  ['constructor communication', 'export class Service { constructor() { sendOrder(); } }'],
  ['field without updates', 'export class Service { constructor(public enabled: boolean) {} }'],
  ['static state', 'export class Service { static calls = 0; static record() { this.calls++; } }'],
]) {
  test(`accepts classes without mutable UI state ownership: ${label}`, t => {
    const result = inspectFrontendArtifacts(mutation(t, {
      'src/features/orders/service.ts': source,
    }));
    assert.equal(result.pass, true, result.reason);
  });
}

for (const [label, source] of [
  ['named React import', "import { Component as Base } from 'react'; export class Notice extends Base { render() { return <p />; } }"],
  ['namespace React import', "import * as UI from 'react'; export class Notice extends UI.PureComponent { render() { return <p />; } }"],
  ['default React import', "import React from 'react'; export class Notice extends React.Component { render() { return <p />; } }"],
]) {
  test(`does not reject React component classes: ${label}`, t => {
    assert.equal(inspectFrontendArtifacts(mutation(t, { 'src/features/orders/components/notice.tsx': source })).pass, true);
  });
}

test('rejects a Mediator filename even without a matching identifier', t => {
  const result = inspectFrontendArtifacts(mutation(t, { 'src/features/orders/order-mediator.ts': 'export const value = 1;' }));
  assert.equal(result.pass, false);
  assert.match(result.reason, /mediator filename/);
});

for (const source of [
  'export function createOrderMediator() { return {}; }',
  'export const useOrder\\u004dediator = () => ({});',
  'export interface OrderMediator { save(): void; }',
]) {
  test(`rejects Mediator identifiers parsed from code: ${source}`, t => {
    const result = inspectFrontendArtifacts(mutation(t, { 'src/features/orders/actions.ts': source }));
    assert.equal(result.pass, false);
    assert.match(result.reason, /mediator identifier/);
  });
}

for (const source of [
  "import { createMachine } from 'xstate';",
  "import { useMachine } from '@xstate/react';",
  "import { create } from 'zustand/vanilla';",
  "import { createStore } from 'redux';",
  "export { configureStore } from '@reduxjs/toolkit';",
  "export const store = import('jotai');",
  "const store = require('mobx');",
]) {
  test(`rejects state-library imports absent from the pristine manifest: ${source}`, t => {
    const manifest = JSON.parse(readFileSync(join(fixtureDirectory, 'package.json'), 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, xstate: '*', zustand: '*', redux: '*' };
    const result = inspectFrontendArtifacts(mutation(t, {
      'src/features/orders/store.ts': source,
      'package.json': JSON.stringify(manifest),
    }));
    assert.equal(result.pass, false);
    assert.match(result.reason, /new state library/);
  });
}

test('fails closed on unchanged fixture or missing page', t => {
  const directory = mutation(t, {});
  assert.equal(inspectFrontendArtifacts(directory).pass, false);
  assert.match(inspectFrontendArtifacts(directory).reason, /no source changes/);
  rmSync(join(directory, pagePath));
  assert.match(inspectFrontendArtifacts(directory).reason, /page artifact missing/);
});

test('reads artifacts from provider metadata instead of trusting the chat output', t => {
  const project = mutation(t, { 'src/features/orders/order-actions.ts': 'export class OrderMediator { save() {} }' });
  const root = mkdtempSync(join(tmpdir(), 'takt-frontend-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(project, join(root, 'project'), { recursive: true });
  assert.equal(assertArtifacts('everything passed', {
    providerResponse: { metadata: { artifactDirectory: root } },
  }).pass, false);
  assert.equal(assertArtifacts('{}', { providerResponse: {} }).pass, false);
  assert.equal(assertArtifacts('{}', {
    providerResponse: { metadata: { artifactDirectory: join(root, 'missing') } },
  }).pass, false);
});

test('each case/provider/repeat starts pristine and retains its own observed artifact', async t => {
  const source = mutation(t, {});
  const before = readProjectFiles(source);
  const generated = [];
  const workingDirectories = [];
  const providers = ['openai:codex-sdk', 'claude'].map(provider => new TestCoderProvider({
    config: { provider, working_dir: relative(evalDirectory, source) },
  }));
  for (const [index, provider] of [providers[0], providers[1], providers[0]].entries()) {
    provider.runAgent = async (prompt, cwd) => {
      assert.notEqual(cwd, source);
      assert.equal(prompt, `work: ${cwd}`);
      assert.deepEqual(readProjectFiles(cwd), before);
      workingDirectories.push(cwd);
      writeFileSync(join(cwd, pagePath), `${pageOwned}\n// sample ${index}`);
      return { output: 'agent omitted the files' };
    };
    const result = await provider.callApi(`work: ${source}`, {});
    assert.equal(result.error, undefined);
    generated.push(result.metadata.artifactDirectory);
    t.after(() => rmSync(result.metadata.artifactDirectory, { recursive: true, force: true }));
    const output = JSON.parse(result.output);
    assert.deepEqual(output.changedPaths, [pagePath]);
    assert.equal(output.files[pagePath], `${pageOwned}\n// sample ${index}`);
    assert.equal(assertArtifacts(result.output, { providerResponse: result }).pass, true);
    assert.equal(existsSync(workingDirectories[index]), false);
  }
  assert.equal(new Set(generated).size, 3);
  assert.equal(new Set(workingDirectories).size, 3);
  assert.deepEqual(readProjectFiles(source), before);
});

test('Claude wrapper forwards model, prompt and isolated cwd without API calls', async t => {
  const source = mutation(t, {});
  const binDirectory = mkdtempSync(join(tmpdir(), 'takt-frontend-fake-cli-'));
  t.after(() => rmSync(binDirectory, { recursive: true, force: true }));
  const executable = join(binDirectory, 'claude');
  writeFileSync(executable, `#!/bin/sh
test "$1" = '-p' && test "$2" = '--model' && test "$3" = 'claude-opus-5' || exit 2
cat > observed-prompt.md
printf 'export const marker = 1;\\n' > src/observed.ts
printf '{"type":"result","is_error":false,"result":"fake CLI completed"}\\n'
`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const provider = new TestCoderProvider({ config: {
    provider: 'claude', model: 'claude-opus-5', working_dir: relative(evalDirectory, source),
  } });
  const result = await provider.callApi(`project ${source}`, {});
  assert.equal(result.error, undefined);
  t.after(() => rmSync(result.metadata.artifactDirectory, { recursive: true, force: true }));
  const output = JSON.parse(result.output);
  assert.equal(output.response, 'fake CLI completed');
  assert.ok(output.changedPaths.includes('src/observed.ts'));
  assert.equal(output.files['observed-prompt.md'], undefined);
  const observedPrompt = readFileSync(join(result.metadata.artifactDirectory, 'project/observed-prompt.md'), 'utf8');
  assert.notEqual(observedPrompt, `project ${source}`);
  assert.ok(observedPrompt.includes('takt-prompt-eval-fixture-'));
  assert.equal(existsSync(join(source, 'src/observed.ts')), false);
});

test('suite registration and paths bind to the intended frontend fixture and cases', () => {
  const suite = selectPromptEvalSuites({ names: ['frontend-mediator-coder'] })[0];
  assert.equal(suite.tier, 'active');
  assert.equal(suite.execution.defaultEligible, false);
  assert.deepEqual(promptEvalPrepareTargets([suite]), ['frontend-mediator-implement']);
  const config = parse(readFileSync(join(evalDirectory, suite.config), 'utf8'));
  assert.deepEqual(config.prompts, ['file://../../prompts/frontend-mediator-implement.phase1.md']);
  assert.deepEqual(config.tests.map(entry => entry.vars.task), [
    'file://../../cases/frontend-mediator-implement-task.md',
    'file://../../cases/frontend-mediator-display-task.md',
  ]);
  assert.deepEqual(config.providers.map(entry => entry.label), ['codex', 'claude-opus-5']);
  for (const provider of config.providers) {
    assert.equal(provider.config.working_dir, '.work/frontend-mediator-implement');
    assert.equal(provider.id, 'file://../../providers/frontend-mediator-coder.mjs');
  }
  assert.equal(config.providers[0].config.provider, 'openai:codex-sdk');
  assert.equal(config.providers[0].config.sandbox_mode, 'workspace-write');
  assert.equal(config.providers[0].config.model_reasoning_effort, 'low');
  assert.equal(config.providers[1].config.model, 'claude-opus-5');
  assert.ok(config.tests.every(entry => entry.assert[0].value.startsWith('名前ではなく構造で判定する。')));
  const [structure, functionality] = config.tests[0].assert;
  assert.equal(structure.metric, 'frontend-mediator/operation-ownership');
  assert.equal(functionality.metric, 'frontend-mediator/functional-completeness');
  assert.match(structure.value, /機能の欠落を理由にこの構造 metric を不合格にしない/);
  for (const counterexample of ['createOrderStore', '遷移表', 'useOrderController']) {
    assert.ok(structure.value.includes(counterexample));
  }
  assert.match(structure.value, /useReducer/);
  assert.match(functionality.value, /disabled 属性だけでは不十分/);
  assert.match(functionality.value, /構造は operation-ownership だけで評価する/);
  const fixtureFiles = readProjectFiles(fixtureDirectory);
  for (const [path, content] of Object.entries(fixtureFiles)) {
    assert.doesNotMatch(content, /mediator|controller|TODO|FIXME/i, path);
  }
  for (const task of config.tests.map(entry => entry.vars.task.replace('file://../../', ''))) {
    assert.doesNotMatch(readFileSync(join(evalDirectory, task), 'utf8'), /mediator|状態機械|hook|routes\//i);
  }
});
