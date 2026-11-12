import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { readPrivateFile } from '../../infra/daemon/privateFile.js';

const slack = z.object({ channel_id: z.string().trim().min(1), allowed_user_ids: z.array(z.string().trim().min(1)) }).strict();
const config = z.object({
  language: z.enum(['ja', 'en']).optional(),
  manager: z.object({ auto_run: z.boolean().optional(), slack: slack.optional(), notifications: z.partialRecord(z.enum(['question', 'awaiting_merge', 'completed', 'progress', 'blocked', 'custom']), z.boolean()).optional(), patrol_interval: z.number().int().positive().optional() }).passthrough().optional(),
  director: z.object({ slack: slack.optional(), patrol_interval: z.unknown().optional() }).strict().optional(),
});

/** 通信・観測に使う列だけを読む。実行用の設定解決はターン子が所有する。 */
export async function readDaemonConfiguration(path: string) {
  const bytes = await readPrivateFile(path, 256 * 1024);
  if (bytes === undefined) return config.parse({});
  const document = parseDocument(bytes.toString('utf8'));
  if (document.errors.length > 0) throw document.errors[0];
  return config.parse(document.toJS({ maxAliasCount: 0 }) as unknown);
}

export function globalDaemonConfiguration(directory: string) {
  return readDaemonConfiguration(join(directory, 'config.yaml'));
}
