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
const prompt = readFileSync(resolve(args.prompt), 'utf8');
const instructionsFile = args.instructions ? resolve(args.instructions) : undefined;

// --systemPrompt を渡せば、その内容が agent.prompt になる（opencode 既定を置き換える）。
// 渡さなければ agent.prompt を省き、opencode 既定のプロンプトがそのまま使われる。
const systemPrompt = args.systemPrompt ? readFileSync(resolve(args.systemPrompt), 'utf8') : undefined;

const config = {
  model,
  small_model: model,
  permission: { external_directory: 'deny' },
  agent: { takt: { ...(systemPrompt ? { prompt: systemPrompt } : {}), tools: { task: false } } },
  ...(instructionsFile ? { instructions: [instructionsFile] } : {}),
};

const toolCalls = [];
let sessionError;
const { client, server } = await createOpencode({ port: await getFreePort(), config });

try {
  const session = await client.session.create({ directory: cwd });
  const sessionID = session.data.id;

  const { stream } = await client.event.subscribe({ directory: cwd });
  const done = client.session.promptAsync({
    sessionID,
    directory: cwd,
    model: { providerID: model.split('/')[0], modelID: model.split('/').slice(1).join('/') },
    agent: 'takt',
    parts: [{ type: 'text', text: prompt }],
  }).catch((error) => { sessionError = String(error); });

  // TAKT と同じく session.idle まで読む。promptAsync はプロンプト投入で解決するため
  // 完了検知には使えない。
  for await (const event of stream) {
    const props = event?.properties ?? {};
    if (event?.type === 'message.part.updated' && props.part?.type === 'tool') {
      const part = props.part;
      toolCalls.push({
        tool: part.tool,
        callId: part.callID ?? part.id,
        status: part.state?.status,
        input: part.state?.input,
        error: part.state?.error,
      });
    }
    if (event?.type === 'session.error' && (!props.sessionID || props.sessionID === sessionID)) {
      sessionError = JSON.stringify(props.error);
      break;
    }
    if (event?.type === 'session.idle' && props.sessionID === sessionID) break;
    if (event?.type === 'session.status' && props.sessionID === sessionID && props.status?.type === 'idle') break;
  }
  await done;
} finally {
  await server.close?.();
}

// 1 回の呼び出しが pending → running → completed と複数イベントで届くため、
// callId で畳んで最終状態だけを 1 件として数える。
const byCall = new Map();
for (const call of toolCalls) byCall.set(call.callId, call);
const calls = [...byCall.values()];
const completed = calls.filter((call) => call.status === 'completed');
const errored = calls.filter((call) => call.status === 'error');
const schemaErrors = errored.filter((call) => /SchemaError/.test(String(call.error)));
const missingKey = errored.filter((call) => /Missing key/.test(String(call.error)));

writeFileSync(outPath, JSON.stringify({ variant, model, cwd, sessionError, calls, events: toolCalls }, null, 2));
console.log(
  `variant=${variant} calls=${calls.length} completed=${completed.length} ` +
  `errors=${errored.length} schemaErrors=${schemaErrors.length} missingKey=${missingKey.length}` +
  `${sessionError ? ` sessionError=${sessionError}` : ''} → ${outPath}`,
);
