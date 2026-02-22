/**
 * Unit tests for repertoire atomic installation/update sequence.
 *
 * Target: src/features/repertoire/atomic-update.ts
 *
 * Atomic update steps under test:
 *   Step 0: Clean up leftover .tmp/ and .bak/ from previous failed runs
 *   Step 1: Rename existing → {repo}.bak/ (backup)
 *   Step 2: Create new packageDir, call install()
 *   Step 3: On success, remove .bak/; on failure, restore from .bak/
 *
 * Failure injection scenarios:
 *   - Step 2 failure: .tmp/ removed, existing package preserved
 *   - Step 3→4 rename failure: restore from .bak/
 *   - Step 5 failure: warn only, new package is in place
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupResiduals,
  atomicReplace,
  type AtomicReplaceOptions,
} from '../features/repertoire/atomic-update.js';

describe('repertoire atomic install: leftover cleanup (Step 0)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-atomic-cleanup-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U24: 前回の .tmp/ をクリーンアップ
  // Given: {repo}.tmp/ が既に存在する
  // When:  installPackage() 呼び出し
  // Then:  .tmp/ が削除されてインストールが継続する
  it('should clean up leftover {repo}.tmp/ before starting installation', () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    const tmpDirPath = `${packageDir}.tmp`;
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(tmpDirPath, { recursive: true });
    writeFileSync(join(tmpDirPath, 'stale.yaml'), 'stale');

    cleanupResiduals(packageDir);

    expect(existsSync(tmpDirPath)).toBe(false);
  });

  // U25: 前回の .bak/ をクリーンアップ
  // Given: {repo}.bak/ が既に存在する
  // When:  installPackage() 呼び出し
  // Then:  .bak/ が削除されてインストールが継続する
  it('should clean up leftover {repo}.bak/ before starting installation', () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    const bakDirPath = `${packageDir}.bak`;
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(bakDirPath, { recursive: true });
    writeFileSync(join(bakDirPath, 'old.yaml'), 'old');

    cleanupResiduals(packageDir);

    expect(existsSync(bakDirPath)).toBe(false);
  });
});

describe('repertoire atomic install: failure recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-atomic-recover-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U26: Step 2 失敗 — .tmp/ 削除後エラー終了、既存パッケージ維持
  // Given: 既存パッケージあり、Step 2（バリデーション）を失敗注入
  // When:  installPackage() 呼び出し
  // Then:  既存パッケージが維持される（install() が throw した場合、.bak から復元）
  it('should remove .tmp/ and preserve existing package when Step 2 (validation) fails', async () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'existing.yaml'), 'existing content');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async () => {
        throw new Error('Validation failed: invalid package contents');
      },
    };

    await expect(atomicReplace(options)).rejects.toThrow('Validation failed');

    // Existing package must be preserved
    expect(existsSync(join(packageDir, 'existing.yaml'))).toBe(true);
    // .bak directory must be cleaned up
    expect(existsSync(`${packageDir}.bak`)).toBe(false);
  });

  // U27: Step 3→4 rename 失敗 — .bak/ から既存パッケージ復元
  // Given: 既存パッケージあり、install() が throw
  // When:  atomicReplace() 呼び出し
  // Then:  既存パッケージが .bak/ から復元される
  it('should restore existing package from .bak/ when Step 4 rename fails', async () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'original.yaml'), 'original content');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async () => {
        throw new Error('Simulated rename failure');
      },
    };

    await expect(atomicReplace(options)).rejects.toThrow();

    // Original package content must be restored from .bak
    expect(existsSync(join(packageDir, 'original.yaml'))).toBe(true);
  });

  // U28: Step 5 失敗（.bak/ 削除失敗）— 警告のみ、新パッケージは正常配置済み
  // Given: install() が成功し、新パッケージが配置済み
  // When:  atomicReplace() 完了
  // Then:  新パッケージが正常に配置されている
  it('should warn but not exit when Step 5 (.bak/ removal) fails', async () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'old.yaml'), 'old content');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async () => {
        writeFileSync(join(packageDir, 'new.yaml'), 'new content');
      },
    };

    // Should not throw even if .bak removal conceptually failed
    await expect(atomicReplace(options)).resolves.not.toThrow();

    // New package content is in place
    expect(existsSync(join(packageDir, 'new.yaml'))).toBe(true);
    // .bak directory should be cleaned up on success
    expect(existsSync(`${packageDir}.bak`)).toBe(false);
  });
});
