/**
 * Unit tests for repertoire reference integrity scanner.
 *
 * Target: src/features/repertoire/remove.ts (findScopeReferences)
 *
 * Scanner searches for @scope package references in:
 *   - {root}/workflows/**\/*.yaml
 *   - {root}/preferences/workflow-categories.yaml
 *   - {root}/.takt/workflows/**\/*.yaml (project-level)
 *
 * Detection criteria:
 *   - Matches "@{owner}/{repo}" substring in file contents
 *   - Plain names without "@" are NOT detected
 *   - References to a different @scope are NOT detected
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findScopeReferences } from '../features/repertoire/remove.js';
import { makeScanConfig } from './helpers/repertoire-test-helpers.js';

describe('repertoire reference integrity: detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-ref-integrity-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U29: ~/.takt/workflows/ の @scope 参照を検出
  // Given: {root}/workflows/my-review.yaml に
  //        persona: "@nrslib/takt-ensemble-fixture/expert-coder" を含む
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  my-review.yaml が検出される
  it('should detect @scope reference in global workflows YAML', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = join(workflowsDir, 'my-review.yaml');
    writeFileSync(workflowFile, 'persona: "@nrslib/takt-ensemble-fixture/expert-coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === workflowFile)).toBe(true);
  });

  // U30: {root}/preferences/workflow-categories.yaml の @scope 参照を検出
  // Given: workflow-categories.yaml に @nrslib/takt-ensemble-fixture/expert を含む
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  workflow-categories.yaml が検出される
  it('should detect @scope reference in global workflow-categories.yaml', () => {
    const prefsDir = join(tempDir, 'preferences');
    mkdirSync(prefsDir, { recursive: true });
    const categoriesFile = join(prefsDir, 'workflow-categories.yaml');
    writeFileSync(categoriesFile, 'categories:\n  - "@nrslib/takt-ensemble-fixture/expert"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === categoriesFile)).toBe(true);
  });

  // U31: {root}/.takt/workflows/ の @scope 参照を検出
  // Given: プロジェクト {root}/.takt/workflows/proj.yaml に @scope 参照
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  proj.yaml が検出される
  it('should detect @scope reference in project-level workflows YAML', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    const projFile = join(projectWorkflowsDir, 'proj.yaml');
    writeFileSync(projFile, 'persona: "@nrslib/takt-ensemble-fixture/expert-coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === projFile)).toBe(true);
  });
});

describe('repertoire reference integrity: non-detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-ref-nodetect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U32: @scope なし参照は検出しない
  // Given: persona: "coder" のみ（@scope なし）
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  結果が空配列
  it('should not detect plain name references without @scope prefix', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'plain.yaml'), 'persona: "coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs).toHaveLength(0);
  });

  // U33: 別スコープは検出しない
  // Given: persona: "@other/package/name"
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  結果が空配列
  it('should not detect references to a different @scope package', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'other.yaml'), 'persona: "@other/package/name"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs).toHaveLength(0);
  });
});
