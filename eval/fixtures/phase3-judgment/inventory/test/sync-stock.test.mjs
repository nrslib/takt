import assert from 'node:assert/strict';
import test from 'node:test';
import { syncInventory } from '../src/sync-stock.mjs';

test('converts TOKYO cases and adds loose units', () => {
  assert.deepEqual(syncInventory([
    { warehouse: 'TOKYO', sku: 'paper-01', cases: 2, looseUnits: 3 },
  ]), [{ warehouse: 'TOKYO', sku: 'paper-01', quantity: 27 }]);
});

test('converts OSAKA cases and adds loose units', () => {
  assert.deepEqual(syncInventory([
    { warehouse: 'OSAKA', sku: 'paper-01', cases: 2, looseUnits: 5 },
  ]), [{ warehouse: 'OSAKA', sku: 'paper-01', quantity: 53 }]);
});

test('synchronizes loose stock without cases', () => {
  assert.deepEqual(syncInventory([
    { warehouse: 'FUKUOKA', sku: 'paper-01', cases: 0, looseUnits: 4 },
  ]), [{ warehouse: 'FUKUOKA', sku: 'paper-01', quantity: 4 }]);
});

test('rejects an unregistered warehouse', () => {
  assert.throws(() => syncInventory([
    { warehouse: 'UNKNOWN', sku: 'paper-01', cases: 1, looseUnits: 0 },
  ]), /Unknown warehouse/);
});
