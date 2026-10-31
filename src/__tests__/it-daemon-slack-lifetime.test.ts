import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { readDaemonOwner } from '../infra/daemon/owner.js';
import { isConversationIpcReady } from '../features/daemon/conversationReadiness.js';
import { captureOwnedChild, terminateOwnedProcess } from './helpers/owned-process.js';

it.each((['director', 'manager'] as const).flatMap((agent) =>
  (['connected', 'failed', 'stopped'] as const).map((outcome) => ({ agent, outcome }))))(
  'serves IPC while $agent Slack is pending beyond the startup deadline and then $outcome', async ({ agent, outcome }) => {
    const directory = process.env.TAKT_CONFIG_DIR!;
    const repository = join(directory, 'repository');
    mkdirSync(join(repository, '.takt'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'pipe' });
    const slack = '  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0AAA]\n';
    writeFileSync(join(repository, '.takt', 'config.yaml'), `provider: mock\nlanguage: en\n${agent === 'manager' ? `manager:\n${slack}` : ''}`);
    writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: en\n${agent === 'director' ? `director:\n${slack}` : ''}`);
    await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const fakeClient = `export function createSlackClient() {
      let release, receive;
      return {
        async start() {
          process.stdout.write('slack-pending\\n');
          await new Promise((resolve, reject) => {
            release = resolve;
            receive = () => {
              receive = undefined;
              process.stdin.pause();
              if (${JSON.stringify(outcome)} === 'failed') {
                process.stdout.write('slack-failed\\n');
                reject(new Error('Fake connection failure'));
              } else { process.stdout.write('slack-connected\\n'); resolve(); }
            };
            process.stdin.once('data', receive);
            process.stdin.resume();
          });
        },
        async postThreadMessage() { throw new Error('Unexpected reply'); },
        async postMessage() { throw new Error('Unexpected notification'); },
        async openModal() { throw new Error('Unexpected modal'); },
        stopAccepting() {},
        async close() {
          if (receive !== undefined) process.stdin.off('data', receive);
          process.stdin.pause();
          release?.();
          process.stdout.write('slack-closed\\n');
        }
      };
    }`;
    const script = `import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url === ${JSON.stringify(moduleUrl('infra/slack/client.js'))}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fakeClient)} };
        return next(url, context);
      } });
      const { runDaemon } = await import(${JSON.stringify(moduleUrl('features/daemon/runDaemon.js'))});
      const { ensureDaemon } = await import(${JSON.stringify(moduleUrl('features/daemon/lifecycle.js'))});
      const daemon = runDaemon();
      await ensureDaemon();
      process.stdout.write('ipc-ready\\n');
      await daemon;
      process.stdout.write('finished\\n');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repository, env: { ...process.env, TAKT_SLACK_APP_TOKEN: 'xapp-test-1', TAKT_SLACK_BOT_TOKEN: 'xoxb-test-2' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const owned = await captureOwnedChild(child);
    try {
      await vi.waitFor(() => expect(stdout, stderr).toContain('slack-pending\n'), { timeout: 5_000 });
      const owner = readDaemonOwner(directory)!;
      expect(owner.pid).toBe(child.pid);
      await vi.waitFor(async () => expect(await isConversationIpcReady(directory, owner)).toBe(true), { timeout: 4_000 });
      await vi.waitFor(() => expect(stdout, stderr).toContain('ipc-ready\n'), { timeout: 4_000 });
      // この経過時間が、既存の5秒の起動確認期限を超える遅延接続条件になる。
      const pendingUntil = Date.now() + 5_200;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(pendingUntil), { timeout: 7_000, interval: 50 });
      expect(child.exitCode, stderr).toBeNull();
      expect(readDaemonOwner(directory)?.pid).toBe(owner.pid);
      expect(await isConversationIpcReady(directory, owner)).toBe(true);
      expect(stdout).not.toContain('slack-connected\n');
      expect(stdout).not.toContain('slack-closed\n');
      if (outcome === 'stopped') child.kill('SIGTERM');
      else {
        child.stdin.end('finish\n');
        await vi.waitFor(() => expect(stdout, stderr).toContain(`slack-${outcome}\n`), { timeout: 5_000 });
        if (outcome === 'connected') {
          expect(await isConversationIpcReady(directory, owner)).toBe(true);
          child.kill('SIGTERM');
        }
      }
      await vi.waitFor(() => expect(child.exitCode, `${stdout}\n${stderr}`).toBe(0), { timeout: 15_000 });
      expect(stdout).toContain('finished\n');
      expect(stdout).toContain('slack-closed\n');
      expect(readDaemonOwner(directory)).toBeUndefined();
      expect(await isConversationIpcReady(directory, owner)).toBe(false);
    } finally {
      if (owned !== undefined) await terminateOwnedProcess(owned, () => child.exitCode !== null || child.signalCode !== null);
    }
  },
);

