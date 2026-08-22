import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callDeepSeekHarness } from '../infra/deepseek-harness/index.js';
import { DEEPSEEK_HARNESS_DEFAULT_MODEL } from '../infra/deepseek-harness/constants.js';

const liveSmokeEnabled = process.env.TAKT_DEEPSEEK_HARNESS_LIVE === '1';
const supportedRuntime = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);

describe('DeepSeek Harness live smoke', () => {
  it.skipIf(!liveSmokeEnabled)('runs one real workspace turn when explicitly enabled', async () => {
    if (!supportedRuntime) {
      throw new Error('DeepSeek Harness live smoke requires Linux x64/arm64 or macOS arm64');
    }
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error('DEEPSEEK_API_KEY must be set for the DeepSeek Harness live smoke');
    }

    const workspace = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-live-smoke-'));
    try {
      const response = await callDeepSeekHarness(
        'live-smoke',
        'Reply with a short confirmation that the DeepSeek Harness workspace smoke test completed.',
        {
          cwd: workspace,
          model: DEEPSEEK_HARNESS_DEFAULT_MODEL,
          providerOptions: { requestTimeoutMs: 30_000 },
        },
      );

      expect(response.status).toBe('done');
      expect(response.content.trim().length).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 45_000);
});
