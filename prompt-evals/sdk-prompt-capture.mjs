/**
 * opencode がモデルへ実際に送るリクエストボディを捕まえる。
 * ローカルに OpenAI 互換エンドポイントを立て、opencode のプロバイダをそこへ向ける。
 * system プロンプトに何が入っているかを、推測ではなく実物で確認するための計器。
 *
 *   node sdk-prompt-capture.mjs [--instructions <file>] [--taktPrompt <file>] [--needle ACK-7731]
 */
import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const needle = args.needle ?? 'ACK-7731';
const cwd = resolve(args.cwd ?? process.cwd());
const instructionsFile = args.instructions ? resolve(args.instructions) : undefined;
const taktPromptFile = args.taktPrompt ? resolve(args.taktPrompt) : undefined;
const capturePath = resolve(args.capture ?? 'captured-request.json');

// opencode は本題の前に small_model でスレッドタイトルを生成する。
// 最初の 1 本を掴むとそれを拾うため、全リクエストを記録して後で選ぶ。
const captured = [];
const recorder = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    if (request.url?.includes('chat/completions') || request.url?.includes('/responses')) {
      captured.push(body);
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'probe', object: 'chat.completion', created: Date.now(), model: 'probe',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((done) => recorder.listen(8899, '127.0.0.1', done));

const config = {
  model: 'probe/probe',
  small_model: 'probe/probe',
  provider: {
    probe: {
      npm: '@ai-sdk/openai-compatible',
      name: 'probe',
      options: { baseURL: 'http://127.0.0.1:8899/v1', apiKey: 'probe' },
      models: { probe: { name: 'probe' } },
    },
  },
  agent: {
    takt: {
      ...(taktPromptFile ? { prompt: readFileSync(taktPromptFile, 'utf8') } : {}),
      tools: { task: false },
    },
  },
  ...(instructionsFile ? { instructions: [instructionsFile] } : {}),
};

const { client, server } = await createOpencode({ config });
try {
  const session = await client.session.create({ directory: cwd });
  await client.session.prompt({
    sessionID: session.data.id,
    directory: cwd,
    model: { providerID: 'probe', modelID: 'probe' },
    agent: 'takt',
    parts: [{ type: 'text', text: 'Say OK.' }],
  });
} catch (error) {
  console.log('prompt error:', String(error).slice(0, 200));
} finally {
  await server.close?.();
  recorder.close();
}

if (captured.length === 0) {
  console.log('リクエストを捕捉できませんでした');
  process.exit(1);
}
writeFileSync(capturePath, JSON.stringify(captured.map((body) => JSON.parse(body)), null, 2));
console.log(`捕捉したリクエスト: ${captured.length} 本`);
captured.forEach((body, requestIndex) => {
  const parsed = JSON.parse(body);
  const systemMessages = (parsed.messages ?? []).filter((message) => message.role === 'system');
  const systemText = systemMessages.map((message) => message.content).join('\n---\n');
  const isTitle = systemText.startsWith('You are a title generator');
  console.log(`\n[リクエスト ${requestIndex}] ${isTitle ? 'タイトル生成' : '本題'}  system ${systemMessages.length}件 / ${systemText.length}字`);
  console.log(`  "${needle}" を含むか: ${systemText.includes(needle) ? 'はい' : 'いいえ'}`);
  systemMessages.forEach((message, index) => {
    console.log(`    [${index}] ${String(message.content).length}字  先頭: ${JSON.stringify(String(message.content).slice(0, 60))}`);
  });
});