it.each(['manager', 'director'] as const)('keeps Slack credentials out of %s provider children, replies, conversation storage and daemon logs', async (agent) => {
  const directory = process.env.TAKT_CONFIG_DIR!;
  const repository = join(directory, 'repository');
  mkdirSync(join(repository, '.takt'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'pipe' });
  const slackConfig = '  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0AAA]\n';
  writeFileSync(join(repository, '.takt', 'config.yaml'), `provider: mock\nlanguage: ja\n${agent === 'manager' ? `manager:\n${slackConfig}` : ''}`);
  if (agent === 'director') {
    writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: ja\ndirector:\n${slackConfig}`);
  }
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
  const probe = `const keys = ['TAKT_SLACK_APP_TOKEN', 'TAKT_SLACK_BOT_TOKEN'];
    process.stdout.write(JSON.stringify({ credentials: keys.map(key => ({ key, present: Object.hasOwn(process.env, key),
      encoded: process.env[key] === undefined ? null : Buffer.from(process.env[key]).toString('base64') })),
      canary: process.env.PROVIDER_CANARY }));`;
  const fakePlan = `import { execFileSync } from 'node:child_process';
    export function ${agent === 'manager' ? 'createManagerConversationPlan' : 'createDirectorConversationPlan'}() { return {
      cwd: ${JSON.stringify(directory)}, systemPrompt: 'environment probe',
      ctx: { providerType: 'mock', lang: 'ja', provider: { setup() { return { async call() {
        const message = execFileSync(process.execPath, ['-e', ${JSON.stringify(probe)}], { encoding: 'utf8' });
        return { persona: ${JSON.stringify(agent)}, status: 'done', content: message, timestamp: new Date(),
          structuredOutput: { message, summary: null }, sessionId: 'probe-session' };
      } }; } } }, strategy: { systemPrompt: 'environment probe' }
    }; }`;
  const posted = join(directory, 'posts.jsonl');
  const fakeClient = `import { appendFileSync } from 'node:fs';
    export function createSlackClient(tokens) {
      if (tokens.appToken !== 'xapp-test-1' || tokens.botToken !== 'xoxb-test-2') throw new Error('Wrong Slack credentials');
      return {
        async start(receive) {
          setImmediate(() => void receive({ type: 'events_api', body: { team_id: 'T1', event: {
            type: 'message', channel: 'C0123', user: 'U0AAA', text: '子プロセスの環境を確認', ts: '1700000000.000001'
          } } }));
        },
        async postThreadMessage(thread, text) {
          appendFileSync(${JSON.stringify(posted)}, JSON.stringify({ thread, text }) + '\\n');
          process.stdout.write('reply-sent\\n');
          return { kind: 'delivered' };
        }, stopAccepting() {}, async close() {}
      };
    }`;
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      if (url === ${JSON.stringify(moduleUrl('infra/slack/client.js'))}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fakeClient)} };
      if (url === ${JSON.stringify(moduleUrl(`features/${agent}/conversationPlan.js`))}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fakePlan)} };
      return next(url, context);
    } });
    const { runDaemon } = await import(${JSON.stringify(moduleUrl('features/daemon/runDaemon.js'))});
    await runDaemon();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repository, env: { ...process.env, TAKT_SLACK_APP_TOKEN: 'xapp-test-1', TAKT_SLACK_BOT_TOKEN: 'xoxb-test-2', PROVIDER_CANARY: 'kept' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const owner = await captureOwnedChild(child);
  try {
    await vi.waitFor(() => expect(stdout, stderr).toContain('reply-sent\n'), { timeout: 15_000 });
    child.kill('SIGTERM');
    await vi.waitFor(() => expect(child.exitCode, stderr).toBe(0), { timeout: 15_000 });
    const posts = readFileSync(posted, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      thread: { channelId: string; parentTs: string }; text: string;
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.thread).toMatchObject({ channelId: 'C0123', parentTs: '1700000000.000001' });
    expect(JSON.parse(posts[0]!.text)).toEqual({
      credentials: ['TAKT_SLACK_APP_TOKEN', 'TAKT_SLACK_BOT_TOKEN'].map((key) => ({ key, present: false, encoded: null })), canary: 'kept',
    });
    const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.some(({ name }) => name === 'daemon.log')).toBe(true);
    expect(files.some(({ name }) => name.startsWith(`${agent}-`) && name.endsWith('.json'))).toBe(true);
    const outputs = [stdout, stderr, ...files.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))];
    for (const output of outputs) for (const token of ['xapp-test-1', 'xoxb-test-2']) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(Buffer.from(token).toString('base64'));
    }
  } finally {
    if (owner !== undefined) await terminateOwnedProcess(owner, () => child.exitCode !== null || child.signalCode !== null);
  }
});

it.each(['enabled', 'no configuration', 'no app token', 'no bot token', 'duplicate channel'] as const)(
  'preserves real daemon lifetime and releases ownership with Slack %s', async (mode) => {
    const directory = process.env.TAKT_CONFIG_DIR!;
    const repository = join(directory, 'repository');
    mkdirSync(join(repository, '.takt'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'pipe' });
    const config = `provider: mock\nlanguage: ja\n${mode === 'no configuration' ? '' : 'manager:\n  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0AAA]\n'}`;
    writeFileSync(join(repository, '.takt', 'config.yaml'), config);
    await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
    let second: string | undefined;
    if (mode === 'duplicate channel') {
      second = join(directory, 'second');
      mkdirSync(join(second, '.takt'), { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: second, stdio: 'pipe' });
      writeFileSync(join(second, '.takt', 'config.yaml'), config);
      await registerProject({ globalConfigDirectory: directory, projectDirectory: second, command: 'manager', managerUsed: true });
    }
    const slackUrl = pathToFileURL(join(process.cwd(), 'dist/infra/slack/client.js')).href;
    const daemonUrl = pathToFileURL(join(process.cwd(), 'dist/features/daemon/runDaemon.js')).href;
    // Replace only the network client; owner election, polling, configuration and shutdown remain real.
    const fakeClient = `export function createSlackClient() { return {
      async start() { process.stdout.write('slack-open\\n'); },
      async postThreadMessage() { throw new Error('Unexpected Slack post'); },
      stopAccepting() {}, async close() { process.stdout.write('slack-close\\n'); }
    }; }`;
    const script = `import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url === ${JSON.stringify(slackUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fakeClient)} };
        return next(url, context);
      } });
      const { runDaemon } = await import(${JSON.stringify(daemonUrl)});
      await runDaemon(); process.stdout.write('finished\\n');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repository, env: { ...process.env,
        TAKT_SLACK_APP_TOKEN: mode === 'no app token' ? '' : 'xapp-test-1',
        TAKT_SLACK_BOT_TOKEN: mode === 'no bot token' ? '' : 'xoxb-test-2',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const owner = await captureOwnedChild(child);
    try {
      const logPath = join(directory, 'logs', 'daemon.log');
      if (mode === 'enabled') {
        await vi.waitFor(() => {
          expect(stdout, stderr).toContain('slack-open\n');
          expect(readFileSync(logPath, 'utf-8').split('Daemon projects').length).toBeGreaterThanOrEqual(4);
        }, { timeout: 15_000 });
        expect(child.exitCode).toBeNull();
        expect(readDaemonOwner(directory)?.pid).toBe(child.pid);
        expect(existsSync(join(directory, 'conversations'))).toBe(false);
        child.kill('SIGTERM');
      }
      await vi.waitFor(() => expect(child.exitCode, stderr).toBe(0), { timeout: 15_000 });
      expect(await exited).toBe(0);
      expect(readDaemonOwner(directory)).toBeUndefined();
      expect(stdout.trim().split('\n')).toEqual(mode === 'enabled' ? ['slack-open', 'slack-close', 'finished'] : ['finished']);
      const log = readFileSync(logPath, 'utf-8');
      if (mode === 'duplicate channel') {
        expect(log).toContain('C0123'); expect(log).toContain(repository); expect(log).toContain(second!);
      }
      for (const output of [stdout, stderr, log]) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(output).not.toContain(token);
    } finally {
      if (owner !== undefined) await terminateOwnedProcess(owner, () => child.exitCode !== null || child.signalCode !== null);
    }
  },
);
