import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export function prepareQuestionFacetVariants(root, lang) {
  const baseline = parse(readFileSync(new URL('./red-facets.yaml', import.meta.url), 'utf8'));
  const variants = {};
  for (const facet of ['policies', 'instructions']) {
    const green = readFileSync(new URL(`../../../builtins/${lang}/facets/${facet}/manager.md`, import.meta.url), 'utf8');
    const red = baseline[lang][facet === 'policies' ? 'policy' : 'instruction'];
    variants[facet] = { red, green };
    for (const [phase, body] of Object.entries(variants[facet])) {
      const directory = join(root, phase, facet, lang);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'manager.md'), body);
    }
    assert.notEqual(red, green, `${lang}/${facet}: recorded main rules must differ from green`);
  }
  return variants;
}
