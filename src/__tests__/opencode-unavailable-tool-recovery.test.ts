/**
 * unavailable-tool recovery のツール一覧生成の単体テスト（v3-r4 死因の再発防止）。
 *
 * v3-r4: opencode 1.17.18 に存在しない 'list' の呼び出しループで recovery が
 * 発動したが、前置文の有効ツール一覧が TAKT の写像（'list' を含む）から生成
 * されており、「'list' は存在しない」と言った直後に 'list' を利用可能と
 * 再誘導 → fresh session 後も同名再発 → 確定失敗した。
 *
 * codex 裁定: 有効一覧はサーバ申告（エラー文の Available tools）が厳密に
 * 解析できたときだけ断定する。解析は全トークンをツール名文法で検証し、
 * 1件でも契約外なら列挙全体を破棄する。解析できないときは「完全一覧」の
 * 断定自体を出さない。
 */
import { describe, it, expect } from 'vitest';
import {
  buildUnavailableToolRetryPrompt,
  parseServerAvailableTools,
} from '../infra/opencode/unavailable-tool-recovery.js';

describe('parseServerAvailableTools', () => {
  it('parses the server-reported list and excludes the internal invalid pseudo-tool', () => {
    const message = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, invalid, read, skill, todowrite, webfetch, write.";
    expect(parseServerAvailableTools(message)).toEqual([
      'bash', 'edit', 'glob', 'grep', 'read', 'skill', 'todowrite', 'webfetch', 'write',
    ]);
  });

  it('excludes the invalid pseudo-tool case-insensitively', () => {
    expect(parseServerAvailableTools('Available tools: bash, Invalid, read.')).toEqual(['bash', 'read']);
    expect(parseServerAvailableTools('Available tools: bash, INVALID, read.')).toEqual(['bash', 'read']);
  });

  // codex 実測の崩れ形式3つ: 部分一致の切り詰めや壊れトークンを
  // 解析成功と誤認せず、列挙全体を破棄して undefined に倒す。
  it('rejects malformed enumerations wholesale instead of mis-parsing them', () => {
    expect(parseServerAvailableTools('Available tools: foo.bar, read.')).toBeUndefined();
    expect(parseServerAvailableTools('Available tools: bash; read.')).toBeUndefined();
    expect(parseServerAvailableTools('Available tools: none.')).toBeUndefined();
  });

  it('returns undefined for messages without an Available tools enumeration', () => {
    expect(parseServerAvailableTools('Model tried to call unavailable tool "x".')).toBeUndefined();
    expect(parseServerAvailableTools('')).toBeUndefined();
    expect(parseServerAvailableTools('Available tools: .')).toBeUndefined();
  });
});

describe('buildUnavailableToolRetryPrompt', () => {
  it('guides the phantom list tool to glob / bash ls instead of re-advertising it (v3-r4)', () => {
    const serverTools = ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'todowrite', 'webfetch', 'write'];
    const prompt = buildUnavailableToolRetryPrompt('fix the findings', 'list', serverTools);

    expect(prompt).toContain('repeatedly called a tool named "list"');
    expect(prompt).toContain('There is no "list" tool');
    expect(prompt).toContain('"glob"');
    expect(prompt).toContain('`ls`');
    const availableLine = prompt.split('\n').find((line) => line.includes('available in this session')) ?? '';
    expect(availableLine).not.toMatch(/\blist\b/);
  });

  it('guides a hallucinated ls tool to bash', () => {
    const serverTools = ['bash', 'glob', 'grep', 'read'];
    const prompt = buildUnavailableToolRetryPrompt('inspect the repo', 'ls', serverTools);
    expect(prompt).toContain('There is no "ls" tool');
    expect(prompt).toContain('"bash"');
  });

  // codex 裁定: サーバ申告が解析できないとき、「利用可能ツールの完全一覧」
  // という断定自体を出さない（静的写像は誇大宣伝になる）。
  it('never asserts a complete tool list when the server enumeration could not be parsed', () => {
    const prompt = buildUnavailableToolRetryPrompt('fix the findings', 'list', undefined);

    expect(prompt).not.toContain('Only the following tools are available');
    // 偽の完全一覧（写像由来の websearch / patch 等のカンマ列挙）が現れない。
    expect(prompt).not.toContain('websearch');
    expect(prompt).not.toContain(', patch,');
    // 具体的誘導は出す: 幻覚名の再呼び出し禁止 + 標準ツールへの誘導。
    expect(prompt).toContain('Do not call "list" again');
    expect(prompt).toContain('"glob"');
  });
});
