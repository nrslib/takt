import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('yaml-schema reference', () => {
  it('normal movement examples should not duplicate instruction keys in one movement block', () => {
    const schemaPath = join(process.cwd(), 'builtins', 'skill', 'references', 'yaml-schema.md');
    const schemaText = readFileSync(schemaPath, 'utf-8');
    const normalSectionMatch = schemaText.match(/### 通常 Movement([\s\S]*?)### Parallel Movement/);

    expect(normalSectionMatch).not.toBeNull();
    const normalSection = normalSectionMatch![1];
    const yamlBlocks = [...normalSection.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);

    expect(yamlBlocks.length).toBeGreaterThan(0);

    const hasDuplicatedInstruction = yamlBlocks.some((block) => {
      const instructionKeys = block
        .split('\n')
        .filter((line) => /^ {2}instruction:\s/.test(line));
      return instructionKeys.length > 1;
    });

    expect(hasDuplicatedInstruction).toBe(false);
  });

  it('normal movement examples should not duplicate policy keys in one movement block', () => {
    const schemaPath = join(process.cwd(), 'builtins', 'skill', 'references', 'yaml-schema.md');
    const schemaText = readFileSync(schemaPath, 'utf-8');
    const normalSectionMatch = schemaText.match(/### 通常 Movement([\s\S]*?)### Parallel Movement/);

    expect(normalSectionMatch).not.toBeNull();
    const normalSection = normalSectionMatch![1];
    const yamlBlocks = [...normalSection.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);

    expect(yamlBlocks.length).toBeGreaterThan(0);

    const hasDuplicatedPolicy = yamlBlocks.some((block) => {
      const policyKeys = block
        .split('\n')
        .filter((line) => /^ {2}policy:\s/.test(line));
      return policyKeys.length > 1;
    });

    expect(hasDuplicatedPolicy).toBe(false);
  });
});
