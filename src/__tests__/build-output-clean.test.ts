import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanBuildOutput } from '../../scripts/clean-build-output.mjs';

interface PackageManifest {
  readonly scripts: Record<string, string>;
}

describe('build output cleanup', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes stale generated files without touching project sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-build-output-clean-'));
    roots.push(root);
    mkdirSync(join(root, 'dist', 'core'), { recursive: true });
    writeFileSync(join(root, 'dist', 'core', 'removed-module.js'), 'stale output');
    writeFileSync(join(root, 'source.ts'), 'export const current = true;\n');

    cleanBuildOutput(root);

    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(readFileSync(join(root, 'source.ts'), 'utf8')).toBe('export const current = true;\n');
  });

  it('runs cleanup before compiling the package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as PackageManifest;

    expect(manifest.scripts.build).toBe(
      'node scripts/clean-build-output.mjs && tsc && tsc -p tsconfig.opencode-probe.json && node scripts/copy-build-assets.mjs',
    );
  });
});
