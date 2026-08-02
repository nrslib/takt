import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it('should reject a case-normalizing implementation', () => {
    const candidateDir = createCandidate(
      [
        'export function normalizeSessionLabel(label) {',
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label.trim().toLowerCase();',
        '}',
      ].join('\n'),
      '',
      '{}\n',
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

  it.each([
    'export default function normalizeSessionLabel(label) {',
    'export async function normalizeSessionLabel(label) {',
    'export function* normalizeSessionLabel(label) {',
  ])('should reject a non-named-synchronous function: %s', (declaration) => {
    const candidateDir = createCandidate(
      [
        declaration,
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label.trim();',
        '}',
      ].join('\n'),
      '',
      '{}\n',
    );

    expect(assertImplementContractTraceabilityIn(candidateDir).pass).toBe(false);
  });

  it('should reject a source file reached through a parent directory symlink', () => {
    const candidateDir = createCandidate(
      'export function normalizeSessionLabel(label) { return label; }\n',
      '',
      '{}\n',
    );
    const externalSourceDirectory = mkdtempSync(join(tmpdir(), 'takt-implement-contract-external-'));
    candidateDirectories.push(externalSourceDirectory);
    writeFileSync(
      join(externalSourceDirectory, 'session-label.js'),
      [
        'export function normalizeSessionLabel(label) {',
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label.trim();',
        '}',
      ].join('\n'),
    );
    rmSync(join(candidateDir, 'src'), { recursive: true });
    symlinkSync(
      externalSourceDirectory,
      join(candidateDir, 'src'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(assertImplementContractTraceabilityIn(candidateDir).pass).toBe(false);
  });

  it('should inspect candidate source without executing top-level code', () => {
    const markerDirectory = mkdtempSync(join(tmpdir(), 'takt-implement-contract-marker-'));
    candidateDirectories.push(markerDirectory);
    const markerPath = join(markerDirectory, 'executed');
    const candidateDir = createCandidate(
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'executed');`,
        'export function normalizeSessionLabel(label) {',
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label.trim();',
        '}',
      ].join('\n'),
      '',
      '{}\n',
    );

    expect(assertImplementContractTraceabilityIn(candidateDir).pass).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    [
      'host filesystem',
      "import { readFileSync } from 'node:fs'; readFileSync('/');",
    ],
    [
      'child processes',
      "import { spawnSync } from 'node:child_process'; spawnSync(process.execPath, ['--version']);",
    ],
    [
      'network',
      "import { createServer } from 'node:net'; createServer().listen(0);",
    ],
    [
      'inherited environment',
      "if (process.env.TAKT_EVAL_HOST_SECRET) throw new Error('host environment leaked');",
    ],
    [
      'process termination',
      'process.exit(0);',
    ],
  ])('should reject candidate access to %s', (_capability, attemptedAccess) => {
    const candidateDir = createCandidate(
      [
        attemptedAccess,
        'export function normalizeSessionLabel(label) {',
        "  if (typeof label !== 'string') throw new TypeError('label must be a string');",
        '  return label.trim();',
        '}',
      ].join('\n'),
      '',
      '{}\n',
    );

    expect(assertImplementContractTraceabilityIn(candidateDir).pass).toBe(false);
  });
});
