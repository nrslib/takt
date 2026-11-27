import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRefund } from '../src/refund.mjs';

test('subtracts the discount and processing fee from a refund', () => {
  assert.equal(calculateRefund({
    items: [{ unitPrice: 100, quantity: 1 }], discountRate: 0.1, feeRate: 0.02,
  }), 88.2);
});

test('refunds all items when no discount or fee applies', () => {
  assert.equal(calculateRefund({
    items: [{ unitPrice: 15, quantity: 2 }], discountRate: 0, feeRate: 0,
  }), 30);
});

test('returns zero for an empty order', () => {
  assert.equal(calculateRefund({ items: [], discountRate: 0.1, feeRate: 0.02 }), 0);
});
