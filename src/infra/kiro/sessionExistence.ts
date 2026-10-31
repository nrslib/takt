import { resolveKiroApiKey, resolveKiroCliPath } from '../config/index.js';
import { execKiro } from './process.js';

const LIST_TIMEOUT_MS = 10_000;
const SESSION_ROW = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s{2,}updated\s+.+$/i;

/** Returns undefined when the listing cannot establish the session's existence. */
export async function kiroSessionExists(cwd: string, sessionId: string): Promise<true | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const result = await execKiro(['chat', '--list-sessions'], {
      cwd,
      kiroCliPath: resolveKiroCliPath(),
      kiroApiKey: resolveKiroApiKey(),
      abortSignal: controller.signal,
    });
    if (controller.signal.aborted) return undefined;
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
      const match = SESSION_ROW.exec(line);
      if (match?.[1]?.toLowerCase() === sessionId.toLowerCase()) return true;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
