import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryClient} from '../src/delivery-client.mjs';
import {createEditor} from '../src/editor.mjs';

test('successful delivery commits the draft', async () => {
  let commits = 0;
  const client = createDeliveryClient(async () => {}, 'desk-a', () => {});
  const editor = createEditor(client, 'draft text', 'desk-a', () => commits++);
  await editor.submit();
  assert.equal(commits, 1);
  assert.equal(editor.state.screen, 'complete');
});
