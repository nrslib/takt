/**
 * 'list' 互換シムの実 OpenCode（PATH のバイナリ）統合テスト。
 *
 * ローカルの OpenAI 互換プローブエンドポイントを立て、実サーバがモデルへ送る
 * tools 配列とツール実行結果を実測で検証する（モデル API は呼ばない）。
 * opencode バイナリまたは dist のプラグインが無い環境ではスキップする。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registryAllowsListToolShim,
  versionAllowsListToolShim,
} from '../infra/opencode/list-tool-shim-guard.js';

const LIST_SHIM_PLUGIN_PATH = resolve(process.cwd(), 'dist/infra/opencode/plugins/list-tool.js');

function detectOpencodeVersion(): string | undefined {
  try {
    return execFileSync('opencode', ['--version'], { encoding: 'utf-8', timeout: 15_000 }).trim();
  } catch {
    return undefined;
  }
}

const opencodeVersion = detectOpencodeVersion();
const shouldRun = opencodeVersion !== undefined && existsSync(LIST_SHIM_PLUGIN_PATH);

/**
 * 空きポートを1つ確保する。createOpencode は port 未指定だと固定 4096 を使うため、
 * 同一プロセスで2台起動すると必ず衝突する（codex 指摘）。1台目を起動して
 * ポートを占有してから2台目の空きポートを探すことで、両者に別ポートを割り当てる。
 */
function getFreePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

interface ProbeRecorder {
  server: Server;
  port: number;
  captured: Array<Record<string, unknown>>;
  /** 次の「本題」リクエストへ tool_call を返すか（1回で消費）。 */
  scriptToolCall: { name: string; arguments: string } | undefined;
  close(): Promise<void>;
}

