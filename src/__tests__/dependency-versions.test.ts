import { execFileSync } from 'node:child_process';
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

  it('resolves traced-config through its public entrypoint', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const resolved = import.meta.resolve('traced-config'); const mod = await import('traced-config'); process.stdout.write(JSON.stringify({ resolved, hasFactory: typeof mod.tracedConfig === 'function' }));",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    const result = JSON.parse(stdout) as { resolved: string; hasFactory: boolean };
    expect(result.resolved.startsWith('file://')).toBe(true);
    expect(result.hasFactory).toBe(true);
  });
});
