/**
 * OpenCode のプラグインフックが「スキーマ検証の前」に呼ばれるかを実測する。
 *
 * qwen3-coder-next は read の offset/limit を "290.0" のような文字列で渡す
 * （上流 #26870 / #1328、いずれも未修正）。TAKT 側で矯正できるかを確かめたい。
 * モデルは呼ばず、壊れた tool_call を返すニセの OpenAI 互換エンドポイントで再現する。
 *
 *   node plugin-probe.mjs [--plugin none|before|definition]
 */
import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureOwnedProbeEntrypoint } from './probe-entrypoint.mjs';
import {
  OPENCODE_PROBE_STARTUP_TIMEOUT_MS,
  promptOpenCodeSessionAsync,
  runOpenCodeProbe,
  runOpenCodeSessionWithEvents,
} from './opencode-probe-lifecycle.mjs';
import { reportProbePhase } from './probe-process.mjs';

await ensureOwnedProbeEntrypoint(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const mode = args.plugin ?? 'none';
const workspace = args.cwd !== undefined
  ? resolve(args.cwd)
  : mkdtempSync(join(tmpdir(), 'takt-plugin-probe-'));

mkdirSync(join(workspace, '.opencode', 'plugin'), { recursive: true });
writeFileSync(join(workspace, 'target.txt'), Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'));

const markerPath = join(workspace, 'hook-fired.txt');
const plugins = {
  none: '',
  // 実行直前に引数を矯正する
  before: `
export const CoercePlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    require("fs").appendFileSync(${JSON.stringify(markerPath)}, "before:" + input.tool + ":" + JSON.stringify(output.args) + "\\n");
    for (const key of ["offset", "limit"]) {
      const value = output.args?.[key];
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        output.args[key] = Math.trunc(Number(value));
      }
    }
  },
});
`,
  // ツール定義（スキーマ）そのものを差し替える
  definition: `
export const LooseSchemaPlugin = async () => ({
  "tool.definition": async (input, output) => {
    require("fs").appendFileSync(${JSON.stringify(markerPath)}, "definition:" + input.toolID + "\\n");
  },
});
`,
};
// mode に "-ext" を付けると、cwd の .opencode/plugin ではなく
// 外部パスを config.plugin で読み込ませる（TAKT はユーザーの repo を汚せない）。
const external = mode.endsWith('-ext');
const hookMode = external ? mode.slice(0, -4) : mode;
let externalPluginPath;
if (plugins[hookMode]) {
  if (external) {
    externalPluginPath = join(workspace, 'external-plugin.js');
    writeFileSync(externalPluginPath, plugins[hookMode]);
  } else {
    writeFileSync(join(workspace, '.opencode', 'plugin', 'probe.js'), plugins[hookMode]);
  }
}

const brokenCall = {
  id: 'call_probe', type: 'function',
  function: { name: 'read', arguments: JSON.stringify({ filePath: join(workspace, 'target.txt'), offset: '290.0', limit: '20.0' }) },
};

// OpenCode は stream: true で要求する。非ストリームの JSON を返すと
// ツール呼び出しに到達しないまま終わる（最初の版はこれで空振りした）。
let turn = 0;
const recorder = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const isTitle = body.includes('title generator');
    const streaming = /"stream"\s*:\s*true/.test(body);
    const emitTool = !isTitle && ++turn === 1;

    if (!streaming) {
      const message = emitTool
        ? { role: 'assistant', content: null, tool_calls: [brokenCall] }
        : { role: 'assistant', content: 'done' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'p', object: 'chat.completion', created: Date.now(), model: 'probe',
        choices: [{ index: 0, message, finish_reason: emitTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish) => response.write(`data: ${JSON.stringify({
      id: 'p', object: 'chat.completion.chunk', created: Date.now(), model: 'probe',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`);

    if (emitTool) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: brokenCall.id, type: 'function', function: { name: 'read', arguments: '' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: brokenCall.function.arguments } }] });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'done' });
      send({}, 'stop');
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });
});
await new Promise((done) => recorder.listen(0, '127.0.0.1', done));
const recorderAddress = recorder.address();
if (recorderAddress === null || typeof recorderAddress === 'string') {
  throw new Error('Probe recorder did not expose a TCP port');
}

const toolCalls = [];
let hookOutput = '';
try {
  await runOpenCodeProbe({
    createProbe: () => createOpencode({
      port: 0,
      timeout: OPENCODE_PROBE_STARTUP_TIMEOUT_MS,
      config: {
        model: 'probe/probe', small_model: 'probe/probe',
        provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'probe', options: { baseURL: `http://127.0.0.1:${recorderAddress.port}/v1`, apiKey: 'x' }, models: { probe: { name: 'probe' } } } },
        ...(externalPluginPath ? { plugin: [externalPluginPath] } : {}),
      },
    }),
    directory: workspace,
    onPhase: reportProbePhase,
    execute: async ({ client, sessionId, markReady }) => {
      await runOpenCodeSessionWithEvents({
        client,
        directory: workspace,
        sessionId,
        start: () => promptOpenCodeSessionAsync(client, {
          sessionID: sessionId, directory: workspace,
          model: { providerID: 'probe', modelID: 'probe' },
          parts: [{ type: 'text', text: 'Read target.txt around line 300.' }],
        }),
        onReady: markReady,
        onEvent: (event) => {
          const props = event?.properties ?? {};
          if (event?.type === 'message.part.updated' && props.part?.type === 'tool') {
            toolCalls.push({ tool: props.part.tool, status: props.part.state?.status, error: props.part.state?.error, input: props.part.state?.input });
          }
        },
      });
      hookOutput = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
    },
  });
} finally {
  await new Promise((done, reject) => {
    recorder.close((error) => error ? reject(error) : done());
    recorder.closeAllConnections();
  });
}

const byCall = new Map();
for (const call of toolCalls) byCall.set(call.tool + String(call.status), call);
const final = [...byCall.values()].filter((call) => call.status === 'completed' || call.status === 'error');
console.log(`\n=== plugin=${mode} ===`);
console.log('フック発火:', hookOutput || '（なし）');
for (const call of final) {
  console.log(`  ${call.tool}: ${call.status}`);
  if (call.error) console.log(`    error: ${String(call.error).slice(0, 110)}`);
  if (call.input) console.log(`    input: ${JSON.stringify(call.input).slice(0, 110)}`);
}
if (final.length === 0) {
  throw new Error('Probe completed without observing a terminal tool call');
}
console.log(`PROBE_RESULT ${JSON.stringify({
  mode,
  workspace,
  hookFired: hookOutput.length > 0,
  terminalStatuses: final.map((call) => call.status),
})}`);