function startProbeRecorder(): Promise<ProbeRecorder> {
  const recorder: ProbeRecorder = {
    server: undefined as unknown as Server,
    port: 0,
    captured: [],
    scriptToolCall: undefined,
    close: async () => {},
  };
  const base = () => ({ id: 'probe', object: 'chat.completion.chunk', created: Date.now(), model: 'probe' });
  recorder.server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
      const messages = (parsed.messages ?? []) as Array<{ role: string; content: unknown }>;
      const systemText = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('');
      const isTitle = systemText.startsWith('You are a title generator');
      if (request.url?.includes('chat/completions') && !isTitle) {
        recorder.captured.push(parsed);
      }
      const chunks: Array<Record<string, unknown>> = [];
      if (!isTitle && recorder.scriptToolCall !== undefined) {
        const toolCall = recorder.scriptToolCall;
        recorder.scriptToolCall = undefined;
        chunks.push(
          { ...base(), choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: toolCall }] }, finish_reason: null }] },
          { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        );
      } else {
        chunks.push(
          { ...base(), choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
          { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        );
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((done) => {
    recorder.server.listen(0, '127.0.0.1', () => {
      const address = recorder.server.address();
      recorder.port = typeof address === 'object' && address !== null ? address.port : 0;
      recorder.close = () => new Promise((closed) => { recorder.server.close(() => closed(undefined)); });
      done(recorder);
    });
  });
}

function toolNamesOf(capturedRequest: Record<string, unknown>): string[] {
  const tools = (capturedRequest.tools ?? []) as Array<{ function?: { name?: string }; name?: string }>;
  return tools.map((tool) => tool.function?.name ?? tool.name ?? '').sort();
}

type OpencodeTestHandle = {
  client: {
    tool: { ids: (p: Record<string, unknown>) => Promise<{ data?: unknown }> };
    session: {
      create: (p: Record<string, unknown>) => Promise<{ data: { id: string } }>;
      prompt: (p: Record<string, unknown>) => Promise<unknown>;
    };
  };
  server: { close?: () => void };
};

describe.skipIf(!shouldRun)('IT: opencode list tool shim against the real binary', () => {
  let recorder: ProbeRecorder;
  let workDir: string;
  let opencodeHandle: OpencodeTestHandle;
  // シムを積まない同バージョンのサーバ。衝突ガード整合検証で upstream 自身の
  // registry（'list' 不在）を実測するために使う。
  let shimlessHandle: OpencodeTestHandle;

  beforeAll(async () => {
    recorder = await startProbeRecorder();
    workDir = mkdtempSync(join(tmpdir(), 'takt-it-list-shim-'));
    writeFileSync(join(workDir, 'seeded-marker.txt'), 'seeded');

    const { createOpencode } = await import('@opencode-ai/sdk/v2');
    // 1台目に明示ポートを割り当てて起動。
    const shimmedPort = await getFreePort();
    opencodeHandle = await createOpencode({
      hostname: '127.0.0.1',
      port: shimmedPort,
      config: {
        model: 'probe/probe',
        small_model: 'probe/probe',
        plugin: [LIST_SHIM_PLUGIN_PATH],
        permission: { read: 'allow' },
        provider: {
          probe: {
            npm: '@ai-sdk/openai-compatible',
            name: 'probe',
            options: { baseURL: `http://127.0.0.1:${recorder.port}/v1`, apiKey: 'probe' },
            models: { probe: { name: 'probe' } },
          },
        },
        agent: { takt: { tools: { task: false } } },
      },
    }) as unknown as OpencodeTestHandle;

    // 同一バイナリ・同一設定で plugin だけ積まないサーバ。upstream の素の
    // registry を得るための対照。1台目が shimmedPort を占有した後に空きポートを
    // 探すので、別ポートが割り当たる（固定 4096 の衝突を避ける）。
    const shimlessPort = await getFreePort();
    shimlessHandle = await createOpencode({
      hostname: '127.0.0.1',
      port: shimlessPort,
      config: {
        model: 'probe/probe',
        small_model: 'probe/probe',
        permission: { read: 'allow' },
        provider: {
          probe: {
            npm: '@ai-sdk/openai-compatible',
            name: 'probe',
            options: { baseURL: `http://127.0.0.1:${recorder.port}/v1`, apiKey: 'probe' },
            models: { probe: { name: 'probe' } },
          },
        },
        agent: { takt: { tools: { task: false } } },
      },
    }) as unknown as OpencodeTestHandle;
  }, 120_000);

  afterAll(async () => {
    opencodeHandle?.server.close?.();
    shimlessHandle?.server.close?.();
    await recorder?.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('registers list only in environments consistent with the version allowlist', async () => {
    // シム登録済みサーバの registry には 'list' が現れる。
    const shimmedIds = await opencodeHandle.client.tool.ids({ directory: workDir });
    const shimmedRegistry = shimmedIds.data as string[];
    expect(shimmedRegistry).toContain('list');

    // 衝突ガードの本題: シムを積んでいない同バージョンのサーバの registry を
    // 別途取得し、upstream 自身が 'list' を提供していないことを直接検証する。
    // シム登録済みの registry から 'list' を除くだけだと、upstream 由来の 'list'
    // も一緒に消えて衝突を検出できない（codex 指摘）。
    const shimlessIds = await shimlessHandle.client.tool.ids({ directory: workDir });
    const shimlessRegistry = shimlessIds.data as string[];
    expect(shimlessRegistry).not.toContain('list');

    // allowlist の判定は、シム無しの実 registry（= upstream の実態）と一致する。
    // 将来 upstream が 'list' を復活させたら shimlessRegistry に 'list' が現れ、
    // registryAllowsListToolShim が false になってこの整合が破れ、検出できる。
    expect(versionAllowsListToolShim(opencodeVersion!)).toBe(registryAllowsListToolShim(shimlessRegistry));
  }, 60_000);

  it('exposes list to the model when read is enabled and executes it end to end', async () => {
    recorder.captured.length = 0;
    recorder.scriptToolCall = { name: 'list', arguments: JSON.stringify({ path: '.' }) };
    const session = await opencodeHandle.client.session.create({ directory: workDir });
    await opencodeHandle.client.session.prompt({
      sessionID: session.data.id,
      directory: workDir,
      model: { providerID: 'probe', modelID: 'probe' },
      agent: 'takt',
      tools: { read: true, list: true, glob: true, grep: true, bash: true, edit: true, write: true },
      parts: [{ type: 'text', text: 'List the current directory.' }],
    });

    expect(recorder.captured.length).toBeGreaterThanOrEqual(2);
    expect(toolNamesOf(recorder.captured[0]!)).toContain('list');
    // follow-up リクエストの tool メッセージにシムの実行結果（実ファイル名）が載る。
    const followUp = recorder.captured[recorder.captured.length - 1]!;
    const toolMessages = ((followUp.messages ?? []) as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages.join('\n')).toContain('seeded-marker.txt');
  }, 60_000);

  it('hides list from the model when the read-shaped tools are disabled', async () => {
    recorder.captured.length = 0;
    const session = await opencodeHandle.client.session.create({ directory: workDir });
    await opencodeHandle.client.session.prompt({
      sessionID: session.data.id,
      directory: workDir,
      model: { providerID: 'probe', modelID: 'probe' },
      agent: 'takt',
      // report フェーズ相当: read 系を落とす（TAKT は read→list を束ねて送る）。
      tools: { read: false, list: false, skill: false, glob: false, grep: false, bash: false, edit: false, write: true },
      parts: [{ type: 'text', text: 'Write the report.' }],
    });

    expect(recorder.captured.length).toBeGreaterThanOrEqual(1);
    const toolNames = toolNamesOf(recorder.captured[0]!);
    expect(toolNames).not.toContain('list');
    // 全ツールが消えたのではなく、read 系だけが隠れたことの対照。
    expect(toolNames).toContain('todowrite');
  }, 60_000);
});

describe.skipIf(shouldRun)('IT: opencode list tool shim (skipped)', () => {
  it('is skipped because the opencode binary or dist plugin is unavailable', () => {
    expect(shouldRun).toBe(false);
  });
});
