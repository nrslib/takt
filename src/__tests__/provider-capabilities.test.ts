import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readModuleSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

describe('provider capabilities module boundary', () => {
  it('必要な predicate helper のみを公開する', () => {
    const source = readModuleSource('../infra/providers/provider-capabilities.ts');

    expect(source).toContain('export function providerSupportsStructuredOutput');
    expect(source).toContain('export function providerSupportsMcpServers');
    expect(source).toContain('export function providerSupportsClaudeAllowedTools');
    expect(source).not.toContain('export interface ProviderCapabilities');
    expect(source).not.toContain('export function resolveProviderCapabilities');
  });
});
