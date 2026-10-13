import assert from 'node:assert/strict';
import test from 'node:test';
import { importCustomers } from '../src/import-batch.mjs';

test('imports a customer file in JSONL format', () => {
  const result = importCustomers({ format: 'jsonl', body: '{"id":"c1","email":"c1@example.test"}\n' });
  assert.equal(result.imported, 1);
  assert.deepEqual(result.customers, [{ id: 'c1', email: 'c1@example.test' }]);
});

test('imports a customer file in CSV format', () => {
  const result = importCustomers({ format: 'csv', body: 'id,email\nc2,c2@example.test\n' });
  assert.equal(result.imported, 1);
});

test('rejects an unsupported customer file format', () => {
  assert.throws(() => importCustomers({ format: 'xml', body: '<customers />' }));
});

test('rejects records without an email address', () => {
  assert.throws(() => importCustomers({ format: 'jsonl', body: '{"id":"c1"}' }));
});
