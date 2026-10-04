import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

describe('Git publication authentication', () => {
  let projectDir: string;
  let environment: NodeJS.ProcessEnv;
  let server: Worker;
  let port: number;
  let askpassMarker: string;

  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: projectDir,
      env: environment,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
  }

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-push-auth-'));
    environment = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
      GIT_TERMINAL_PROMPT: '1',
      LC_ALL: 'C',
    };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG']) {
      delete environment[key];
    }
    askpassMarker = join(projectDir, 'askpass-called');
    const askpassPath = join(projectDir, 'askpass.cjs');
    writeFileSync(askpassPath, `require('node:fs').writeFileSync(${JSON.stringify(askpassMarker)}, 'called');\nprocess.stdout.write('fixture-credential\\n');\n`);
    const askpassCommand = `"${process.execPath}" "${askpassPath}"`;
    environment.GIT_ASKPASS = askpassCommand;
    environment.SSH_ASKPASS = askpassCommand;
    git(['init', '-b', 'takt/auth-test']);
    git(['config', 'user.name', 'TAKT test']);
    git(['config', 'user.email', 'takt-test@example.test']);
    git(['config', 'commit.gpgSign', 'false']);
    git(['config', 'core.hooksPath', devNull]);
    git(['config', 'credential.helper', '']);
    git(['config', 'http.proxy', '']);
    git(['config', 'core.askPass', askpassCommand]);
    git(['commit', '--allow-empty', '-m', 'preserved result']);

    server = new Worker(`
      const { parentPort } = require('node:worker_threads');
      const server = require('node:http').createServer((_request, response) => {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TAKT test"' });
        response.end();
      });
      server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
    `, { eval: true });
    [port] = await once(server, 'message') as [number];
  });

  afterEach(async () => {
    await server?.terminate();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([
    ['Username', ''],
    ['Password', 'fixture-user@'],
  ])('fails without prompting for %s or invoking inherited askpass programs', (prompt, userInfo) => {
    git(['remote', 'add', 'origin', `http://${userInfo}127.0.0.1:${port}/repo.git`]);
    const commitBefore = git(['rev-parse', 'HEAD']);

    // The child timeout bounds regressions that would otherwise wait on a TTY.
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { pushBranch } from './src/infra/task/git.ts';
       try {
         pushBranch(${JSON.stringify(projectDir)}, 'takt/auth-test');
       } catch (error) {
         process.stderr.write(error.message);
         process.exitCode = 2;
       }`,
    ], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf-8',
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`could not read ${prompt}`);
    expect(result.stderr).toContain('terminal prompts disabled');
    expect(existsSync(askpassMarker)).toBe(false);
    expect(git(['rev-parse', 'refs/heads/takt/auth-test'])).toBe(commitBefore);
    expect(git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });
});
