import { describe, expect, it } from 'vitest';
import { probeOpenCodeHeaders } from './helpers/opencode-header-probe.js';

describe('OpenCode native MCP header environment references', () => {
  for (const generation of ['v1', 'v2'] as const) {
    const executable = process.env[generation === 'v1' ? 'TAKT_TEST_OPENCODE_V1_PATH' : 'TAKT_TEST_OPENCODE_V2_PATH'];
    it.skipIf(executable === undefined)(`sends referenced headers without copying values into ${generation} startup materials`, async () => {
      const result = await probeOpenCodeHeaders(executable!, generation);
      expect(result.version).toMatch(generation === 'v1' ? /^1\./ : /^(?:opencode v)?2\./);
      expect(result.connected, result.output).toBe(true);
      expect(result.received).toBe(true);
      expect(result.content).toContain('{env:MCP_HEADER_ACCESS}');
      expect(result.content).toContain('{env:MCP_HEADER_KEY}');
      for (const fragment of ['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment']) {
        expect(JSON.stringify([result.content, result.args, result.output])).not.toContain(fragment);
      }
    }, 40_000);
  }
});
