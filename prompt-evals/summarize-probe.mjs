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
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
await new Promise((done) => recorder.listen(8901, '127.0.0.1', done));

const port = await new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => done(free)); });
});

const cwd = mkdtempSync(`${tmpdir()}/takt-summarize-probe-`);
const { client, server } = await createOpencode({
  port,
  config: {
    model: 'probe/probe', small_model: 'probe/probe',
    provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'probe', options: { baseURL: 'http://127.0.0.1:8901/v1', apiKey: 'x' }, models: { probe: { name: 'probe' } } } },
  },
});

const summaryCount = async (sessionID) => {
  const result = await client.session.messages({ sessionID, directory: cwd });
  return (result.data ?? []).filter((message) => message.info?.summary === true).length;
};

try {
  const session = await client.session.create({ directory: cwd });
  const sessionID = session.data.id;

  console.log('=== 事例1: メッセージが1件も無いセッションで summarize ===');
  console.log('  summarize 前の summary 数:', await summaryCount(sessionID));
  try {
    const result = await client.session.summarize({
      sessionID, directory: cwd, providerID: 'probe', modelID: 'probe', auto: false,
    });
    console.log('  summarize の戻り値:', JSON.stringify(result.data));
  } catch (error) {
    console.log('  summarize が例外:', String(error).slice(0, 120));
  }
  for (const waited of [1, 3, 6, 11, 16]) {
    await new Promise((resolve) => setTimeout(resolve, waited === 1 ? 1000 : 2000));
    console.log(`  ${waited}s 後の summary 数:`, await summaryCount(sessionID));
  }
} finally {
  await server.close?.();
  recorder.close();
}
