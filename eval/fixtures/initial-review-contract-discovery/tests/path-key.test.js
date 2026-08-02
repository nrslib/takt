import test from 'node:test';
import assert from 'node:assert/strict';
import { pathKey } from '../src/path-key.js';
import { auditKey } from '../src/audit-key.js';

test('keeps ordinary nested paths distinct', () => {
  assert.notEqual(
    pathKey([{ name: 'root', attempt: 1 }, { name: 'left', attempt: 2 }]),
    pathKey([{ name: 'root', attempt: 1 }, { name: 'right', attempt: 2 }]),
  );
});

test('encodes audit paths structurally', () => {
  assert.notEqual(
    auditKey([{ name: 'a', attempt: 1 }, { name: 'b', attempt: 2 }]),
    auditKey([{ name: 'a|1|b', attempt: 2 }]),
  );
});
