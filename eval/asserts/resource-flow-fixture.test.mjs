import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preview, deliver, relay, summarize, readManifest } from '../fixtures/resource-flow/src/readers.mjs';

function observedSource(count) {
  const stats = { pulls: 0, downloadedCharacters: 0 };
  return {
    stats,
    async readText() {
      stats.downloadedCharacters += count * 64;
      return 'x'.repeat(count * 64);
    },
    async *chunks() {
      for (let index = 0; index < count; index++) {
        stats.pulls++;
        stats.downloadedCharacters += 64;
        yield 'x'.repeat(64);
      }
    },
  };
}

for (const count of [50, 2000]) {
  test(`preview downloads all ${count} blocks despite an 80-character output`, async () => {
    const source = observedSource(count);
    assert.equal((await preview(source)).length, 80);
    assert.equal(source.stats.downloadedCharacters, count * 64);
  });

  for (const [name, copy, expectedFirstWrite] of [
    ['deliver buffers the complete input', deliver, count],
    ['relay delivers incrementally', relay, 1],
  ]) {
    test(`${name} while preserving all ${count} blocks`, async () => {
      const source = observedSource(count);
      let characters = 0;
      let firstWriteAfterPulls;
      await copy(source, {
        async write(block) {
          firstWriteAfterPulls ??= source.stats.pulls;
          characters += block.length;
          await Promise.resolve();
        },
      });
      assert.equal(characters, count * 64);
      assert.equal(source.stats.pulls, count);
      assert.equal(firstWriteAfterPulls, expectedFirstWrite);
    });
  }

  test(`full scan is necessary for an exact summary of ${count} blocks`, async () => {
    const source = observedSource(count);
    assert.equal(await summarize(source), count * 64);
    assert.equal(source.stats.pulls, count);
  });
}

test('a manifest with an enforced small bound preserves its entire contents', async () => {
  const entries = Array.from({ length: 16 }, (_, id) => ({ id }));
  assert.deepEqual(await readManifest({ async readEntries() { return entries; } }), entries);
});
