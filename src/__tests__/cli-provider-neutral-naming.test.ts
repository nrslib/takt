/**
 * Regression tests: provider-neutral naming in CLI layer
 *
 * Ensures that src/app/cli/ does not contain GitHub-specific variable names
 * or help text, keeping the CLI layer provider-agnostic.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI_DIR = path.resolve(__dirname, '../app/cli');
const ADD_INDEX = path.resolve(__dirname, '../features/tasks/add/index.ts');

/** Read all .ts files from a directory (non-recursive) */
function readTsFiles(dir: string): { file: string; content: string }[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf-8') }));
}

describe('provider-neutral naming (req-gap regression)', () => {
  it('should not use ghStatus variable name in routing-inputs.ts', () => {
    const content = fs.readFileSync(path.join(CLI_DIR, 'routing-inputs.ts'), 'utf-8');
    expect(content).not.toMatch(/\bghStatus\b/);
    expect(content).toMatch(/\bcliStatus\b/);
  });

  it('should not use ghStatus variable name in add/index.ts', () => {
    const content = fs.readFileSync(ADD_INDEX, 'utf-8');
    expect(content).not.toMatch(/\bghStatus\b/);
  });
});

describe('provider-neutral CLI help text (consistency regression)', () => {
  it('should not contain "GitHub issue" in CLI help descriptions', () => {
    const files = readTsFiles(CLI_DIR);
    for (const { file, content } of files) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Only check string literals in option/argument descriptions
        if (line.match(/\.(option|argument)\s*\(/) && line.match(/GitHub issue/i)) {
          expect.fail(`${file}:${i + 1} contains "GitHub issue" in CLI description: ${line.trim()}`);
        }
      }
    }
  });
});
