import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDecomposePrompt,
  buildMorePartsPrompt,
  buildPromptBasedDecomposePrompt,
  buildPromptBasedMorePartsPrompt,
} from '../agents/team-leader-structured-output.js';

function readBuiltinInstruction(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf-8');
}

describe('team leader decomposition guidance', () => {
  it('Given structured decomposition, When building the Japanese prompt, Then it discourages oversized implementation-and-verification parts', () => {
    const prompt = buildDecomposePrompt('実装タスク', 4, 'ja');

    expect(prompt).toContain('並行可能な責務境界');
    expect(prompt).toContain('実装と検証');
    expect(prompt).toContain('巨大');
    expect(prompt).toContain('実装 part と検証 part を分ける');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('npm run test:e2e:mock');
    expect(prompt).toContain('重複して持たせない');
    expect(prompt).toContain('parts.length === 1');
  });

  it('Given prompt-based decomposition, When building the English prompt, Then it requires responsibility boundaries and staged verification', () => {
    const prompt = buildPromptBasedDecomposePrompt('implement feature', 4, 'en');

    expect(prompt).toContain('parallelizable responsibility boundaries');
    expect(prompt).toContain('Avoid oversized');
    expect(prompt).toContain('implementation and verification');
    expect(prompt).toContain('Separate implementation parts from verification parts');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('npm run test:e2e:mock');
    expect(prompt).toContain('Do not duplicate');
    expect(prompt).toContain('parts.length === 1');
  });

  it('Given feedback planning, When building more-parts prompts, Then it keeps heavy quality gates out of implementation continuations', () => {
    const results = [
      {
        id: 'part-1',
        title: 'Implementation',
        status: 'error',
        content: '[ERROR] part timeout: Part timeout after 1000ms',
      },
    ];

    const structuredPrompt = buildMorePartsPrompt('implement feature', results, ['part-1'], 2, 'en');
    const promptBasedPrompt = buildPromptBasedMorePartsPrompt('実装タスク', results, ['part-1'], 2, 'ja');

    expect(structuredPrompt).toContain('Preserve existing changes');
    expect(structuredPrompt).toContain('unfinished work');
    expect(structuredPrompt).toContain('verification part');
    expect(structuredPrompt).toContain('Do not duplicate');
    expect(promptBasedPrompt).toContain('既存差分を破壊しない');
    expect(promptBasedPrompt).toContain('未完了作業');
    expect(promptBasedPrompt).toContain('検証 part');
    expect(promptBasedPrompt).toContain('重複して持たせない');
  });

  it('Given builtin team-leader facets, When reading runtime instructions, Then both languages reject single oversized parts before execution', () => {
    const japanese = readBuiltinInstruction('builtins/ja/facets/instructions/team-leader-implement.md');
    const english = readBuiltinInstruction('builtins/en/facets/instructions/team-leader-implement.md');

    expect(japanese).toContain('並行可能な責務境界');
    expect(japanese).toContain('実装と検証');
    expect(japanese).toContain('巨大');
    expect(japanese).toContain('全体ビルド・全体テストを重複して実行させない');
    expect(japanese).toContain('parts.length === 1');

    expect(english).toContain('parallelizable responsibility boundaries');
    expect(english).toContain('implementation and verification');
    expect(english).toContain('oversized');
    expect(english).toContain('Do not make parallel implementation parts run duplicate full-build or full-test checks');
    expect(english).toContain('parts.length === 1');
  });

  it('Given builtin dual team-leader facets, When reading runtime instructions, Then both languages use staged decomposition guidance', () => {
    const japanese = readBuiltinInstruction('builtins/ja/facets/instructions/dual-team-leader-implement.md');
    const english = readBuiltinInstruction('builtins/en/facets/instructions/dual-team-leader-implement.md');

    expect(japanese).toContain('並行可能な責務境界');
    expect(japanese).toContain('基盤 part → 消費 part → 検証 part');
    expect(japanese).toContain('巨大な単一 part');
    expect(japanese).toContain('実装 part と検証 part を分ける');
    expect(japanese).toContain('npm test / npm run test:e2e:mock');
    expect(japanese).not.toContain('横断的関心事（共有型・ID・イベント）がある場合は分解せず1パートで実装する');

    expect(english).toContain('parallelizable responsibility boundaries');
    expect(english).toContain('foundation part -> consuming parts -> verification part');
    expect(english).toContain('oversized single parts');
    expect(english).toContain('Separate implementation parts from verification parts');
    expect(english).toContain('npm test / npm run test:e2e:mock');
    expect(english).not.toContain('If cross-cutting concerns exist (shared types, IDs, events), implement in a single part');
  });
});
