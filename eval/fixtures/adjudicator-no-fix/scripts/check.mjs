import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { normalizeChannel } from '../src/channel.mjs';

process.stderr.write('ADJUDICATOR_EXECUTION:{"script":"test"}\n');
appendFileSync(new URL('../execution-marker.jsonl', import.meta.url), '{"script":"test"}\n');
assert.equal(normalizeChannel(' WEB '), 'web');
assert.equal(normalizeChannel(' Slack '), 'slack');
console.log('channel tests passed');
