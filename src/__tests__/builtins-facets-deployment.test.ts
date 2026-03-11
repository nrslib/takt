import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('builtins facets deployment resources', () => {
  it('should not keep legacy templates directories in builtins languages', () => {
    const builtinRootDir = join(process.cwd(), 'builtins');

    const jaTemplatesDir = join(builtinRootDir, 'ja', 'templates');
    const enTemplatesDir = join(builtinRootDir, 'en', 'templates');

    expect(existsSync(jaTemplatesDir)).toBe(false);
    expect(existsSync(enTemplatesDir)).toBe(false);
  });

  it('should reference facets paths instead of templates paths in ja style guides', () => {
    const jaRootDir = join(process.cwd(), 'builtins', 'ja');
    const guidePaths = [
      'STYLE_GUIDE.md',
      'PERSONA_STYLE_GUIDE.md',
      'POLICY_STYLE_GUIDE.md',
      'INSTRUCTION_STYLE_GUIDE.md',
      'KNOWLEDGE_STYLE_GUIDE.md',
      'OUTPUT_CONTRACT_STYLE_GUIDE.md',
    ];

    for (const guidePath of guidePaths) {
      const guideText = readFileSync(join(jaRootDir, guidePath), 'utf-8');
      expect(guideText).toContain('facets/');
      expect(guideText).not.toContain('templates/');
    }
  });
});
