import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createIsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { createLocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
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
