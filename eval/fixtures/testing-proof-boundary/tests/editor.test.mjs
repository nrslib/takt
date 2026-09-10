import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryClient} from '../src/delivery-client.mjs';
import {createEditor} from '../src/editor.mjs';

test('successful delivery commits the draft', async () => {
  let commits = 0;
  const destinations = [];
  const client = createDeliveryClient(async ({route}) => {destinations.push(route);}, 'desk-a', () => {});
  const editor = createEditor(client, 'draft text', 'desk-a', () => commits++);
  await editor.submit();
  assert.equal(commits, 1);
  assert.equal(editor.state.screen, 'complete');
  await client.deliver('next draft');
  assert.deepEqual(destinations, ['desk-a', 'desk-a']);
});
for (const code of ['DISCONNECTED', 'SERVICE_UNAVAILABLE']) {
  test(`${code} keeps the editor and draft without committing`, async () => {
    let commits = 0;
    let retirements = 0;
    const client = createDeliveryClient(async () => {throw Object.assign(new Error(), {code});}, 'desk-a', () => retirements++);
    const editor = createEditor(client, 'draft text', 'desk-a', () => commits++);
    await editor.submit();
    assert.deepEqual(editor.state, {screen: 'editor', draft: 'draft text', selectedRoute: 'desk-a', failed: true});
    assert.equal(commits, 0);
    assert.equal(retirements, 0);
  });
}
