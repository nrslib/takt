import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveNpmInvocation } from '../../scripts/npm-invocation.mjs';
import { startTaktPty, type TaktPtySession } from '../../e2e/helpers/takt-pty-runner.js';
import { cleanupChildProcess, waitForClose } from '../../e2e/helpers/wait.js';

const rawPtyOutput = vi.hoisted(() => ({ chunks: [] as string[] }));

vi.mock('../../e2e/helpers/terminal-output.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../e2e/helpers/terminal-output.js')>();
  return {
    ...actual,
    createTerminalOutput: () => {
      const output = actual.createTerminalOutput();
      return {
        ...output,
        push: (chunk: string) => {
          rawPtyOutput.chunks.push(chunk);
          output.push(chunk);
        },
      };
    },
  };
});

const require = createRequire(import.meta.url);
const tsxUrl = pathToFileURL(require.resolve('tsx/esm')).href;
const notificationUrl = new URL('../shared/utils/notification.ts', import.meta.url).href;
const commands = ['afplay', 'paplay', 'aplay', 'osascript', 'notify-send'];
const timeout = 20_000;

describe('test notification isolation', () => {
  let root: string;
  let commandLog: string;
  let env: NodeJS.ProcessEnv;
  let markerPath: string;
  let pty: TaktPtySession | undefined;

  beforeEach(() => {
    const tempRoot = join(process.cwd(), '.tmp');
    mkdirSync(tempRoot, { recursive: true });
    root = mkdtempSync(join(tempRoot, 'notification-silence-'));
    commandLog = join(root, 'commands.log');
    writeFileSync(commandLog, '');
    const binDir = join(root, 'bin');
    const configDir = join(root, 'home', '.takt');
    mkdirSync(binDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'notification_sound: true\n');
    const quotedLog = `'${commandLog.replace(/'/g, `'\\''`)}'`;
    for (const command of commands) {
      writeFileSync(join(binDir, command), [
        '#!/bin/sh',
        `printf '%s\\n' '${command}' >> ${quotedLog}`,
        'exit 1',
      ].join('\n'), { mode: 0o755 });
    }
    markerPath = join(root, 'existing preload.cjs');
    writeFileSync(markerPath, 'globalThis.notificationTestMarker = "existing-preload";');
    env = {
      HOME: dirname(configDir),
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TAKT_CONFIG_DIR: configDir,
      TAKT_NOTIFICATION_SOUND: 'true',
      TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_ABORT: 'true',
      TAKT_NOTIFICATION_SOUND_EVENTS_RUN_COMPLETE: 'true',
      NODE_OPTIONS: `--no-warnings --require=${JSON.stringify(markerPath)}`,
    };
    rawPtyOutput.chunks = [];
  });

  afterEach(async () => {
    try {
      await pty?.dispose();
    } finally {
      pty = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  function runScript(source: string) {
    const scriptPath = join(root, 'parent.mjs');
    writeFileSync(scriptPath, source);
    return spawnSync(process.execPath, ['--import', tsxUrl, scriptPath], {
      cwd: process.cwd(), env, encoding: 'utf8', timeout,
    });
  }

  function runWriterProbe(source: string) {
    const scriptPath = join(root, 'writer-probe.cjs');
    writeFileSync(scriptPath, source);
    // The writer double must be installed before the silence preload wraps it.
    return spawnSync('/bin/sh', ['-c', 'NODE_OPTIONS= exec "$@"', 'writer-probe', process.execPath, scriptPath], {
      cwd: process.cwd(), env, encoding: 'utf8', timeout,
    });
  }

  function notificationProbe(platform: string): string {
    return `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { playSound, sendNotification } from ${JSON.stringify(notificationUrl)};
      const require = createRequire(import.meta.url);
      require('node:os').platform = () => ${JSON.stringify(platform)};
      syncBuiltinESMExports();
      for (const sound of ['success', 'error', 'warning', 'info']) {
        playSound(sound);
        sendNotification({ title: 'TAKT test', message: sound, sound });
      }
      process.once('beforeExit', () => console.log('probe-finished', globalThis.notificationTestMarker));
    `;
  }

  function expectSilent(result: ReturnType<typeof runScript>): void {
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('probe-finished existing-preload');
    expect(readFileSync(commandLog, 'utf8')).toBe('');
    expect(result.stdout).not.toContain('\x07');
    expect(result.stderr).not.toContain('\x07');
  }

  it.each(['darwin', 'linux', 'freebsd'])(
    'should silence real notification effects and fallback bells on %s',
    (platform) => {
      expectSilent(runScript(notificationProbe(platform)));
    },
  );

  it('should silence notifications when the preload filename needs JSON escaping', () => {
    const preloadPath = join(root, 'escaped\\preload.cjs');
    mkdirSync(dirname(preloadPath), { recursive: true });
    writeFileSync(preloadPath, readFileSync(new URL('../../scripts/test-notification-silence.cjs', import.meta.url)));
    const probePath = join(root, 'escaped-probe.mjs');
    writeFileSync(probePath, notificationProbe(process.platform));
    const options = `--require=${JSON.stringify(preloadPath)} ${env.NODE_OPTIONS}`;
    const command = [process.execPath, '--import', tsxUrl, probePath]
      .map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    // The shell assignment replaces the outer runner's preload so this child
    // exercises the escaped copy rather than the already-installed original.
    const shellCommand = `NODE_OPTIONS='${options.replaceAll("'", "'\\''")}' ${command}`;
    expectSilent(runScript(`
      import { execSync } from 'node:child_process';
      process.stdout.write(execSync(${JSON.stringify(shellCommand)}, {
        env: ${JSON.stringify(env)}, encoding: 'utf8', timeout: ${timeout},
      }));
    `));
  });

  it.each(['spawn', 'execFile', 'spawnSync', 'execFileSync', 'execSync', 'fork', 'worker'])(
    'should keep notifications silent through %s with an explicit child environment',
    (method) => {
      const probePath = join(root, 'child.mjs');
      writeFileSync(probePath, notificationProbe(process.platform));
      const shellCommand = [process.execPath, '--import', tsxUrl, probePath]
        .map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
      const result = runScript(`
        import { spawn, execFile, spawnSync, execFileSync, execSync, fork } from 'node:child_process';
        import { Worker } from 'node:worker_threads';
        import { pathToFileURL } from 'node:url';
        const env = ${JSON.stringify(env)};
        const file = ${JSON.stringify(probePath)};
        const args = ['--import', ${JSON.stringify(tsxUrl)}, file];
        const method = ${JSON.stringify(method)};
        if (method === 'spawnSync') {
          const child = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: ${timeout} });
          if (child.error) throw child.error;
          process.stdout.write(child.stdout);
          process.stderr.write(child.stderr);
          process.exitCode = child.status;
        } else if (method === 'execFileSync') {
          process.stdout.write(execFileSync(process.execPath, args, { env, encoding: 'utf8', timeout: ${timeout} }));
        } else if (method === 'execSync') {
          process.stdout.write(execSync(${JSON.stringify(shellCommand)}, { env, encoding: 'utf8', timeout: ${timeout} }));
        } else if (method === 'worker') {
          const worker = new Worker(pathToFileURL(file), {
            env, execArgv: ['--require', ${JSON.stringify(markerPath)}, '--import', ${JSON.stringify(tsxUrl)}],
            stdout: true, stderr: true,
          });
          worker.stdout.pipe(process.stdout);
          worker.stderr.pipe(process.stderr);
          worker.on('error', error => { throw error; });
          worker.on('exit', code => { process.exitCode = code; });
        } else {
          const child = method === 'fork'
            ? fork(file, [], { env, execArgv: ['--import', ${JSON.stringify(tsxUrl)}], silent: true })
            : method === 'spawn'
              ? spawn(process.execPath, args, { env })
              : execFile(process.execPath, args, { env }, (error) => { if (error) process.exitCode = 1; });
          child.stdout.pipe(process.stdout);
          child.stderr.pipe(process.stderr);
          child.on('error', error => { throw error; });
          child.on('close', code => { process.exitCode = code; });
        }
      `);
      expectSilent(result);
    },
  );

  it.each(['spawnSync', 'execFileSync'])(
    'should preserve stdin, encoding and the third options argument of %s without an args array',
    (method) => {
      const input = `
        const { execFile } = require('node:child_process');
        execFile('afplay', ['unused.aiff'], () => {
          console.log('stdin-options', process.env.TEST_STDIN_OPTIONS);
          process.stdout.write('\\x07');
          console.log('probe-finished', globalThis.notificationTestMarker);
        });
      `;
      const result = runScript(`
        import { spawnSync, execFileSync } from 'node:child_process';
        const options = {
          env: ${JSON.stringify({ ...env, TEST_STDIN_OPTIONS: 'preserved' })},
          input: ${JSON.stringify(input)}, encoding: 'utf8', timeout: ${timeout},
        };
        const result = ${method}(process.execPath, undefined, options);
        if (${JSON.stringify(method)} === 'spawnSync') {
          if (result.error) throw result.error;
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          process.exitCode = result.status;
        } else {
          process.stdout.write(result);
        }
      `);
      expectSilent(result);
      expect(result.stdout).toContain('stdin-options preserved');
    },
  );

  it('should preserve native validation errors for invalid process and worker arguments', () => {
    const workerPath = join(root, 'validation-worker.mjs');
    writeFileSync(workerPath, 'process.exit(0);');
    const result = runScript(`
      import { spawnSync, execFileSync } from 'node:child_process';
      import { Worker } from 'node:worker_threads';
      const results = [];
      for (const method of [spawnSync, execFileSync]) {
        for (const args of [[process.execPath, 123], [process.execPath, [], []]]) {
          try {
            method(...args);
            results.push('accepted');
          } catch (error) {
            results.push({ code: error.code, name: error.name });
          }
        }
      }
      for (const options of [null, { execArgv: 123 }]) {
        try {
          new Worker(${JSON.stringify(workerPath)}, options);
          results.push('accepted');
        } catch (error) {
          results.push({ code: error.code, name: error.name });
        }
      }
      console.log(JSON.stringify(results));
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      ...Array(4).fill({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
      expect.objectContaining({ name: 'TypeError' }),
      { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' },
    ]);
  });

  it.each([0, 23])('should complete suppressed callbacks and preserve exit code %s', (exitCode) => {
    const result = runScript(`
      import { execFile } from 'node:child_process';
      await new Promise((resolve, reject) => {
        execFile('afplay', ['unused.aiff'], (error, stdout, stderr) => {
          if (error) return reject(error);
          console.log(JSON.stringify({ stdout, stderr }));
          resolve();
        });
      });
      console.log('callback-finished');
      process.exitCode = ${exitCode};
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(exitCode);
    expect(result.stdout).toContain('{"stdout":"","stderr":""}');
    expect(result.stdout).toContain('callback-finished');
    expect(readFileSync(commandLog, 'utf8')).toBe('');
  });

  it('should preserve ordinary commands, non-notification AppleScript and log data', () => {
    const result = runScript(`
      import { execFile } from 'node:child_process';
      import { promisify } from 'node:util';
      const run = promisify(execFile);
      const child = await run(process.execPath, ['-e', 'process.stdout.write("ordinary-command")']);
      console.log(child.stdout);
      try {
        await run('osascript', ['-e', 'the clipboard as text']);
      } catch (error) {
        console.log('ordinary-exit', error.code);
      }
      process.stdout.write('log-data\\x07inside\\n');
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ordinary-command');
    expect(result.stdout).toContain('ordinary-exit 1');
    expect(result.stdout).toContain('log-datainside\n');
    expect(result.stdout).not.toContain('\x07');
    expect(readFileSync(commandLog, 'utf8')).toBe('osascript\n');
  });

  it.each([
    ['ordinary\n', 'ordinary\n'],
    ['log-data\x07inside\n', 'log-datainside\n'],
    ['\x07leading\n', 'leading\n'],
    ['trailing\n\x07', 'trailing\n'],
    ['\x07a\x07\x07\nb\x07', 'a\nb'],
  ])('should remove only BEL characters from stdout chunk %j', (chunk, expected) => {
    const result = runScript(`process.stdout.write(${JSON.stringify(chunk)});`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.each(['Buffer', 'Uint8Array'])('should remove only BEL bytes from %s without mutating the input', (kind) => {
    const scriptPath = join(root, 'bytes.mjs');
    const bytes = [7, 65, 7, 7, 10, 0, 255, 66, 7];
    writeFileSync(scriptPath, `
      const chunk = ${kind}.from(${JSON.stringify(bytes)});
      process.stdout.write(chunk);
      process.stderr.write(JSON.stringify(Array.from(chunk)));
    `);
    const result = spawnSync(process.execPath, [scriptPath], { cwd: process.cwd(), env, timeout });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stdout).toEqual(Buffer.from([65, 10, 0, 255, 66]));
    expect(JSON.parse(result.stderr.toString())).toEqual(bytes);
  });

  it('should complete BEL-only writes asynchronously once for both callback overloads', () => {
    const result = runScript(`
      const observations = [];
      for (const chunk of ['\\x07', '\\x07\\x07', Buffer.from([7, 7]), Uint8Array.from([7, 7])]) {
        for (const withEncoding of [false, true]) {
          let synchronous = true;
          const observation = { returned: undefined, calls: 0, asynchronous: false };
          const callback = () => {
            observation.calls += 1;
            observation.asynchronous = !synchronous;
          };
          observation.returned = withEncoding
            ? process.stdout.write(chunk, 'utf8', callback)
            : process.stdout.write(chunk, callback);
          synchronous = false;
          observations.push(observation);
        }
        process.stdout.write(chunk);
      }
      await new Promise(resolve => process.nextTick(resolve));
      console.log(JSON.stringify(observations));
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(
      Array(8).fill({ returned: true, calls: 1, asynchronous: true }),
    );
  });

  it.each([true, false])('should preserve writer arguments and return value %s after removing BEL', (returned) => {
    const result = runWriterProbe(`
      const assert = require('node:assert/strict');
      const { writeSync } = require('node:fs');
      const calls = [];
      process.stdout.write = function (chunk, encoding, callback) {
        calls.push({ receiver: this, chunk, encoding, callback });
        return ${returned};
      };
      require(${JSON.stringify(require.resolve('../../scripts/test-notification-silence.cjs'))}).installNotificationSilence();
      const receiver = {};
      const callback = () => {};
      for (const [chunk, expected] of [
        ['', ''],
        ['ordinary\\n', 'ordinary\\n'],
        ['a\\x07\\nb', 'a\\nb'],
        [Buffer.from([65, 10, 255]), [65, 10, 255]],
        [Buffer.from([65, 7, 10, 255]), [65, 10, 255]],
        [Uint8Array.from([65, 10, 255]), [65, 10, 255]],
        [Uint8Array.from([65, 7, 10, 255]), [65, 10, 255]],
      ]) {
        for (const withEncoding of [false, true]) {
          calls.length = 0;
          const actual = withEncoding
            ? process.stdout.write.call(receiver, chunk, 'utf8', callback)
            : process.stdout.write.call(receiver, chunk, callback);
          assert.equal(actual, ${returned});
          assert.equal(calls.length, 1);
          assert.equal(calls[0].receiver, receiver);
          assert.deepEqual(typeof calls[0].chunk === 'string' ? calls[0].chunk : Array.from(calls[0].chunk), expected);
          assert.equal(calls[0].encoding, withEncoding ? 'utf8' : callback);
          assert.equal(calls[0].callback, withEncoding ? callback : undefined);
        }
      }
      calls.length = 0;
      for (const chunk of ['\\x07', '\\x07\\x07', Buffer.from([7, 7]), Uint8Array.from([7, 7])]) {
        assert.equal(process.stdout.write(chunk), true);
        assert.equal(process.stdout.write(chunk, callback), true);
        assert.equal(process.stdout.write(chunk, 'utf8', callback), true);
      }
      assert.equal(calls.length, 0);
      writeSync(1, 'writer-preserved\\n');
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('writer-preserved\n');
  });

  it('should propagate the original writer error after removing BEL', () => {
    const result = runWriterProbe(`
      const assert = require('node:assert/strict');
      const { writeSync } = require('node:fs');
      const failure = new Error('writer failed');
      let calls = 0;
      process.stdout.write = function (chunk) {
        calls += 1;
        assert.equal(chunk, 'ordinary\\n');
        throw failure;
      };
      require(${JSON.stringify(require.resolve('../../scripts/test-notification-silence.cjs'))}).installNotificationSilence();
      assert.throws(() => process.stdout.write('ordinary\\x07\\n'), error => error === failure);
      assert.equal(calls, 1);
      writeSync(1, 'error-preserved\\n');
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('error-preserved\n');
  });

  it('should keep the manager user_interrupted workflow silent in a child test runner', async () => {
    const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
    const child = spawn(invocation.executable, [
      ...invocation.args, 'run', 'test:it:heavy:parallel', '--', 'src/__tests__/it-manager-question-display.test.ts',
      '--testNamePattern', 'keeps SIGINT ownership when a single goal task receives its own signal without a worker pool',
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const result = await waitForClose(child, timeout).catch((error: unknown) => {
        throw new Error(`Manager test did not complete\n${stdout}\n${stderr}`, { cause: error });
      });
      expect(result.code, stdout + stderr).toBe(0);
      expect(stdout + stderr).toContain('user_interrupted');
      expect(readFileSync(commandLog, 'utf8')).toBe('');
      expect(stdout).not.toContain('\x07');
      expect(stderr).not.toContain('\x07');
    } finally {
      await cleanupChildProcess(child);
    }
  });

  it('should silence PTY startup with overridden NODE_OPTIONS before output normalization', async () => {
    const probePath = join(root, 'pty-probe.mjs');
    writeFileSync(probePath, `
      import { execFile } from 'node:child_process';
      import { promisify } from 'node:util';
      await promisify(execFile)('osascript', ['-e', 'display notification "test" with title "TAKT"']);
      process.stdout.write('\\x07');
      console.log('probe-finished', globalThis.notificationTestMarker);
      process.exit(0);
    `);
    pty = startTaktPty({
      args: ['--help'], cwd: process.cwd(), injectProvider: false,
      env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(probePath).href}` },
    });
    const code = await pty.waitForExit(timeout);
    const raw = rawPtyOutput.chunks.join('');
    expect(code, raw).toBe(0);
    expect(raw).toContain('probe-finished existing-preload');
    expect(readFileSync(commandLog, 'utf8')).toBe('');
    expect(raw).not.toContain('\x07');
  });

  it('should silence user_interrupted from a real workflow engine in a child process', () => {
    const executionUrl = new URL('../features/tasks/execute/workflowExecution.ts', import.meta.url).href;
    const mockUrl = new URL('../infra/mock/index.ts', import.meta.url).href;
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const result = runScript(`
      import { executeWorkflow } from ${JSON.stringify(executionUrl)};
      import { setMockScenario } from ${JSON.stringify(mockUrl)};
      import { execFileSync } from 'node:child_process';
      const cwd = ${JSON.stringify(workspace)};
      execFileSync('git', ['init', '--quiet'], { cwd });
      setMockScenario([{ status: 'done', content: 'Done', waitForAbort: true }]);
      const events = [];
      const result = await executeWorkflow({
        name: 'notification-isolation', maxSteps: 3, initialStep: 'execute',
        steps: [{ name: 'execute', persona: 'test-coder', personaDisplayName: 'Test coder', instruction: 'Work',
          rules: [{ condition: 'Done', next: 'COMPLETE' }] }],
      }, 'Test interruption', cwd, {
        projectCwd: cwd, provider: 'mock', model: 'mock-model',
        outputMode: 'terminal', handleSigint: true,
        eventSink: event => {
          events.push(event);
          if (event.type === 'step_started') setImmediate(() => process.kill(process.pid, 'SIGINT'));
        },
      });
      console.log(JSON.stringify({ result, completed: events.filter(event => event.type === 'completed') }));
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const terminal = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {
      result: { interrupted: boolean; success: boolean; reason: string };
      completed: Array<{ type: string; success: boolean; reason: string }>;
    };
    expect(terminal.result).toMatchObject({
      interrupted: true, success: false, reason: 'Workflow interrupted by user (SIGINT)',
    });
    expect(terminal.completed).toEqual([
      expect.objectContaining({ type: 'completed', success: false, reason: terminal.result.reason }),
    ]);
    expect(readFileSync(commandLog, 'utf8')).toBe('');
    expect(result.stdout).not.toContain('\x07');
    expect(result.stderr).not.toContain('\x07');
  });
});
