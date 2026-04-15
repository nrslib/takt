import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readModule(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

describe('workflow types module boundary', () => {
  it('keeps src/core/workflow/types.ts under the 300-line architecture limit', () => {
    const source = readModule('../core/workflow/types.ts');
    expect(source.trimEnd().split('\n').length).toBeLessThanOrEqual(299);
  });

  it('moves provider option trace contracts into a sibling module', () => {
    const workflowTypesSource = readModule('../core/workflow/types.ts');
    const providerTraceSource = readModule('../core/workflow/provider-options-trace.ts');

    expect(workflowTypesSource).not.toContain('export type ProviderOptionsSource =');
    expect(workflowTypesSource).not.toContain('export type ProviderOptionsTraceOrigin =');
    expect(workflowTypesSource).not.toContain('export type ProviderOptionsOriginResolver =');
    expect(providerTraceSource).toContain("export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';");
    expect(providerTraceSource).toContain(
      "export type ProviderOptionsTraceOrigin = 'env' | 'cli' | 'local' | 'global' | 'default';",
    );
    expect(providerTraceSource).toContain(
      'export type ProviderOptionsOriginResolver = (path: string) => ProviderOptionsTraceOrigin;',
    );
  });
});
