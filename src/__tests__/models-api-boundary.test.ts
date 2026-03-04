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

  it('should not expose legacy ObservabilityConfig from index barrel', () => {
    const source = readModule('../core/models/index.ts');
    expect(source).not.toMatch(/\bObservabilityConfig\b/);
  });

  it('should expose LoggingConfig exactly once in index barrel exports', () => {
    const source = readModule('../core/models/index.ts');
    const matches = source.match(/\bLoggingConfig\b/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
