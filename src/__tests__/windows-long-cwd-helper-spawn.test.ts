import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPrivateArtifactHelper } from '../shared/utils/private-artifact-helper.js';
import { prepareRuntimeEnvironment } from '../core/runtime/runtime-environment.js';

// Node's fs APIs accept a `\\?\`-namespaced path for any operation, which lets
// this test create/remove a directory beyond Win32's 260-character MAX_PATH
// without depending on the (often-disabled) registry LongPathsEnabled policy.
function longPathSafe(path: string): string {
  return process.platform === 'win32' ? win32.toNamespacedPath(path) : path;
}

// Nests short segments under a per-test temp root until the absolute path
// exceeds MAX_PATH (260 chars) -- this is the exact condition #1500 reports: a
// generated report/history/subworkflow/runtime directory whose path crosses
// that limit made spawnSync's cwd option fail with a misleading `ENOENT` for
// node.exe (or bash) even though the executable exists.
//
// Each call gets its own mkdtemp root so tests never share or overwrite a
// fixed-name directory, and the caller only needs to clean up that one root
// to remove every ancestor this creates.
function makeLongCwd(prefix: string): { root: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  let dir = root;
  while (dir.length <= 260) {
    dir = join(dir, 'a'.repeat(40));
    mkdirSync(longPathSafe(dir), { recursive: true });
  }
  return { root, cwd: dir };
}

describe.runIf(process.platform === 'win32')('helper spawn cwd beyond MAX_PATH on Windows', () => {
  const originalEnv = { ...process.env };
  const cleanupPaths = new Set<string>();

  afterEach(() => {
    let firstError: unknown;
    for (const path of cleanupPaths) {
      try {
        rmSync(longPathSafe(path), { recursive: true, force: true });
      } catch (error) {
        firstError ??= error;
      }
    }
    cleanupPaths.clear();

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    if (firstError !== undefined) throw firstError;
  });

  it('should let runPrivateArtifactHelper spawn process.execPath with a cwd beyond MAX_PATH', () => {
    const { root: testRoot, cwd: longCwd } = makeLongCwd('takt-long-helper-');
    cleanupPaths.add(testRoot);
    expect(longCwd.length).toBeGreaterThan(260);

    writeFileSync(longPathSafe(join(longCwd, 'marker.txt')), 'long-cwd-marker');
    const stdout = runPrivateArtifactHelper(
      "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))",
      'request',
      longCwd,
      'helper failed',
    );

    expect(stdout).toBe('long-cwd-marker');
  });

  it('should let runPrepareScript spawn bash with a cwd beyond MAX_PATH', () => {
    const { root: testRoot, cwd: longCwd } = makeLongCwd('takt-long-prepare-');
    cleanupPaths.add(testRoot);
    expect(longCwd.length).toBeGreaterThan(260);

    const shortScriptDir = join(testRoot, 'takt-prepare-script');
    mkdirSync(shortScriptDir, { recursive: true });
    const scriptPath = join(shortScriptDir, 'trivial-prepare.sh');
    writeFileSync(longPathSafe(join(longCwd, 'marker.txt')), 'beyond-max-path');
    writeFileSync(scriptPath, '#!/bin/bash\necho "TAKT_LONG_CWD_TEST=$(cat marker.txt)"\n');

    const result = prepareRuntimeEnvironment(longCwd, { prepare: [scriptPath] });

    expect(result).toBeDefined();
    const runtimeTmp = result!.injectedEnv.TMPDIR;
    expect(runtimeTmp).toBeDefined();
    cleanupPaths.add(runtimeTmp!);
    expect(result!.injectedEnv.TAKT_LONG_CWD_TEST).toBe('beyond-max-path');
  });

});

describe.skipIf(process.platform === 'win32')('helper spawn cwd on POSIX', () => {
  it('preserves symlink traversal in a long cwd containing parent segments', () => {
    const { root, cwd } = makeLongCwd('takt-posix-helper-');
    try {
      const target = join(cwd, 'target');
      mkdirSync(join(target, 'inner'), { recursive: true });
      mkdirSync(join(target, 'sibling'));
      symlinkSync(join(target, 'inner'), join(cwd, 'linked'));
      writeFileSync(join(target, 'sibling', 'marker.txt'), 'symlink-parent-marker');

      const stdout = runPrivateArtifactHelper(
        "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))",
        'request',
        `${cwd}/linked/../sibling`,
        'helper failed',
      );

      expect(stdout).toBe('symlink-parent-marker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
