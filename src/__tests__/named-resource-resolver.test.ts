import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNamedResourceWithSource } from '../infra/config/loaders/namedResourceResolver.js';

describe('resolveNamedResourceWithSource', () => {
  it('should return the first matching file by candidate directory order', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-'));
    try {
      const projectDir = join(tempDir, 'project');
      const globalDir = join(tempDir, 'global');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(projectDir, 'review.yml'), 'project\n');
      writeFileSync(join(globalDir, 'review.yaml'), 'global\n');

      const result = resolveNamedResourceWithSource('review', {
        candidateDirs: [projectDir, globalDir],
        extensions: ['.yaml', '.yml'],
      });

      expect(result?.path).toBe(join(projectDir, 'review.yml'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return undefined when no candidate file exists', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-missing-'));
    try {
      const providerOptionsDir = join(tempDir, 'provider-options');
      mkdirSync(providerOptionsDir, { recursive: true });

      const result = resolveNamedResourceWithSource('missing', {
        candidateDirs: [providerOptionsDir],
        extensions: ['.yaml', '.yml'],
      });

      expect(result).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return source candidate directory details for the first matching file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-source-'));
    try {
      const projectDir = join(tempDir, 'project');
      const globalDir = join(tempDir, 'global');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'review.yaml'), 'global\n');

      const result = resolveNamedResourceWithSource('review', {
        candidateDirs: [projectDir, globalDir],
        extensions: ['.yaml', '.yml'],
      });

      expect(result).toEqual({
        path: join(globalDir, 'review.yaml'),
        candidateDir: globalDir,
        candidateDirIndex: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should reject path-like resource names', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-invalid-'));
    try {
      const providerOptionsDir = join(tempDir, 'provider-options');
      mkdirSync(providerOptionsDir, { recursive: true });

      expect(() => resolveNamedResourceWithSource('../review', {
        candidateDirs: [providerOptionsDir],
        extensions: ['.yaml', '.yml'],
      })).toThrow(/bare name/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should reject a symlinked candidate directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-dir-symlink-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-dir-symlink-outside-'));
    try {
      const candidateDir = join(tempDir, 'provider-options');
      writeFileSync(join(outsideDir, 'review.yaml'), 'outside\n');
      symlinkSync(outsideDir, candidateDir);

      expect(() => resolveNamedResourceWithSource('review', {
        candidateDirs: [candidateDir],
        extensions: ['.yaml', '.yml'],
      })).toThrow(/candidate directory must not be a symlink/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
