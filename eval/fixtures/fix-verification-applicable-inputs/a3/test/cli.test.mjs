import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

test('fetches the issue and prints its key and title', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ title: '月次レポートの更新' }));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serviceUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await runCli([serviceUrl, 'OPS-42']), 'OPS-42: 月次レポートの更新\n');
  assert.deepEqual(requests, ['/issues/OPS-42']);
});

test('rejects a missing issue key', async () => {
  await assert.rejects(runCli(['http://127.0.0.1:4310']), /Usage:/);
});
