/**
 * Unit tests for repertoire reference integrity scanner.
 *
 * Target: src/features/repertoire/remove.ts (findScopeReferences)
 *
 * Scanner searches for @scope package references in:
 *   - {root}/workflows/**\/*.yaml
 *   - {root}/provider-options/**\/*.yaml
 *   - {root}/steps/*.{yaml,yml}
 *   - {root}/preferences/workflow-categories.yaml
 *   - {root}/.takt/workflows/**\/*.yaml (project-level)
 *   - {root}/.takt/provider-options/**\/*.yaml (project-level)
 *   - {root}/.takt/steps/*.{yaml,yml} (project-level)
 *
 * Detection criteria:
 *   - Matches exact "@{owner}/{repo}" and "@{owner}/{repo}/<name>" references
 *   - Plain names without "@" are NOT detected
 *   - References to a different @scope are NOT detected
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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

  it('should detect an exact package reference in a workflow from field', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = join(workflowsDir, 'imported.yaml');
    writeFileSync(workflowFile, 'from: @nrslib/takt-ensemble-fixture\nname: imported\n');

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

  it('should detect @scope reference in global provider-options YAML', () => {
    const providerOptionsDir = join(tempDir, 'provider-options');
    mkdirSync(providerOptionsDir, { recursive: true });
    const providerOptionsFile = join(providerOptionsDir, 'review.yaml');
    writeFileSync(providerOptionsFile, 'claude:\n  allowed_tools: ["@nrslib/takt-ensemble-fixture/tool"]');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === providerOptionsFile)).toBe(true);
  });

  it('should detect @scope reference in project-level provider-options YAML', () => {
    const providerOptionsDir = join(tempDir, '.takt', 'provider-options');
    mkdirSync(providerOptionsDir, { recursive: true });
    const providerOptionsFile = join(providerOptionsDir, 'review.yaml');
    writeFileSync(providerOptionsFile, 'extends: "@nrslib/takt-ensemble-fixture/review-readonly"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === providerOptionsFile)).toBe(true);
  });

  it('should detect @scope reference in global step fragments', () => {
    const stepsDir = join(tempDir, 'steps');
    mkdirSync(stepsDir, { recursive: true });
    const stepFile = join(stepsDir, 'review.yaml');
    writeFileSync(stepFile, 'uses: "@nrslib/takt-ensemble-fixture/review"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === stepFile)).toBe(true);
  });

  it('should detect @scope reference in project-level step fragments', () => {
    const stepsDir = join(tempDir, '.takt', 'steps');
    mkdirSync(stepsDir, { recursive: true });
    const stepFile = join(stepsDir, 'review.yaml');
    writeFileSync(stepFile, 'uses: "@nrslib/takt-ensemble-fixture/review"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === stepFile)).toBe(true);
  });

  it('should ignore nested step YAML files because they cannot be resolved as fragments', () => {
    const stepsDir = join(tempDir, 'steps');
    const nestedStepFile = join(stepsDir, 'nested', 'review.yaml');
    mkdirSync(join(stepsDir, 'nested'), { recursive: true });
    writeFileSync(nestedStepFile, 'uses: "@nrslib/takt-ensemble-fixture/review"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === nestedStepFile)).toBe(false);
  });

  it('should scan workflow, provider-options, and categories targets from explicit config', () => {
    const workflowsDir = join(tempDir, 'custom-workflows');
    const providerOptionsDir = join(tempDir, 'custom-provider-options');
    const stepsDir = join(tempDir, 'custom-steps');
    const categoriesFile = join(tempDir, 'custom-categories.yaml');
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(providerOptionsDir, { recursive: true });
    mkdirSync(stepsDir, { recursive: true });
    const workflowFile = join(workflowsDir, 'flow.yaml');
    const providerOptionsFile = join(providerOptionsDir, 'readonly.yaml');
    const stepFile = join(stepsDir, 'review.yaml');
    writeFileSync(workflowFile, 'persona: "@nrslib/takt-ensemble-fixture/coder"');
    writeFileSync(providerOptionsFile, 'extends: "@nrslib/takt-ensemble-fixture/review-readonly"');
    writeFileSync(stepFile, 'uses: "@nrslib/takt-ensemble-fixture/review"');
    writeFileSync(categoriesFile, 'categories:\n  - "@nrslib/takt-ensemble-fixture/fullstack"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', {
      workflowDirs: [workflowsDir],
      providerOptionsDirs: [providerOptionsDir],
      stepsDirs: [stepsDir],
      facetPoolsDirs: [],
      categoriesFiles: [categoriesFile],
    });

    expect(refs.map((ref) => ref.filePath).sort()).toEqual([
      categoriesFile,
      providerOptionsFile,
      stepFile,
      workflowFile,
    ].sort());
  });

  it('should scan file and directory symlinks that workflow discovery can load', () => {
    const workflowsDir = join(tempDir, 'workflows');
    const outsideDir = join(tempDir, 'outside');
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'referencing.yaml');
    writeFileSync(outsideFile, 'persona: "@nrslib/takt-ensemble-fixture/coder"');
    symlinkSync(outsideFile, join(workflowsDir, 'file-link.yaml'));
    symlinkSync(outsideDir, join(workflowsDir, 'directory-link'));

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => ref.filePath)).toEqual(expect.arrayContaining([
      join(workflowsDir, 'file-link.yaml'),
      join(workflowsDir, 'directory-link', 'referencing.yaml'),
    ]));
  });

  it('should detect a root-level step fragment symlink that resolves inside the steps directory', () => {
    const stepsDir = join(tempDir, 'steps');
    const targetPath = join(stepsDir, 'source.yaml');
    const linkPath = join(stepsDir, 'review.yaml');
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(targetPath, 'uses: "@nrslib/takt-ensemble-fixture/review"');
    symlinkSync(targetPath, linkPath);

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.map((ref) => ref.filePath)).toContain(linkPath);
  });

  it('should detect a root-level step fragment symlink whose target directory begins with two dots', () => {
    const stepsDir = join(tempDir, 'steps');
    const targetDir = join(stepsDir, '..visible');
    const targetPath = join(targetDir, 'source.yaml');
    const linkPath = join(stepsDir, 'review.yaml');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetPath, 'uses: "@nrslib/takt-ensemble-fixture/review"');
    symlinkSync(targetPath, linkPath);

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.map((ref) => ref.filePath)).toContain(linkPath);
  });

  it('should scan a configured steps directory symlink through its resolved root', () => {
    const realStepsDir = join(tempDir, 'real-steps');
    const linkedStepsDir = join(tempDir, 'steps');
    const stepFile = join(linkedStepsDir, 'review.yaml');
    mkdirSync(realStepsDir, { recursive: true });
    writeFileSync(
      join(realStepsDir, 'review.yaml'),
      'uses: "@nrslib/takt-ensemble-fixture/review"',
    );
    symlinkSync(realStepsDir, linkedStepsDir);

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.map((ref) => ref.filePath)).toContain(stepFile);
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

  it('should not treat a repository name with the same prefix as a reference', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'prefix.yaml'), 'persona: "@nrslib/takt-ensemble-fixture-extra/coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs).toHaveLength(0);
  });

  it('should ignore a root-level step fragment symlink that resolves outside the steps directory', () => {
    const stepsDir = join(tempDir, 'steps');
    const outsideDir = join(tempDir, 'outside');
    const outsidePath = join(outsideDir, 'review.yaml');
    const linkPath = join(stepsDir, 'review.yaml');
    mkdirSync(stepsDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsidePath, 'uses: "@nrslib/takt-ensemble-fixture/review"');
    symlinkSync(outsidePath, linkPath);

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.map((ref) => ref.filePath)).not.toContain(linkPath);
  });
});
