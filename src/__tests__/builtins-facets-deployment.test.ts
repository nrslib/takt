import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('builtins facets deployment resources', () => {
  it('should not keep legacy templates directories in builtins languages', () => {
    const builtinRootDir = join(process.cwd(), 'builtins');

    const jaTemplatesDir = join(builtinRootDir, 'ja', 'templates');
    const enTemplatesDir = join(builtinRootDir, 'en', 'templates');

    expect(existsSync(jaTemplatesDir)).toBe(false);
    expect(existsSync(enTemplatesDir)).toBe(false);
  });
});
