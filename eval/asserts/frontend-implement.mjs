/**
 * Artifact assertions for the frontend-implement coder eval.
 * Inspects files written by the agent in eval/.work/frontend-implement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../.work/frontend-implement');

function read(path) {
  const full = join(workDir, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

export default function assertFrontendImplement() {
  const searchBox = read('src/shared/components/search-box.tsx');
  const route = read('src/app/routes/user-list.tsx');
  const checks = [
    {
      name: 'search-box-created',
      pass: !!searchBox && /export function SearchBox|export const SearchBox|export default function SearchBox/.test(searchBox),
    },
    {
      name: 'search-box-layering',
      pass: !!searchBox && !/from\s+['"][^'"]*(features|app)\//.test(searchBox),
    },
    {
      name: 'route-uses-search-box',
      pass: !!route && /SearchBox/.test(route) && /search-box/.test(route),
    },
  ];
  const failed = checks.filter((c) => !c.pass);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'all artifact checks passed'
      : `failed: ${failed.map((c) => c.name).join(', ')}`,
  };
}
