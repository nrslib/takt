/**
 * Isolate the user directories of a Vitest run before any worker exists.
 *
 * vitest.config.shared.ts calls this while the config loads in the parent
 * process, so every thread, fork, and child process inherits a temporary HOME,
 * USERPROFILE, XDG_*, TMPDIR/TMP/TEMP, and TAKT_CONFIG_DIR from the real
 * process environment. Assigning HOME inside a `threads` worker does not move
 * os.homedir(); only the parent environment does.
 *
 * Side effects on tools that tests spawn: anything that reads the real home
 * (~/.npmrc, asdf/pyenv shims, provider credential stores such as the default
 * DeepSeek Harness store) no longer sees it. Set its own location variable
 * explicitly (for example DSH_HOME, NPM_CONFIG_USERCONFIG) when a test needs it.
 * The Playwright browser cache and mise are pointed at their real locations
 * below because they are read-only for tests and their shims fail without them.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Set on the isolated root so a nested config load reuses it. Not TAKT_-prefixed: tests clear those. */
export const ISOLATION_ROOT_ENV = 'TEST_USER_ISOLATION_ROOT';

function playwrightBrowsersPath(home, env) {
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'ms-playwright') : undefined;
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright');
}

/** Keep read-only tool locations that otherwise resolve under HOME. */
function preserveToolLocations(home, env) {
  const locations = {
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(home, env),
    MISE_DATA_DIR: join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'mise'),
    MISE_CONFIG_DIR: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'mise'),
  };
  for (const [key, value] of Object.entries(locations)) {
    if (env[key] === undefined && value !== undefined && existsSync(value)) env[key] = value;
  }
}

/** The real TAKT directories that exist: `<home>/.takt` and a TAKT_CONFIG_DIR the run started with. */
function existingRealTaktDirectories(env) {
  const candidates = [env.TAKT_CONFIG_DIR, env.HOME && join(env.HOME, '.takt')];
  try {
    candidates.push(join(userInfo().homedir, '.takt'));
  } catch {
    // No account database entry (some containers): the inherited HOME is all there is.
  }
  return candidates.filter((directory) => directory && existsSync(directory)).map((directory) => realpathSync.native(directory));
}

/** Refuse before the first write when the inherited temporary directory lies inside a real TAKT directory. */
function assertTemporaryDirectoryOutsideRealTakt(temporaryDirectory, env) {
  for (const directory of existingRealTaktDirectories(env)) {
    const rel = relative(directory, temporaryDirectory);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new Error(
        `Refusing to isolate test user directories: the temporary directory "${temporaryDirectory}" lies inside `
        + `the TAKT directory "${directory}". Point TMPDIR outside it.`,
      );
    }
  }
}

export function isolateUserDirectoriesForTestRun(env = process.env) {
  const existing = env[ISOLATION_ROOT_ENV];
  if (existing && existsSync(existing)) return existing;
  // native: the OS spelling, so another case of the same name on a case-insensitive filesystem compares equal.
  const temporaryDirectory = realpathSync.native(tmpdir());
  assertTemporaryDirectoryOutsideRealTakt(temporaryDirectory, env);
  // Keep the prefix short: macOS limits Unix socket paths under TMPDIR to 104 bytes.
  const root = realpathSync.native(mkdtempSync(join(temporaryDirectory, 'tt-')));
  const home = join(root, 'h');
  const directories = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, 'x', 'config'),
    XDG_DATA_HOME: join(root, 'x', 'data'),
    XDG_CACHE_HOME: join(root, 'x', 'cache'),
    XDG_STATE_HOME: join(root, 'x', 'state'),
    TMPDIR: join(root, 't'),
    TMP: join(root, 't'),
    TEMP: join(root, 't'),
    TAKT_CONFIG_DIR: join(home, '.takt'),
  };
  if (env.HOME) preserveToolLocations(env.HOME, env);
  for (const [key, value] of Object.entries(directories)) {
    mkdirSync(value, { recursive: true });
    env[key] = value;
  }
  env[ISOLATION_ROOT_ENV] = root;
  process.once('exit', () => {
    // A throw here would turn a passing run into exit 1. A descendant that is
    // still writing, or a read-only leftover, only leaves the root in tmp.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      process.stderr.write(`[test-user-isolation] left ${root}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  return root;
}
