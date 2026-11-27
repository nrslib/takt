import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function verifySignature(body, signature, secret) {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const given = Buffer.from(signature ?? '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function handleWebhook({ body, signature, secret, storageRoot }) {
  if (!verifySignature(body, signature, secret)) {
    return { status: 401 };
  }
  const payload = JSON.parse(body);
  if (typeof payload.submissionId !== 'string' || !/^[A-Za-z0-9]+$/.test(payload.submissionId)) {
    return { status: 400 };
  }
  const dir = join(storageRoot, 'attachments', payload.submissionId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, payload.fileName);
  await writeFile(target, Buffer.from(payload.contentBase64, 'base64'));
  return { status: 201, path: target };
}
