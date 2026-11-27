/**
 * A Vitest run must not reach the developer's real ~/.takt.
 *
 * Each case starts a child Vitest run, or a child Node process, with a fake HOME
 * that holds a fake ~/.takt. The real ~/.takt is never opened.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ISOLATION_ROOT_ENV, isolateUserDirectoriesForTestRun } from '../../scripts/test-user-isolation.mjs';

const repoRoot = process.cwd();
const vitestBin = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const isolationScript = pathToFileURL(join(repoRoot, 'scripts', 'test-user-isolation.mjs')).href;
const userDirectoryKeys = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'TMPDIR', 'TMP', 'TEMP', 'TAKT_CONFIG_DIR',
] as const;

describe('test user directory isolation', () => {
  let workspace: string;
  let fakeHome: string;
  let fakeTakt: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'takt-user-isolation-'));
    fakeHome = join(workspace, 'home');
    fakeTakt = join(fakeHome, '.takt');
    mkdirSync(join(fakeTakt, 'claude-sdk'), { recursive: true });
    writeFileSync(join(fakeTakt, 'config.yaml'), 'provider: claude-sdk\n');
    writeFileSync(join(fakeTakt, 'claude-sdk', 'marker'), 'installed\n');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function fakeUserEnv(): NodeJS.ProcessEnv {
    const tmp = join(workspace, 'tmp');
    mkdirSync(tmp, { recursive: true });
    // No TAKT_CONFIG_DIR: a developer who never exported it.
    return { PATH: process.env.PATH, HOME: fakeHome, USERPROFILE: fakeHome, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  }

  function expectFakeTaktIntact(): void {
    expect(existsSync(fakeTakt), `${fakeTakt} was removed`).toBe(true);
    expect(readFileSync(join(fakeTakt, 'config.yaml'), 'utf-8')).toBe('provider: claude-sdk\n');
    expect(readFileSync(join(fakeTakt, 'claude-sdk', 'marker'), 'utf-8')).toBe('installed\n');
  }

  it.each(['threads', 'forks'])(
    'keeps ~/.takt intact when a test writes the global config at module load and removes ~/.takt in afterAll (%s)',
    (pool) => {
      const project = join(workspace, 'project');
      mkdirSync(project);
      const testFile = join(project, 'sentinel.test.ts');
      writeFileSync(testFile, [
        "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';",
        "import { homedir } from 'node:os';",
        "import { join } from 'node:path';",
        "import { afterAll, it } from 'vitest';",
        `import { getGlobalConfigDir } from ${JSON.stringify(join(repoRoot, 'src', 'infra', 'config', 'paths.ts'))};`,
        '',
        '// Module load runs before the shared beforeEach sets TAKT_CONFIG_DIR.',
        'mkdirSync(getGlobalConfigDir(), { recursive: true });',
        "writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'enable_builtin_workflows: false\\n');",
        "afterAll(() => rmSync(join(homedir(), '.takt'), { recursive: true, force: true }));",
        "it('runs', () => {});",
        '',
      ].join('\n'));
      const config = join(project, 'vitest.config.ts');
      writeFileSync(config, [
        `import { commonSrcTestConfig } from ${JSON.stringify(join(repoRoot, 'vitest.config.shared.ts'))};`,
        '',
        '// A plain object: vitest/config does not resolve from a directory outside the repository.',
        'export default {',
        `  test: { ...commonSrcTestConfig, root: ${JSON.stringify(repoRoot)}, dir: ${JSON.stringify(project)}, include: ['**/*.test.ts'] },`,
        '};',
        '',
      ].join('\n'));

      const result = spawnSync(process.execPath, [vitestBin, 'run', '--config', config, '--pool', pool], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: fakeUserEnv(),
        timeout: 90_000,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expectFakeTaktIntact();
    },
  );

  it('hands child processes the HOME, XDG, TMPDIR, and TAKT config dir isolated before the workers started', () => {
    const output = execFileSync(process.execPath, [
      '-e',
      'const os = require("os"); process.stdout.write(JSON.stringify([os.homedir(), os.tmpdir(), '
        + 'process.env.XDG_CONFIG_HOME, process.env.TAKT_CONFIG_DIR, process.env.TEST_USER_ISOLATION_ROOT]))',
    ], { encoding: 'utf-8' });
    const [childHome, childTmp, childXdg, childConfigDir, root] = JSON.parse(output) as string[];

    expect(root).toBeTruthy();
    for (const value of [childHome, childTmp, childXdg, childConfigDir]) {
      expect(value!.startsWith(`${root}${sep}`)).toBe(true);
    }
  });

  it('moves every user directory under one temporary root and reuses it when the config loads again', () => {
    const env: NodeJS.ProcessEnv = { HOME: fakeHome, PATH: process.env.PATH, TAKT_CONFIG_DIR: fakeTakt };
    const root = isolateUserDirectoriesForTestRun(env);

    try {
      expect(env[ISOLATION_ROOT_ENV]).toBe(root);
      for (const key of userDirectoryKeys) {
        expect(env[key]!.startsWith(`${root}${sep}`)).toBe(true);
        expect(existsSync(env[key]!)).toBe(true);
      }
      expect(isolateUserDirectoriesForTestRun(env)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expectFakeTaktIntact();
  });

  it('removes the isolated root when the process that created it exits', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[ISOLATION_ROOT_ENV];
    const root = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { isolateUserDirectoriesForTestRun } from ${JSON.stringify(isolationScript)};`
        + 'import { existsSync } from "node:fs";'
        + 'const root = isolateUserDirectoriesForTestRun();'
        + 'if (!existsSync(process.env.TAKT_CONFIG_DIR)) process.exit(2);'
        + 'process.stdout.write(root);',
    ], { encoding: 'utf-8', env });

    expect(root).toBeTruthy();
    expect(existsSync(root)).toBe(false);
  });

  it('refuses to start when the temporary directory lies inside a TAKT directory', () => {
    const tmpInsideTakt = join(fakeTakt, 'tmp');
    const linkToTmpInsideTakt = join(workspace, 'tmp-link');
    mkdirSync(tmpInsideTakt);
    symlinkSync(tmpInsideTakt, linkToTmpInsideTakt, 'dir');
    const linkedHome = join(workspace, 'linked-home');
    mkdirSync(linkedHome);
    symlinkSync(fakeTakt, join(linkedHome, '.takt'), 'dir');
    const otherHome = join(workspace, 'other-home');
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      [tmpInsideTakt, { HOME: fakeHome }],
      [linkToTmpInsideTakt, { HOME: fakeHome }],
      [tmpInsideTakt, { HOME: otherHome, TAKT_CONFIG_DIR: fakeTakt }],
      // ~/.takt itself is a symlink.
      [tmpInsideTakt, { HOME: linkedHome }],
    ];
    const otherSpelling = join(fakeHome, '.TAKT', 'tmp');
    if (existsSync(otherSpelling)) {
      // Case-insensitive filesystem: another spelling names the same directory.
      cases.push([otherSpelling, { HOME: fakeHome }]);
      cases.push([tmpInsideTakt, { HOME: otherHome, TAKT_CONFIG_DIR: join(fakeHome, '.TAKT') }]);
    }

    for (const [tmp, extra] of cases) {
      const result = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        `import { isolateUserDirectoriesForTestRun } from ${JSON.stringify(isolationScript)}; isolateUserDirectoriesForTestRun();`,
      ], { encoding: 'utf-8', env: { PATH: process.env.PATH, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...extra } });

      expect(result.status, `${tmp} ${JSON.stringify(extra)}`).not.toBe(0);
      expect(result.stderr).toContain('Refusing to isolate test user directories');
    }
    expect(readdirSync(tmpInsideTakt)).toEqual([]);
    expectFakeTaktIntact();
  });
});
