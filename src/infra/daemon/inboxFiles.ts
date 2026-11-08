import { readPrivateFile } from './privateFile.js';

// 本文・回答各128 Ki文字のJSONエスケープ（最大6倍）とイベントメタデータを収める。
const MAX_INBOX_BYTES = 2 * 1024 * 1024;

export async function readInboxJson(path: string): Promise<unknown> {
  const content = await readPrivateFile(path, MAX_INBOX_BYTES);
  if (content === undefined) throw Object.assign(new Error(`Missing inbox file: ${path}`), { code: 'ENOENT' });
  return JSON.parse(content.toString('utf8')) as unknown;
}
