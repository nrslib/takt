import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dependency versions', () => {
  it('locks yaml to the patched 2.8.3 release', () => {
    const packageLock = JSON.parse(
      readFileSync(join(process.cwd(), 'package-lock.json'), 'utf-8'),
    ) as {
      packages?: Record<string, { version?: string }>;
    };

    expect(packageLock.packages?.['node_modules/yaml']?.version).toBe('2.8.3');
  });
});
