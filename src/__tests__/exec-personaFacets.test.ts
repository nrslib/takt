import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const execPersonaFacets = [
  {
    path: ['builtins', 'en', 'facets', 'personas', 'exec-assistant.md'],
    expectedIdentity: 'You are a TAKT assistant.',
  },
  {
    path: ['builtins', 'en', 'facets', 'personas', 'exec-worker.md'],
    expectedIdentity: 'You are a TAKT worker.',
  },
  {
    path: ['builtins', 'ja', 'facets', 'personas', 'exec-assistant.md'],
    expectedIdentity: 'あなたは TAKT アシスタントです。',
  },
  {
    path: ['builtins', 'ja', 'facets', 'personas', 'exec-worker.md'],
    expectedIdentity: 'あなたは TAKT ワーカーです。',
  },
] as const;

const workflowSpecificTerms = [
  /TAKT exec/i,
  /exec assistant/i,
  /exec worker/i,
  /TAKT exec アシスタント/,
  /TAKT exec ワーカー/,
] as const;

describe('exec persona facets', () => {
  it('should define reusable TAKT personas without exec workflow terms', () => {
    for (const facet of execPersonaFacets) {
      const content = readFileSync(join(process.cwd(), ...facet.path), 'utf-8');

      expect(content).toContain(facet.expectedIdentity);
      for (const term of workflowSpecificTerms) {
        expect(content).not.toMatch(term);
      }
    }
  });
});
