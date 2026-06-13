import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  providerKeepsAllowedToolWithoutEdit,
  providerSupportsAllowedTools,
  providerSupportsClaudeAllowedTools,
  providerSupportsMaxTurns,
  providerSupportsMcpServers,
  providerSupportsNativeImageInput,
} from '../infra/providers/provider-capabilities.js';

function readModuleSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

describe('provider capabilities module boundary', () => {
  it('必要な predicate helper のみを公開する', () => {
    const source = readModuleSource('../infra/providers/provider-capabilities.ts');

    expect(source).toContain('export function providerSupportsAllowedTools');
    expect(source).toContain('export function providerSupportsStructuredOutput');
    expect(source).toContain('export function providerSupportsMcpServers');
    expect(source).toContain('export function providerSupportsClaudeAllowedTools');
    expect(source).toContain('export function providerSupportsMaxTurns');
    expect(source).toContain('export function providerSupportsNativeImageInput');
    expect(source).toContain('export function providerKeepsAllowedToolWithoutEdit');
    expect(source).not.toContain('export interface ProviderCapabilities');
    expect(source).not.toContain('export function resolveProviderCapabilities');
  });

  it('provider-neutral な allowedTools capability は opencode を許可し cursor と codex を拒否する', () => {
    expect(providerSupportsAllowedTools('claude')).toBe(true);
    expect(providerSupportsAllowedTools('opencode')).toBe(true);
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
    expect(providerSupportsAllowedTools('cursor')).toBe(false);
    expect(providerSupportsMcpServers('cursor')).toBe(false);
    expect(providerSupportsAllowedTools('codex')).toBe(false);
    expect(providerSupportsMcpServers('codex')).toBe(false);
  });

  it('maxTurns capability は claude-terminal を明示的に拒否する', () => {
    expect(providerSupportsMaxTurns('claude')).toBe(true);
    expect(providerSupportsMaxTurns('claude-terminal')).toBe(false);
  });

  it('native image input capability は SDK に実画像を渡せる provider だけを許可する', () => {
    expect(providerSupportsNativeImageInput('codex')).toBe(true);
    expect(providerSupportsNativeImageInput('claude-sdk')).toBe(true);
    expect(providerSupportsNativeImageInput('claude')).toBe(false);
    expect(providerSupportsNativeImageInput('claude-terminal')).toBe(false);
    expect(providerSupportsNativeImageInput('opencode')).toBe(false);
  });

  it('非編集 step の allowedTools 判定は provider capability 境界に閉じる', () => {
    const engineSource = readModuleSource('../core/workflow/engine/engine-provider-options.ts');

    expect(providerKeepsAllowedToolWithoutEdit('opencode', 'apply_patch')).toBe(false);
    expect(providerKeepsAllowedToolWithoutEdit('opencode', 'Edit')).toBe(false);
    expect(providerKeepsAllowedToolWithoutEdit('opencode', 'read')).toBe(true);
    expect(providerKeepsAllowedToolWithoutEdit('claude', 'Write')).toBe(false);
    expect(providerKeepsAllowedToolWithoutEdit('codex', 'Write')).toBe(true);
    expect(engineSource).not.toContain('OPENCODE_EDIT_PERMISSION_TOOL_NAMES');
    expect(engineSource).not.toContain('mapsToOpenCodeEditPermission');
  });

  it('provider capability 境界は OpenCode 実装詳細を直接 import しない', () => {
    const source = readModuleSource('../infra/providers/provider-capabilities.ts');

    expect(source).not.toContain('../opencode/');
    expect(source).not.toContain('mapsToOpenCodeEditPermission');
  });
});
