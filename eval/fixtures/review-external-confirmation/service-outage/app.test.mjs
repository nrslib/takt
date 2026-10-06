import test from 'node:test';
import assert from 'node:assert/strict';
import { receive } from './app.mjs';
test('paid event and replay', () => {
  const seen = new Set();
  const event = { id: 'payment-1', signature: 'signed', type: 'paid' };
  assert.deepEqual(receive(event, 'signed', seen), { accepted: true, duplicate: false, status: 'paid' });
  assert.deepEqual(receive(event, 'signed', seen), { accepted: true, duplicate: true });
});
test('invalid signature has no effect', () => {
  const seen = new Set();
  assert.throws(() => receive({ id: 'payment-2', signature: 'bad', type: 'paid' }, 'signed', seen));
  assert.equal(seen.size, 0);
});

test('refund event and replay', () => {
  const seen = new Set();
  const event = { id: 'refund-1', signature: 'signed', type: 'refunded' };
  assert.deepEqual(receive(event, 'signed', seen), { accepted: true, duplicate: false, status: 'refunded' });
  assert.deepEqual(receive(event, 'signed', seen), { accepted: true, duplicate: true });
});

test('missing signature or expected signature has no effect', () => {
  for (const [signature, expectedSignature] of [
    [undefined, 'signed'],
    ['signed', undefined],
    [undefined, undefined],
    ['', 'signed'],
    ['signed', ''],
    ['', ''],
    [null, null],
  ]) {
    const seen = new Set(['existing']);
    const event = { id: 'missing-signature', signature, type: 'paid' };
    assert.throws(() => receive(event, expectedSignature, seen));
    assert.deepEqual([...seen], ['existing']);
  }
});
