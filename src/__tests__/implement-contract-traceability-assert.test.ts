import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertImplementContractTraceabilityIn } from '../../eval/asserts/implement-contract-traceability.mjs';

const candidateDirectories: string[] = [];

function createCandidate(source: string, test: string, packageJson: string): string {
  const candidateDir = mkdtempSync(join(tmpdir(), 'takt-implement-contract-candidate-'));
  candidateDirectories.push(candidateDir);
  mkdirSync(join(candidateDir, 'src'));
  mkdirSync(join(candidateDir, 'tests'));
  writeFileSync(join(candidateDir, 'src', 'session-label.js'), source);
  writeFileSync(join(candidateDir, 'tests', 'session-label.test.js'), test);
  writeFileSync(join(candidateDir, 'package.json'), packageJson);
  return candidateDir;
}

describe('implement contract traceability assertion', () => {
  afterEach(() => {
    for (const candidateDir of candidateDirectories.splice(0)) {
      rmSync(candidateDir, { recursive: true, force: true });
    }
  });

  it('should reject an incorrect implementation even when candidate tests pass', () => {
    const candidateDir = createCandidate(
      [
        'export function normalizeSessionLabel(label) {',
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label;',
        '}',
      ].join('\n'),
      "import test from 'node:test'; test('always passes', () => {});\n",
      '{"type":"module"}\n',
    );

    expect(assertImplementContractTraceabilityIn(candidateDir).pass).toBe(false);
  });

  it('should accept a correct implementation despite candidate test and package mutations', () => {
    const candidateDir = createCandidate(
      [
        'export function normalizeSessionLabel(label) {',
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label.trim();',
        '}',
      ].join('\n'),
      "throw new Error('candidate test must not run');\n",
      '{"type":"commonjs"}\n',
    );

    expect(assertImplementContractTraceabilityIn(candidateDir).pass).toBe(true);
  });
});
