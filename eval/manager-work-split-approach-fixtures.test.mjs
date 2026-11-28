import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { loadManagerCase } from './manager-work-split-prompt.mjs';

// Execute the code supplied as evidence, so passing local checks cannot conceal
// an inconsistent history or a hypothetical remaining failure in the fixture.
const codeExcerpt = (content) => content.split('\n')
  .filter((line) => line.startsWith('  ')).map((line) => line.slice(2)).join('\n');

for (const lang of ['ja', 'en']) {
  test(`${lang}: independent repairs aggregate every accepted quantity exactly`, () => {
    const fixture = loadManagerCase('independent-causal-repairs', lang);
    const source = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Read'
      && args.file_path.endsWith('/source-evidence.txt')).result;
    function excerptFor(path) {
      const lines = source.split('\n');
      const start = lines.findIndex((line) => line.startsWith(`${path}:`));
      assert.ok(start >= 0, `Missing executable evidence: ${path}`);
      const end = lines.findIndex((line, index) => index > start && !line.startsWith('  '));
      return codeExcerpt(lines.slice(start + 1, end < 0 ? undefined : end).join('\n'));
    }
    const context = {};
    const code = `${excerptFor('src/inventory/input.ts')}
      function aggregate(rows) { ${excerptFor('src/inventory/sum.ts')} }
      function importInventory(input) { ${excerptFor('src/inventory/import.ts')} return totals; }`;
    runInNewContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);

    assert.equal(context.importInventory([{ quantity: '2' }, { quantity: '3' }]), 5);
    assert.equal(context.importInventory([{ quantity: '0' }]), 0);
    assert.equal(context.importInventory([]), 0);
    assert.equal(context.importInventory(Array.from({ length: 1000 }, () => ({ quantity: '1000000' }))), 1000000000);
    for (const quantity of ['0.1', '0.2', '1.5', '-1', '1e3', '', 'NaN', 'Infinity', '1000001', '9007199254740993']) {
      assert.throws(() => context.importInventory([{ quantity }]), { name: 'Error' });
    }
    assert.throws(() => context.importInventory(Array.from({ length: 1001 }, () => ({ quantity: '1' }))), { name: 'Error' });
  });

  test(`${lang}: preview history resolves each local finding but still reuses request identity`, () => {
    const fixture = loadManagerCase('preview-request-identity-growth', lang);
    const reports = fixture.runArtifacts[0].reports;
    const fix = (name) => codeExcerpt(reports.find(({ filename }) => filename === name).content);
    const source = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Read'
      && args.file_path.endsWith('/source-evidence.txt')).result;
    const numbering = fix('fix-02.md');
    const callbacks = [
      `function acceptPreview(result) { ${fix('fix-01.md')} }`,
      '',
      codeExcerpt(source),
    ];
    function preview(version, requests, completionOrder) {
      const shown = [];
      const jobs = [];
      const context = {
        canvas: { show: (bitmap) => shown.push(bitmap) },
        worker: { render: (job) => jobs.push({ ...job, bitmap: `result-${jobs.length}` }) },
      };
      const code = `let selection;\n${numbering}\n${callbacks[version - 1]}`;
      runInNewContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
      for (const assetId of requests) {
        if (assetId === null) context.reload();
        else context.selectAsset(assetId);
      }
      for (const index of completionOrder) context.acceptPreview(jobs[index]);
      return shown;
    }

    // The first guard fixes switching; serials fix same-image reloads; the pair
    // fixes collisions between different images. All reported local checks hold.
    assert.deepEqual(preview(1, ['A', 'B'], [1, 0]), ['result-1']);
    assert.deepEqual(preview(1, ['A', null], [1, 0]), ['result-1', 'result-0']);
    assert.deepEqual(preview(2, ['A', null], [1, 0]), ['result-1']);
    assert.deepEqual(preview(2, ['A', null, 'B', null], [3, 1]), ['result-3', 'result-1']);
    assert.deepEqual(preview(3, ['A', null, 'B', null], [3, 1]), ['result-3']);
    assert.deepEqual(preview(3, ['A', 'B'], [1, 0]), ['result-1']);
    assert.deepEqual(preview(3, ['A', null], [1, 0]), ['result-1']);
    assert.deepEqual(preview(3, ['A'], [0]), ['result-0']);

    // Reconstructing the latest callback with numbering from its earlier change
    // proves that returning to A admits an old A/1 after the new A/1 is displayed.
    assert.deepEqual(preview(3, ['A', 'B', 'A'], [2, 1, 0]), ['result-2', 'result-0']);
  });
}
