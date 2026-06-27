import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const execPersonaFacets = [
  join('builtins', 'en', 'facets', 'personas', 'exec-assistant.md'),
  join('builtins', 'en', 'facets', 'personas', 'exec-worker.md'),
  join('builtins', 'ja', 'facets', 'personas', 'exec-assistant.md'),
  join('builtins', 'ja', 'facets', 'personas', 'exec-worker.md'),
] as const;

const workflowSpecificTerms = [
  'TAKT exec',
  'exec assistant',
  'exec worker',
  'TAKT exec アシスタント',
  'TAKT exec ワーカー',
  '/setup',
  '/go',
  '次アクション',
  '実行結果要約',
] as const;

const workflowSpecificProcedures = [
  'コードを変更する',
  '必要な検証を行う',
  '実行結果を要約する',
  'make code changes',
  'perform necessary validation',
  'summarize execution results',
  'summarise execution results',
] as const;

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function readPersonaFacet(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf-8');
}

describe('exec persona facets', () => {
  it('should keep workflow-specific terms and procedures out of reusable persona facets', () => {
    const forbiddenPatterns = [...workflowSpecificTerms, ...workflowSpecificProcedures].map(normalizeForSearch);

    for (const facetPath of execPersonaFacets) {
      const content = normalizeForSearch(readPersonaFacet(facetPath));

      for (const pattern of forbiddenPatterns) {
        expect(content, `${facetPath} must not include "${pattern}"`).not.toContain(pattern);
      }
    }
  });
});
