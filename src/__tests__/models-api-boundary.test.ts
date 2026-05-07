import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readModule(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

describe('core/models public type-name boundary', () => {
  it('should expose LoggingConfig from index barrel', () => {
    const source = readModule('../core/models/index.ts');
    expect(source).toMatch(/\bLoggingConfig\b/);
  });

  it('should expose observability config types from index barrel', () => {
    const source = readModule('../core/models/index.ts');
    expect(source).toMatch(/\bObservabilityConfig\b/);
    expect(source).toMatch(/\bResolvedObservabilityConfig\b/);
  });

  it('should expose public config types exactly once in index barrel exports', () => {
    const source = readModule('../core/models/index.ts');
    for (const typeName of ['LoggingConfig', 'ObservabilityConfig', 'ResolvedObservabilityConfig']) {
      const matches = source.match(new RegExp(`\\b${typeName}\\b`, 'g')) ?? [];
      expect(matches).toHaveLength(1);
    }
  });
});
