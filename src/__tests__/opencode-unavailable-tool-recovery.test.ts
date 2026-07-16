import { describe, it, expect } from 'vitest';
import { parseServerAvailableTools } from '../infra/opencode/unavailable-tool-recovery.js';

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
