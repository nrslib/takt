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
  it('Given no inspect tools, When building decomposition prompts, Then tool usage remains prohibited', () => {
    const structuredPrompt = buildDecomposePrompt('implement feature', 3, 'en');
    const promptBasedPrompt = buildPromptBasedDecomposePrompt('実装タスク', 3, 'ja');

    expect(structuredPrompt).toContain('Do not use any tool');
    expect(promptBasedPrompt).toContain('ツールは使用しない');
  });

  it('Given empty inspect tools, When building decomposition prompts, Then tool usage remains prohibited', () => {
    const structuredPrompt = buildDecomposePrompt('implement feature', 3, 'en', []);
    const promptBasedPrompt = buildPromptBasedDecomposePrompt('実装タスク', 3, 'ja', []);

    expect(structuredPrompt).toContain('Do not use any tool');
    expect(promptBasedPrompt).toContain('ツールは使用しない');
  });

  it('Given inspect tools, When building the English decomposition prompt, Then it allows read-only inspection without implementation actions', () => {
    const buildWithInspectTools = buildDecomposePrompt as (
      instruction: string,
      maxTotalParts: number,
      language: 'en',
      inspectTools: string[],
    ) => string;

    const prompt = buildWithInspectTools('implement feature', 3, 'en', ['Read', 'Glob', 'Grep']);

    expect(prompt).not.toContain('Do not use any tool');
    expect(prompt).toContain('read-only inspection tools');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('Do not run commands');
    expect(prompt).toContain('Do not execute the implementation');
    expect(prompt).toContain('Return at least one part');
  });

  it('Given inspect tools, When building the Japanese prompt-based decomposition prompt, Then it allows read-only inspection without implementation actions', () => {
    const buildWithInspectTools = buildPromptBasedDecomposePrompt as (
      instruction: string,
      maxTotalParts: number,
      language: 'ja',
      inspectTools: string[],
    ) => string;

    const prompt = buildWithInspectTools('実装タスク', 3, 'ja', ['Read', 'Glob', 'Grep']);

    expect(prompt).not.toContain('ツールは使用しない');
    expect(prompt).toContain('読み取り専用');
    expect(prompt).toContain('編集しない');
    expect(prompt).toContain('コマンドを実行しない');
    expect(prompt).toContain('実装しない');
    expect(prompt).toContain('少なくとも1つの part');
  });

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

  it('Given structured decomposition, When building the Japanese prompt, Then it describes max parts as a total limit instead of concurrency', () => {
    const prompt = buildDecomposePrompt('実装タスク', 5, 'ja');

    expect(prompt).toContain('返してよい総 parts 数');
    expect(prompt).toContain('1 以上 5 以下');
    expect(prompt).toContain('同時実行数ではない');
    expect(prompt).toContain('上限遵守');
    expect(prompt).toContain('検証分離や責務分解より優先');
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

  it('Given prompt-based decomposition, When building the English prompt, Then it describes max parts as a total limit instead of concurrency', () => {
    const prompt = buildPromptBasedDecomposePrompt('implement feature', 5, 'en');

    expect(prompt).toContain('total number of parts');
    expect(prompt).toContain('between 1 and 5');
    expect(prompt).toContain('not a concurrency limit');
    expect(prompt).toContain('Respecting this limit takes precedence');
    expect(prompt).toContain('verification separation or responsibility boundaries');
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

  it('Given feedback planning, When building more-parts prompts, Then tool usage remains prohibited', () => {
    const results = [
      { id: 'part-1', title: 'Implementation', status: 'done', content: 'done' },
    ];

    const structuredPrompt = buildMorePartsPrompt(
      'implement feature',
      results,
      ['part-1'],
      2,
      'en',
    );
    const promptBasedPrompt = buildPromptBasedMorePartsPrompt(
      '実装タスク',
      results,
      ['part-1'],
      2,
      'ja',
    );

    expect(structuredPrompt).toContain('Do not use any tool');
    expect(structuredPrompt).not.toContain('read-only inspection tools');
    expect(structuredPrompt).not.toContain('Return at least one part');
    expect(promptBasedPrompt).toContain('ツールは使用しない');
    expect(promptBasedPrompt).not.toContain('読み取り専用');
    expect(promptBasedPrompt).not.toContain('少なくとも1つの part');
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
