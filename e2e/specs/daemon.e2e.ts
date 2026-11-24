import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { startTaktPty, type TaktPtySession } from '../helpers/takt-pty-runner.js';
import { conversationId } from '../../src/infra/conversations/identity.js';
import { ConversationImageStore } from '../../src/infra/conversations/imageAttachments.js';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { createIsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env.js';
import { createLocalRepo } from '../helpers/test-repo.js';

// E2E更新時は docs/testing/e2e.md も更新すること
it.each(['\x07', '\x1b\\'])('pastes a manager image ending in %j at the multiline caret in a real PTY and preserves text on invalid input', async (terminator) => {
  const isolated = createIsolatedEnv(); const repository = createLocalRepo();
  updateIsolatedConfig(isolated.taktDir, { provider: 'mock', language: 'en', manager: { auto_run: false } });
  const built = (path: string) => JSON.stringify(pathToFileURL(resolve('dist', path)).href);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=', 'base64');
  const observed = join(isolated.taktDir, 'image-delivery.jsonl'); writeFileSync(observed, '');
  const preload = join(isolated.taktDir, 'image-observer.mjs');
  writeFileSync(preload, `
import { appendFileSync, readFileSync } from 'node:fs';
import { MockProvider } from ${built('infra/providers/mock.js')};
const setup = MockProvider.prototype.setup;
MockProvider.prototype.setup = function(config) {
  const agent = setup.call(this, config);
  return { ...agent, call: async (prompt, options) => {
    const metadata = /Image attachments: (\\[.*\\])/u.exec(prompt)?.[1];
    const images = metadata === undefined ? [] : JSON.parse(metadata);
    const text = JSON.parse(prompt.split('\\n').findLast((line) => line.startsWith('{"speaker":'))).text;
    appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ text, images: images.map(({ id, path }) => ({ id, path,
      readable: readFileSync(path).equals(Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64')),
      native: options.imageAttachments !== undefined })) }) + '\\n');
    return agent.call(prompt, options);
  } };
};
`);
  const scenario = join(isolated.taktDir, 'images.json');
  writeFileSync(scenario, JSON.stringify(Array.from({ length: 2 }, () => ({ persona: 'manager', content: '',
    structured_output: { message: 'Image request completed.', summary: null } }))));
  let session: TaktPtySession | undefined;
  try {
    session = startTaktPty({ args: ['manager'], cwd: repository.path, injectProvider: false,
      env: { ...isolated.env, TAKT_MOCK_SCENARIO: scenario, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    await session.waitForScreen('manager prompt', (screen) => screen.includes('Discuss your goal'));
    session.write('\x1b[200~前\n後\x1b[201~');
    await session.waitForScreen('multiline draft', (screen) => screen.includes('後'));
    session.write('\x01'); session.write('\x1b]');
    const payload = `1337;File=inline=1:${png.toString('base64')}`;
    session.write(payload.slice(0, 28)); session.write(payload.slice(28));
    if (terminator.startsWith('\x1b')) session.write('\x1b');
    session.write(terminator.slice(-1) + '末尾');
    await session.waitForScreen('image at the draft caret', (screen) => screen.includes('[Image #1]末尾後'));
    const canonical = realpathSync(repository.path);
    const images = new ConversationImageStore(canonical, conversationId({ kind: 'repository', repositoryDirectory: canonical }));
    const saved = (await images.read()).images;
    expect(saved).toHaveLength(1);
    session.write('\r');
    await session.waitForScreen('completed image response', (screen) => screen.includes('Image request completed.') && screen.includes('Discuss your goal'));
    expect(JSON.parse(readFileSync(observed, 'utf8').trim())).toEqual({ text: `前\n[Image #1] (\`${images.path(saved[0]!.fileName)}\`)末尾後`, images: [
      { id: saved[0]!.id, path: images.path(saved[0]!.fileName), readable: true, native: false },
    ] });
    session.write('本文'); session.write('\x1b]');
    session.write(`1337;File=inline=1:${Buffer.from('invalid').toString('base64')}${terminator}`);
    await session.waitForScreen('paste failure without payload in the draft', (screen) => screen.includes('The image could not be pasted.') && screen.includes('本文'));
    expect((await session.visibleScreen()).join('\n')).not.toContain('1337;File');
    session.write('\r');
    await session.waitForScreen('text-only draft submitted after image failure', (screen) => screen.includes('Discuss your goal'));
    await vi.waitFor(() => {
      const turns = readFileSync(observed, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(turns).toHaveLength(2);
      expect(turns[1]).toEqual({ text: '本文', images: [] });
    });
    session.write('\x03'); expect(await session.waitForExit()).toBe(0);
    expect((await images.read()).images).toEqual(saved);
    expect(readFileSync(images.path(saved[0]!.fileName))).toEqual(png);
  } finally {
    try { await session?.dispose(); }
    finally {
      try { await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
        `const { stopDaemon } = await import(${built('features/daemon/lifecycle.js')}); await stopDaemon();`],
      { env: isolated.env, timeout: 15_000 }); }
      finally { repository.cleanup(); isolated.cleanup(); }
    }
  }
});
it('runs manager and director turns through the dedicated daemon and restores the saved manager conversation', async () => {
  const isolated = createIsolatedEnv();
  const repository = createLocalRepo();
  updateIsolatedConfig(isolated.taktDir, { provider: 'mock', language: 'en', manager: { auto_run: false } });
  const scenario = join(isolated.taktDir, 'daemon-scenario.json');
  const built = (path: string) => JSON.stringify(pathToFileURL(resolve('dist', path)).href);
  const script = `
    const { ConversationIpcClient } = await import(${built('features/manager/conversationIpcClient.js')});
    const { registerProject } = await import(${built('infra/config/global/projectRegistry.js')});
    const { readDaemonOwner } = await import(${built('infra/daemon/owner.js')});
    const { stopDaemon } = await import(${built('features/daemon/lifecycle.js')});
    const { ConversationStateStore } = await import(${built('infra/daemon/conversationStateStore.js')});
    const { conversationId } = await import(${built('infra/conversations/identity.js')});
    const { realpath, writeFile, readFile } = await import('node:fs/promises');
    const { TAKT_MANAGER_MCP_SERVER_NAME } = await import(${built('features/manager/managerMcp.js')});
    const directory = process.env.TAKT_CONFIG_DIR;
    const repository = await realpath(process.cwd());
    await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
    await writeFile(process.env.TAKT_MOCK_SCENARIO, JSON.stringify([
      { persona: 'manager', content: '', structured_output: { message: 'manager response', summary: null },
        mcp_tool_calls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_list_goals', arguments: { cwd: repository } }] },
      { persona: 'director', content: 'director response' },
    ]));
    const identity = { kind: 'repository', repositoryDirectory: repository };
    const manager = new ConversationIpcClient(identity);
    const director = new ConversationIpcClient({ kind: 'daemon' });
    const ready = (client) => new Promise((resolve) => {
      const check = () => { if (client.getSnapshot().readStatus === 'complete') { unsubscribe(); resolve(); } };
      const unsubscribe = client.subscribe(check); check();
    });
    const turn = async (client, text) => {
      const outcome = new Promise((resolve) => {
        const unsubscribe = client.onOutput((output) => { if (output.kind === 'result') { unsubscribe(); resolve(output.result); } });
      });
      const accepted = await client.submit({ kind: 'message', text });
      if (accepted.kind !== 'accepted') throw new Error('Conversation was not accepted');
      return { accepted, result: await outcome };
    };
    try {
      await manager.connect(); await ready(manager);
      await director.connect(); await ready(director);
      const managerReply = await turn(manager, 'inspect the current goal');
      const directorReply = await turn(director, 'report the current managers');
      const calls = (await readFile(process.env.TAKT_MOCK_CALL_LOG, 'utf8')).trim().split('\\n').map((line) => JSON.parse(line));
      const usedHttpMcp = calls.some((entry) => entry.event === 'mcp_tool_call'
        && entry.mcpToolCall?.transport === 'http' && entry.mcpToolCall.tool === 'takt_list_goals');
      const owner = await readDaemonOwner(directory);
      const saved = await new ConversationStateStore(directory).read(conversationId(identity));
      manager.close(); director.close(); await stopDaemon();
      const reopened = new ConversationIpcClient(identity);
      try {
        await reopened.connect(); await ready(reopened);
        const restored = await new ConversationStateStore(directory).read(conversationId(identity));
        process.stdout.write(JSON.stringify({ managerReply, directorReply, usedHttpMcp, dedicated: owner.cliPath.endsWith('/app/daemon/index.js'),
          hadSession: saved.state.session.sessionId !== null, sameSession: saved.state.session.sessionId === restored.state.session.sessionId }));
      } finally { reopened.close(); }
    } finally { manager.close(); director.close(); await stopDaemon(); }
  `;
  try {
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repository.path, env: { ...isolated.env, TAKT_MOCK_SCENARIO: scenario, TAKT_MOCK_CALL_LOG: join(isolated.taktDir, 'mock-calls.jsonl') }, timeout: 90_000, maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ dedicated: true, hadSession: true, sameSession: true, usedHttpMcp: true,
      managerReply: { accepted: { kind: 'accepted' }, result: { kind: 'reply', message: 'manager response' } },
      directorReply: { accepted: { kind: 'accepted' }, result: { kind: 'reply', message: 'director response' } } });
  } finally {
    try { await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `const { stopDaemon } = await import(${built('features/daemon/lifecycle.js')}); await stopDaemon();`],
    { env: isolated.env, timeout: 15_000 });
    } finally { repository.cleanup(); isolated.cleanup(); }
  }
});
