import { describe, expect, it } from 'vitest';
import { probeOpenCodeHeaders } from './helpers/opencode-header-probe.js';

describe('OpenCode native MCP header environment references', () => {
  for (const generation of ['v1', 'v2'] as const) {
    const executable = process.env[generation === 'v1' ? 'TAKT_TEST_OPENCODE_V1_PATH' : 'TAKT_TEST_OPENCODE_V2_PATH'];
    it.skipIf(executable === undefined).each(['fixed', 'legacy'] as const)(`applies each project's %s headers through the ${generation} pool without copying secrets`, async (tenantSource) => {
      const result = await probeOpenCodeHeaders(executable!, generation, tenantSource);
      expect(result.version).toMatch(generation === 'v1' ? /^1\./ : /^(?:opencode v)?2\./);
      for (const observation of result.observations) {
        expect(observation.connected).toBe(true);
        expect(observation.headers.length).toBeGreaterThan(0);
        for (const headers of observation.headers) {
          expect(headers['x-tenant']).toBe(observation.tenant);
          expect(headers.authorization).toBe('Bearer synthetic-access-fragment.signature-fragment');
          expect(headers['x-key']).toBe('synthetic-key-fragment');
        }
        expect(observation.identity).not.toContain(observation.tenant);
        for (const fragment of ['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment']) {
          expect(observation.identity).not.toContain(fragment);
        }
      }
      expect(result.observations.map((item) => item.reused)).toEqual([false, true, false]);
      expect(result.startups).toHaveLength(2);
      for (const startup of result.startups) {
        expect(startup.content).toContain('{env:MCP_HEADER_ACCESS}');
        expect(startup.content).toContain('{env:MCP_HEADER_KEY}');
        for (const material of [startup.content, JSON.stringify(startup.args), startup.output]) {
          for (const fragment of ['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment']) {
            expect(material).not.toContain(fragment);
          }
        }
      }
    }, 90_000);
  }
});
