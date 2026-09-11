import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preview, deliver, relay, summarize, readManifest } from '../src/readers.mjs';

function source(text) {
  return {
    async readText() { return text; },
    async *chunks() {
      for (let offset = 0; offset < text.length; offset += 64) yield text.slice(offset, offset + 64);
    },
  };
}

test('preview returns the requested prefix for empty, short and long objects', async () => {
  for (const text of ['', 'short', 'abc'.repeat(100)]) {
    assert.equal(await preview(source(text)), text.slice(0, 80));
  }
});

for (const copy of [deliver, relay]) {
  test(`${copy.name} copies every character in order`, async () => {
    const received = [];
    const text = 'abc'.repeat(100);
    await copy(source(text), { async write(block) { received.push(block); } });
    assert.equal(received.join(''), text);
  });
}

test('summary visits the complete source and returns its length', async () => {
  assert.equal(await summarize(source('abc'.repeat(100))), 300);
});

test('manifest preserves every bounded entry', async () => {
  const entries = Array.from({ length: 16 }, (_, id) => ({ id }));
  assert.deepEqual(await readManifest({ async readEntries() { return entries; } }), entries);
});
