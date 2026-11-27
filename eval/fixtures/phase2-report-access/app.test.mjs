import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
writeFileSync('.test-started', 'test invoked');
test('ready to run', () => assert.equal(2 + 2, 4));
