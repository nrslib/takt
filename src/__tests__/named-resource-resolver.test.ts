import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it.each([' review', 'review ', 'review\nnext', 'review\u0000next'])(
    'should reject whitespace and control characters in a bare resource name: %j',
    (name) => {
      expect(() => resolveNamedResourceWithSource(name, {
        candidateDirs: [],
        extensions: ['.yaml', '.yml'],
      })).toThrow(/bare name/i);
    },
  );

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

  it('should resolve a symlink whose target is inside a candidate directory beginning with two dots', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-dot-prefix-'));
    try {
      const candidateDir = join(tempDir, 'steps');
      const targetDir = join(candidateDir, '..visible');
      const targetPath = join(targetDir, 'review.yaml');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetPath, 'review\n');
      symlinkSync(targetPath, join(candidateDir, 'review.yaml'));

      const result = resolveNamedResourceWithSource('review', {
        candidateDirs: [candidateDir],
        extensions: ['.yaml', '.yml'],
      });

      expect(result?.path).toBe(join(candidateDir, 'review.yaml'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should continue to a lower-priority root when an empty symlinked candidate directory has no matching file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-empty-dir-symlink-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-empty-dir-symlink-outside-'));
    try {
      const symlinkedDir = join(tempDir, 'project-provider-options');
      const globalDir = join(tempDir, 'global-provider-options');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'review.yaml'), 'global\n');
      symlinkSync(outsideDir, symlinkedDir);

      const result = resolveNamedResourceWithSource('review', {
        candidateDirs: [symlinkedDir, globalDir],
        extensions: ['.yaml', '.yml'],
      });

      expect(result?.path).toBe(join(globalDir, 'review.yaml'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('should reject a dangling symlinked candidate directory before checking lower-priority roots', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-named-resource-dangling-dir-symlink-'));
    try {
      const symlinkedDir = join(tempDir, 'project-steps');
      const globalDir = join(tempDir, 'global-steps');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'gather.yaml'), 'global\n');
      symlinkSync(join(tempDir, 'missing-steps'), symlinkedDir);

      expect(() => resolveNamedResourceWithSource('gather', {
        candidateDirs: [symlinkedDir, globalDir],
        extensions: ['.yaml', '.yml'],
        rejectSymlinkedCandidateDirs: true,
      })).toThrow(/candidate directory must not be a symlink/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should use injected file access to reject a dangling candidate directory symlink', () => {
    const isSymlink = vi.fn(() => true);

    expect(() => resolveNamedResourceWithSource('gather', {
      candidateDirs: ['/project/steps'],
      extensions: ['.yaml', '.yml'],
      fileAccess: {
        exists: () => false,
        realpath: (path) => path,
        isSymlink,
      },
      rejectSymlinkedCandidateDirs: true,
    })).toThrow(/candidate directory must not be a symlink/i);

    expect(isSymlink).toHaveBeenCalledWith('/project/steps');
  });
});
