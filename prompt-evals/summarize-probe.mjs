/**
 * session.summarize() が必ず summary メッセージを作るのかを実測する。
 *
 * TAKT は「要約不要なら summary が現れない」と仮定して出現猶予を設けていたが、
 * その契約は上流のどこにも書かれていない。ローカルの偽プロバイダで確かめる。
 *
 *   node summarize-probe.mjs
 */
import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureOwnedProbeEntrypoint } from './probe-entrypoint.mjs';
import {
  listOpenCodeSessionMessages,
  OPENCODE_PROBE_STARTUP_TIMEOUT_MS,
  runOpenCodeProbe,
  summarizeOpenCodeSession,
} from './opencode-probe-lifecycle.mjs';
import { reportProbePhase } from './probe-process.mjs';

await ensureOwnedProbeEntrypoint(import.meta.url);

const recorder = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const streaming = /"stream"\s*:\s*true/.test(body);
    if (!streaming) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'p', object: 'chat.completion', created: Date.now(), model: 'probe',
        choices: [{ index: 0, message: { role: 'assistant', content: 'summary text' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish) => response.write(`data: ${JSON.stringify({
      id: 'p', object: 'chat.completion.chunk', created: Date.now(), model: 'probe',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`);
    send({ role: 'assistant', content: 'summary text' });
    send({}, 'stop');
    response.write('data: [DONE]\n\n');
    response.end();
  });
});
await new Promise((done) => recorder.listen(0, '127.0.0.1', done));
const recorderAddress = recorder.address();
if (recorderAddress === null || typeof recorderAddress === 'string') {
  throw new Error('Summary recorder did not expose a TCP port');
}

const cwd = mkdtempSync(`${tmpdir()}/takt-summarize-probe-`);

const summaryCount = async (client, sessionID) => {
  const result = await listOpenCodeSessionMessages(client, { sessionID, directory: cwd });
  return (result.data ?? []).filter((message) => message.info?.summary === true).length;
};

let finalSummaryCount = 0;
try {
  await runOpenCodeProbe({
    createProbe: () => createOpencode({
      port: 0,
      timeout: OPENCODE_PROBE_STARTUP_TIMEOUT_MS,
      config: {
        model: 'probe/probe', small_model: 'probe/probe',
        provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'probe', options: { baseURL: `http://127.0.0.1:${recorderAddress.port}/v1`, apiKey: 'x' }, models: { probe: { name: 'probe' } } } },
      },
    }),
    directory: cwd,
    onPhase: reportProbePhase,
    execute: async ({ client, sessionId, markReady }) => {
      console.log('=== 事例1: メッセージが1件も無いセッションで summarize ===');
      console.log('  summarize 前の summary 数:', await summaryCount(client, sessionId));
      const result = await summarizeOpenCodeSession(client, {
        sessionID: sessionId, directory: cwd, providerID: 'probe', modelID: 'probe', auto: false,
      });
      markReady();
      console.log('  summarize の戻り値:', JSON.stringify(result.data));
      const deadline = Date.now() + 10_000;
      let count = await summaryCount(client, sessionId);
      while (count === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        count = await summaryCount(client, sessionId);
      }
      if (count === 0) {
        throw new Error('Summarize probe timed out before a summary message appeared');
      }
      finalSummaryCount = count;
      console.log('  summarize 後の summary 数:', count);
    },
  });
} finally {
  await new Promise((done, reject) => {
    recorder.close((error) => error ? reject(error) : done());
    recorder.closeAllConnections();
  });
}
console.log(`PROBE_RESULT ${JSON.stringify({ workspace: cwd, summaryCount: finalSummaryCount })}`);
