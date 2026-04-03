import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NON_FAST_FORWARD_PUSH_HINT } from '../infra/task/git.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('NFF hint DRY (#557)', () => {
  it('test sources do not embed the full NON_FAST_FORWARD_PUSH_HINT string', () => {
    for (const name of readdirSync(here)) {
      if (!name.endsWith('.test.ts')) continue;
      const content = readFileSync(path.join(here, name), 'utf8');
      expect(content, name).not.toContain(NON_FAST_FORWARD_PUSH_HINT);
    }
  });
});
