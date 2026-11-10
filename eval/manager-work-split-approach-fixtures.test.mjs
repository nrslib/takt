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
