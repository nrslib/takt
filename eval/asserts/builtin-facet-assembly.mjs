import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';

export function assertBuiltinFacetIncluded(prompt, language, path) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../builtins', language, 'facets');
  const expanded = expandFacetIncludes({
    body: readFileSync(join(root, path), 'utf8'),
    facetsRoots: [root],
    repertoireDirs: [],
    allowedRoots: [root],
  }).body;
  assert.ok(expanded.trim().length > 0);
  assert.ok(prompt.includes(expanded), `${language}/${path} must reach the assembled prompt`);
}
