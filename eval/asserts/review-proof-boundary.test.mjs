import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath, URL} from 'node:url';
import {parse} from 'yaml';
import {createDeliveryClient as createCleanClient} from '../fixtures/review-proof-boundary/src/delivery-client.mjs';
import {createDeliveryClient as createBrokenClient} from '../fixtures/review-proof-actual-regression/src/delivery-client.mjs';
import {createEditor} from '../fixtures/review-proof-boundary/src/editor.mjs';

test('review preparation keeps another target snapshot unchanged', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const prepare = (target) => execFileSync(process.execPath, ['eval/scripts/prepare.mjs', target], {cwd: repoRoot});
  const adjudicationSnapshot = new URL('../fixtures/review-proof-boundary/.takt/eval-snapshots/review-proof-boundary-policies.md', import.meta.url);

  prepare('review-proof-boundary');
  const before = readFileSync(adjudicationSnapshot, 'utf8');
  prepare('testing-proof-boundary');
  assert.equal(readFileSync(adjudicationSnapshot, 'utf8'), before);
});

for (const code of ['DISCONNECTED', 'SERVICE_UNAVAILABLE']) {
  test(`clean fixture preserves delivery after ${code}`, async () => {
    const destinations = [];
    const client = createCleanClient(async ({route}) => {
      destinations.push(route);
      if (destinations.length === 1) throw Object.assign(new Error(), {code});
    }, 'desk-a', () => assert.fail('temporary failure must not retire the route'));
    let commits = 0;
    const editor = createEditor(client, 'draft text', 'desk-a', () => commits++);
    await editor.submit();
    assert.equal(editor.state.failed, true);
    assert.equal(editor.state.screen, 'editor');
    assert.equal(commits, 0);
    await editor.submit();
    assert.deepEqual(destinations, ['desk-a', 'desk-a']);
    assert.equal(editor.state.screen, 'complete');
    assert.equal(commits, 1);
  });

  test(`defect control loses the delivery route after ${code}`, async () => {
    const destinations = [];
    const client = createBrokenClient(async ({route}) => {
      destinations.push(route);
      if (destinations.length === 1) throw Object.assign(new Error(), {code});
    }, 'desk-a', () => {});
    const editor = createEditor(client, 'draft text', 'desk-a', () => {});
    await editor.submit();
    assert.equal(editor.state.selectedRoute, 'desk-a');
    await editor.submit();
    assert.deepEqual(destinations, ['desk-a', null]);
  });
}

test('existing retired-route behavior is distinct from temporary failure', async () => {
  const destinations = [];
  let retirements = 0;
  const client = createCleanClient(async ({route}) => {
    destinations.push(route);
    if (destinations.length === 1) throw Object.assign(new Error(), {code: 'ROUTE_RETIRED'});
  }, 'desk-a', () => retirements++);
  await assert.rejects(client.deliver('draft text'));
  await client.deliver('draft text');
  assert.equal(retirements, 1);
  assert.deepEqual(destinations, ['desk-a', null]);
});


for (const [role, suite, expected] of [
  ['review-adjudication', 'review-proof-boundary', 'close'],
  ['review-adjudication', 'review-proof-required-check', 'repair'],
  ['review-adjudication', 'review-proof-actual-regression', 'repair'],
  ['review-adjudication', 'review-proof-missing-failure', 'repair'],
  ['testing-review', 'testing-proof-boundary', 'close'],
  ['testing-review', 'testing-proof-new-behavior', 'repair'],
]) {
  test(`${suite} accepts Markdown disposition and rejects conflicting decisions`, () => {
    const config = parse(readFileSync(new URL(`../agents/${role}/${suite}.yaml`, import.meta.url), 'utf8'));
    const assertion = config.tests[0].assert.find(({type}) => type === 'javascript');
    const evaluate = Function('output', `return (${assertion.value});`);
    const opposite = expected === 'close' ? 'repair' : 'close';
    for (const wrapper of ['', '**', '`']) {
      const decision = `${wrapper}DISPOSITION: ${expected}${wrapper}`;
      assert.equal(evaluate(`Review rationale.\n\n${decision}\n`), true);
      assert.equal(evaluate(`${decision}\nDISPOSITION: ${opposite}`), false);
      assert.equal(evaluate(`DISPOSITION: ${opposite}\n${decision}`), false);
    }
    assert.equal(evaluate(`The example is DISPOSITION: ${expected}, not a decision.`), false);
    assert.equal(evaluate(`DISPOSITION: ${opposite}`), false);
  });
}
