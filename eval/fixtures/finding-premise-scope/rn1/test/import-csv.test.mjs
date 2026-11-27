import test from 'node:test';
import assert from 'node:assert/strict';
import { importVendorCsv, parseAmount } from '../src/import-csv.mjs';

test('reads a plain amount', () => {
  assert.equal(parseAmount('980'), 980);
});

test('reads an amount with thousands separators', () => {
  assert.equal(parseAmount('1,000'), 1000);
  assert.equal(parseAmount('12,500'), 12500);
});

test('rejects separators in the wrong position', () => {
  assert.throws(() => parseAmount('1,00'));
  assert.throws(() => parseAmount('10,00,0'));
});

test('imports quoted amounts with separators', () => {
  const csv = 'vendor_code,issued_on,amount,memo\nA001,2026-09-30,"1,000",文具\nB002,2026-09-30,980,\n';
  const { records, errors } = importVendorCsv(csv);
  assert.deepEqual(errors, []);
  assert.deepEqual(records.map((record) => record.amount), [1000, 980]);
});

test('reports rows with an unexpected number of columns', () => {
  const csv = 'vendor_code,issued_on,amount,memo\nA001,2026-09-30,1,000,文具\n';
  const { records, errors } = importVendorCsv(csv);
  assert.equal(records.length, 0);
  assert.equal(errors[0].lineNumber, 2);
});

test('reports rows whose amount is not a number', () => {
  const csv = 'vendor_code,issued_on,amount,memo\nA001,2026-09-30,abc,\n';
  const { records, errors } = importVendorCsv(csv);
  assert.equal(records.length, 0);
  assert.equal(errors[0].lineNumber, 2);
});
