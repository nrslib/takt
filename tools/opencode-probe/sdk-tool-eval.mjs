/**
 * TAKT と同じ経路（@opencode-ai/sdk/v2 の createOpencode）でツール呼び出しの健全性を測る。
 * CLI の `opencode run` は無言で停止することがあり計器として使えないため、SDK を直接叩く。
 *
 *   node sdk-tool-eval.mjs --variant <takt|default|instructions> --prompt <file> --cwd <dir> --out <json>
 *
 * variant:
 *   takt         TAKT の opencode_agent_prompt をシステムプロンプトに使う（現行の本番設定）
 *   default      agent の prompt を渡さず opencode 既定のプロンプトを使う
 *   instructions default に加え、config.instructions で edit のスキーマだけ補足する
 */
import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureOwnedProbeEntrypoint } from './probe-entrypoint.mjs';
import {
  OPENCODE_PROBE_STARTUP_TIMEOUT_MS,
  promptOpenCodeSessionAsync,
  runOpenCodeProbe,
  runOpenCodeSessionWithEvents,
} from './opencode-probe-lifecycle.mjs';
import { reportProbePhase } from './probe-process.mjs';

await ensureOwnedProbeEntrypoint(import.meta.url);

// SDK の既定ポートは 4096 固定。並列実行すると衝突して ServeError で落ちるため、
// TAKT 本体と同じく空きポートを取ってから渡す。
function getFreePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => done(address.port));
    });
  });
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);

const variant = args.variant ?? 'default';
const cwd = resolve(args.cwd ?? process.cwd());
const outPath = resolve(args.out ?? 'sdk-tool-eval.json');
const model = args.model ?? 'ollama-cloud/qwen3-coder-next';
const cleanupProbe = args.cleanupProbe === 'true';
const providerBaseUrl = args.providerBaseUrl;
const prompt = cleanupProbe ? '' : readFileSync(resolve(args.prompt), 'utf8');
const instructionsFile = args.instructions ? resolve(args.instructions) : undefined;
const [providerId, ...modelNameParts] = model.split('/');
const modelId = modelNameParts.join('/');
if (providerId.length === 0 || modelId.length === 0) {
  throw new Error(`Model must use provider/model format: ${model}`);
}

// --systemPrompt を渡せば、その内容が agent.prompt になる（opencode 既定を置き換える）。
// 渡さなければ agent.prompt を省き、opencode 既定のプロンプトがそのまま使われる。
const systemPrompt = cleanupProbe || args.systemPrompt === undefined
  ? undefined
  : readFileSync(resolve(args.systemPrompt), 'utf8');

const config = {
  model,
  small_model: model,
  permission: { external_directory: 'deny' },
  agent: { takt: { ...(systemPrompt ? { prompt: systemPrompt } : {}), tools: { task: false } } },
  ...(providerBaseUrl ? {
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: providerId,
        options: { baseURL: providerBaseUrl, apiKey: 'probe' },
        models: { [modelId]: { name: modelId } },
      },
    },
  } : {}),
  ...(instructionsFile ? { instructions: [instructionsFile] } : {}),
};

const toolCalls = [];
let sessionError;
await runOpenCodeProbe({
  createProbe: async () => createOpencode({
    port: await getFreePort(),
    timeout: OPENCODE_PROBE_STARTUP_TIMEOUT_MS,
    config,
  }),
  directory: cwd,
  onPhase: reportProbePhase,
  execute: async ({ client, sessionId, markReady }) => {
    if (cleanupProbe) {
      markReady();
      writeFileSync(outPath, JSON.stringify({ cleanupProbe: true, workspace: cwd }, null, 2));
      return;
    }
    await runOpenCodeSessionWithEvents({
      client,
      directory: cwd,
      sessionId,
      start: () => promptOpenCodeSessionAsync(client, {
        sessionID: sessionId,
        directory: cwd,
        model: { providerID: providerId, modelID: modelId },
        agent: 'takt',
        parts: [{ type: 'text', text: prompt }],
      }),
      onReady: markReady,
      onEvent: (event) => {
        const props = event?.properties ?? {};
        if (event?.type === 'message.part.updated' && props.part?.type === 'tool') {
          const part = props.part;
          toolCalls.push({
            tool: part.tool,
            callId: part.callID ?? part.id,
            status: part.state?.status,
            input: part.state?.input,
            output: part.state?.output,
            error: part.state?.error,
          });
        }
        if (event?.type === 'session.error' && (!props.sessionID || props.sessionID === sessionId)) {
          sessionError = JSON.stringify(props.error);
        }
      },
    });
  },
});

// 1 回の呼び出しが pending → running → completed と複数イベントで届くため、
// callId で畳んで最終状態だけを 1 件として数える。
const byCall = new Map();
for (const call of toolCalls) byCall.set(call.callId, call);
const calls = [...byCall.values()];
const completed = calls.filter((call) => call.status === 'completed');
const errored = calls.filter((call) => call.status === 'error');
const schemaErrors = errored.filter((call) => /SchemaError/.test(String(call.error)));
const missingKey = errored.filter((call) => /Missing key/.test(String(call.error)));

function assertSuccessfulToolEvaluation() {
  if (sessionError !== undefined) {
    throw new Error(`SDK tool evaluation reported a session error: ${sessionError}`);
  }
  if (calls.length === 0) {
    throw new Error('SDK tool evaluation completed without observing a tool call');
  }
  const unsuccessful = calls.filter((call) => call.status !== 'completed');
  if (unsuccessful.length > 0) {
    throw new Error(`SDK tool evaluation observed non-completed calls: ${JSON.stringify(unsuccessful)}`);
  }
  for (const call of calls) {
    if (
      typeof call.tool !== 'string'
      || call.tool.length === 0
      || call.tool === 'invalid'
      || typeof call.callId !== 'string'
      || call.callId.length === 0
      || call.input === null
      || typeof call.input !== 'object'
      || Object.keys(call.input).length === 0
      || typeof call.output !== 'string'
      || call.output.length === 0
    ) {
      throw new Error(`SDK tool evaluation observed an incomplete completed call: ${JSON.stringify(call)}`);
    }
  }
}

if (cleanupProbe) {
  console.log(`PROBE_RESULT ${JSON.stringify({ workspace: cwd, cleanupProbe: true })}`);
} else {
  writeFileSync(outPath, JSON.stringify({ variant, model, cwd, sessionError, calls, events: toolCalls }, null, 2));
  assertSuccessfulToolEvaluation();
  console.log(
    `variant=${variant} calls=${calls.length} completed=${completed.length} ` +
    `errors=${errored.length} schemaErrors=${schemaErrors.length} missingKey=${missingKey.length}` +
    `${sessionError ? ` sessionError=${sessionError}` : ''} → ${outPath}`,
  );
  console.log(`PROBE_RESULT ${JSON.stringify({ workspace: cwd, variant, calls: calls.length })}`);
}
