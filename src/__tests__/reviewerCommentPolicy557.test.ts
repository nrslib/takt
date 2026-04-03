import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

const AAA_SCAFFOLD = /^\s*\/\/\s*(Given|When|Then)(\s|:|$)/i;

describe('reviewer comment policy (#557)', () => {
  for (const file of [
    'postExecution.test.ts',
    'taskGit.test.ts',
    'clone.test.ts',
    'resolveTask.test.ts',
    'taskExecution.test.ts',
    'addTask.test.ts',
    'saveTaskFile.test.ts',
    'taskListSerializer.test.ts',
    'nffHintDry557.test.ts',
    'reviewerCommentPolicy557.test.ts',
  ] as const) {
    it(`${file} has no // Given/When/Then explanation comment lines`, () => {
      const content = readFileSync(path.join(here, file), 'utf8');
      const badLines = content.split('\n').filter((line) => AAA_SCAFFOLD.test(line));
      expect(badLines, badLines.join('\n')).toEqual([]);
    });
  }
});
