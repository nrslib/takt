import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWebhook } from '../src/receiver.mjs';

const secret = 'shared-secret';
const sign = (body) => createHmac('sha256', secret).update(body).digest('hex');

test('stores an attachment under its submission directory', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'receiver-'));
  const body = JSON.stringify({ submissionId: 'A100', fileName: 'invoice.pdf', contentBase64: Buffer.from('pdf').toString('base64') });
  const result = await handleWebhook({ body, signature: sign(body), secret, storageRoot });
  assert.equal(result.status, 201);
  assert.equal(await readFile(join(storageRoot, 'attachments', 'A100', 'invoice.pdf'), 'utf8'), 'pdf');
});

test('rejects an invalid signature', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'receiver-'));
  const body = JSON.stringify({ submissionId: 'A100', fileName: 'a.txt', contentBase64: '' });
  const result = await handleWebhook({ body, signature: 'bad', secret, storageRoot });
  assert.equal(result.status, 401);
});

test('rejects a missing or malformed submission id', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'receiver-'));
  for (const submissionId of [undefined, null, 'A-100']) {
    const body = JSON.stringify({ submissionId, fileName: 'a.txt', contentBase64: '' });
    const result = await handleWebhook({ body, signature: sign(body), secret, storageRoot });
    assert.equal(result.status, 400);
  }
});
