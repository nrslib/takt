import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readDoc(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('doc_drift — cli-reference Flow + none semantics', () => {
  it('docs/cli-reference.md: Interactive Mode intro mentions none skips conversational path', () => {
    const md = readDoc('docs/cli-reference.md');
    expect(md).toMatch(
      /The `none` interactive mode skips this conversational path and starts the workflow at the first movement/,
    );
  });

  it('docs/cli-reference.md: Flow step 2 lists none and explains skipping dialogue for none', () => {
    const md = readDoc('docs/cli-reference.md');
    expect(md).toMatch(
      /Select interactive mode \(assistant \/ persona \/ quiet \/ passthrough \/ none\)/,
    );
    expect(md).toContain('When the effective interactive mode is `none`, steps 3–4 are skipped');
    expect(md).toMatch(/first movement/);
  });

  it('docs/cli-reference.ja.md: インタラクティブモード節冒頭で none が対話を挟まない旨がある', () => {
    const md = readDoc('docs/cli-reference.ja.md');
    expect(md).toMatch(/`none` モードはこの対話経路を使わず/);
  });

  it('docs/cli-reference.ja.md: フロー手順2に none と、none 時は手順3・4を踏まない旨がある', () => {
    const md = readDoc('docs/cli-reference.ja.md');
    expect(md).toMatch(
      /インタラクティブモードを選択（assistant \/ persona \/ quiet \/ passthrough \/ none）/,
    );
    expect(md).toMatch(/有効なインタラクティブモードが `none` のときは手順 3・4を行いません/);
    expect(md).toMatch(/先頭ムーブメント/);
  });
});

describe('policy — interactive-mode.ts no per-mode What/How block', () => {
  it('src/core/models/interactive-mode.ts: no bullet list of mode behaviors (review policy)', () => {
    const src = readDoc('src/core/models/interactive-mode.ts');
    expect(src).not.toMatch(/\n \* - \w+:/);
    expect(src).not.toMatch(/Asks clarifying questions/);
    expect(src).not.toMatch(/Passes user input directly/);
  });
});
