import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { hasCode, readPrivateFile } from '../../infra/daemon/privateFile.js';
import { DaemonConfigSchema } from '../../core/models/daemon-config-schema.js';
import { getErrorMessage } from '../../shared/utils/error.js';

const maxConfigBytes = 256 * 1024;
const slack = z.object({ channel_id: z.string().trim().min(1), allowed_user_ids: z.array(z.string().trim().min(1)) }).strict();
const config = z.object({
  daemon: DaemonConfigSchema.optional(),
  language: z.enum(['ja', 'en']).optional(),
  manager: z.object({ auto_run: z.boolean().optional(), slack: slack.optional(), notifications: z.partialRecord(z.enum(['question', 'awaiting_merge', 'completed', 'progress', 'blocked', 'custom']), z.boolean()).optional(), patrol_interval: z.number().int().positive().optional() }).passthrough().optional(),
  director: z.object({ slack: slack.optional(), patrol_interval: z.unknown().optional() }).strict().optional(),
});

/** 通信・観測に使う列だけを読む。実行用の設定解決はターン子が所有する。 */
export async function readDaemonConfiguration(path: string) {
  const entry = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (entry === undefined) return config.parse({});
  const resolvedPath = await realpath(path).catch(async (error: unknown) => {
    if (hasCode(error, 'ENOENT')) {
      if (entry.isSymbolicLink()) {
        const currentEntry = await lstat(path).catch((inspectionError: unknown) => {
          if (hasCode(inspectionError, 'ENOENT')) return undefined;
          throw inspectionError;
        });
        if (currentEntry?.isSymbolicLink()) {
          throw new Error(`Broken daemon configuration symlink: ${path}`, { cause: error });
        }
      }
      return undefined;
    }
    throw error;
  });
  if (resolvedPath === undefined) return config.parse({});
  let bytes: Buffer | undefined;
  try {
    if (entry.isSymbolicLink() && !(await stat(resolvedPath)).isFile()) {
      throw new Error(`Not a regular file: ${resolvedPath}`);
    }
    bytes = await readPrivateFile(resolvedPath, maxConfigBytes);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return config.parse({});
    if (!entry.isSymbolicLink()) throw error;
    throw new Error(
      `Cannot read daemon configuration symlink ${path} -> ${resolvedPath} as a regular file of at most ${maxConfigBytes} bytes: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (bytes === undefined) return config.parse({});
  const document = parseDocument(bytes.toString('utf8'));
  if (document.errors.length > 0) throw document.errors[0];
  return config.parse(document.toJS() as unknown);
}

export function globalDaemonConfiguration(directory: string) {
  return readDaemonConfiguration(join(directory, 'config.yaml'));
}
