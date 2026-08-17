import { describe, expect, it } from 'vitest';
import {
  providerKeepsAllowedToolWithoutEdit,
  providerSupportsAllowedTools,
  providerSupportsClaudeAllowedTools,
  providerSupportsMaxTurns,
  providerSupportsMcpServers,
  providerSupportsNativeImageInput,
  providerSupportsStructuredOutput,
} from '../infra/providers/provider-capabilities.js';

describe('provider capabilities module boundary', () => {
  it('provider-neutral な allowedTools capability は opencode を許可し cursor と codex を拒否する', () => {
    expect(providerSupportsAllowedTools('claude')).toBe(true);
    expect(providerSupportsAllowedTools('opencode')).toBe(true);
    expect(providerSupportsAllowedTools('pi')).toBe(true);
    expect(providerSupportsAllowedTools('cursor')).toBe(false);
    expect(providerSupportsAllowedTools('codex')).toBe(false);
  });

  it('claude 専用 allowedTools と mcp_servers の既存 capability 契約は維持する', () => {
    expect(providerSupportsClaudeAllowedTools('claude')).toBe(true);
    expect(providerSupportsClaudeAllowedTools('opencode')).toBe(false);
    expect(providerSupportsMcpServers('claude')).toBe(true);
    expect(providerSupportsMcpServers('opencode')).toBe(false);
  });

  it('mcp_servers は allowedTools と同様に provider ごとの明示 capability で管理する', () => {
    expect(providerSupportsAllowedTools('claude')).toBe(true);
    expect(providerSupportsMcpServers('claude')).toBe(true);
    expect(providerSupportsAllowedTools('opencode')).toBe(true);
    expect(providerSupportsMcpServers('opencode')).toBe(false);
    expect(providerSupportsAllowedTools('pi')).toBe(true);
    expect(providerSupportsMcpServers('pi')).toBe(false);
    expect(providerSupportsAllowedTools('cursor')).toBe(false);
    expect(providerSupportsMcpServers('cursor')).toBe(false);
    expect(providerSupportsAllowedTools('codex')).toBe(false);
    expect(providerSupportsMcpServers('codex')).toBe(false);
    expect(providerSupportsAllowedTools('deepseek-harness')).toBe(false);
    expect(providerSupportsMcpServers('deepseek-harness')).toBe(false);
  });

  it('maxTurns capability は SDK payload 非対応 provider を明示的に拒否する', () => {
    expect(providerSupportsMaxTurns('claude')).toBe(true);
    expect(providerSupportsMaxTurns('claude-terminal')).toBe(false);
    expect(providerSupportsMaxTurns('opencode')).toBe(false);
    expect(providerSupportsMaxTurns('pi')).toBe(false);
    expect(providerSupportsMaxTurns('deepseek-harness')).toBe(false);
  });

  it('native image input capability は SDK に実画像を渡せる provider だけを許可する', () => {
    expect(providerSupportsNativeImageInput('codex')).toBe(true);
    expect(providerSupportsNativeImageInput('claude-sdk')).toBe(true);
    expect(providerSupportsNativeImageInput('claude')).toBe(false);
    expect(providerSupportsNativeImageInput('claude-terminal')).toBe(false);
    expect(providerSupportsNativeImageInput('opencode')).toBe(false);
    expect(providerSupportsNativeImageInput('pi')).toBe(true);
    expect(providerSupportsNativeImageInput('deepseek-harness')).toBe(false);
  });

  it('Pi と DeepSeek Harness は structured output をサポートしない', () => {
    expect(providerSupportsStructuredOutput('pi')).toBe(false);
    expect(providerSupportsStructuredOutput('deepseek-harness')).toBe(false);
  });

  it('非編集 step の allowedTools 判定は provider capability 境界に閉じる', () => {
    expect(providerKeepsAllowedToolWithoutEdit('opencode', 'apply_patch')).toBe(false);
    expect(providerKeepsAllowedToolWithoutEdit('opencode', 'Edit')).toBe(false);
    expect(providerKeepsAllowedToolWithoutEdit('opencode', 'read')).toBe(true);
    expect(providerKeepsAllowedToolWithoutEdit('claude', 'Write')).toBe(false);
    expect(providerKeepsAllowedToolWithoutEdit('codex', 'Write')).toBe(true);
  });
});
