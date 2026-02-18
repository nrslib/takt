/**
 * Integration test for dotgitignore
 *
 * Verifies that .takt/.gitignore patterns correctly track facet directories
 * (pieces, personas, policies, knowledge, instructions, output-contracts)
 * while ignoring runtime directories (tasks, logs, runs, completed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

function gitTrackedFiles(cwd: string): string[] {
  const output = execFileSync('git', ['ls-files', '.takt/'], { cwd, encoding: 'utf-8' });
  return output.trim().split('\n').filter(Boolean).sort();
}

describe('dotgitignore patterns', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-dotgitignore-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });

    // Initial commit
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

    // Copy actual dotgitignore as .takt/.gitignore
    const dotgitignorePath = join(__dirname, '..', '..', 'builtins', 'project', 'dotgitignore');
    const taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    const content = readFileSync(dotgitignorePath, 'utf-8');
    writeFileSync(join(taktDir, '.gitignore'), content);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should track config.yaml', () => {
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'language: ja\n');
    execFileSync('git', ['add', '.takt/'], { cwd: testDir });

    const tracked = gitTrackedFiles(testDir);
    expect(tracked).toContain('.takt/config.yaml');
  });

  it('should track facet directories', () => {
    const facets = ['pieces', 'personas', 'policies', 'knowledge', 'instructions', 'output-contracts'];
    for (const facet of facets) {
      mkdirSync(join(testDir, '.takt', facet), { recursive: true });
      writeFileSync(join(testDir, '.takt', facet, 'test.md'), `# ${facet}`);
    }

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    for (const facet of facets) {
      expect(tracked).toContain(`.takt/${facet}/test.md`);
    }
  });

  it('should track nested files in facet directories', () => {
    mkdirSync(join(testDir, '.takt', 'pieces', 'sub'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'pieces', 'sub', 'nested.yaml'), 'name: test');

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    expect(tracked).toContain('.takt/pieces/sub/nested.yaml');
  });

  it('should ignore runtime directories', () => {
    const runtimeDirs = ['tasks', 'completed', 'logs', 'runs'];
    for (const dir of runtimeDirs) {
      mkdirSync(join(testDir, '.takt', dir), { recursive: true });
      writeFileSync(join(testDir, '.takt', dir, 'data.json'), '{}');
    }

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    for (const dir of runtimeDirs) {
      const runtimeFiles = tracked.filter(f => f.startsWith(`.takt/${dir}/`));
      expect(runtimeFiles).toEqual([]);
    }
  });
});
