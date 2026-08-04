/**
 * Layer direction: src/core declares (src/core/constants.js) that core must
 * never import from src/app. Wiring the run summary to override semantics
 * by importing the app layer from core violates that rule; the clean fix
 * places the shared semantics in the lower layer.
 *
 * Note: the fixture baseline has no upward import, so this metric is a
 * regression guard against the fix introducing one — it has not produced a
 * red -> green signal on its own (opus avoids this trap at this fixture
 * scale; the real-run evidence comes from a 40-file change).
 */
import { join } from 'node:path';
import { listSourceFiles, readSource, relPath, workDir, fail, pass } from './fix-self-scan-lib.mjs';

// Collect every module specifier that appears in an import-like position:
// `from '...'` (import/export-from), dynamic `import('...')`, `require('...')`,
// and bare side-effect `import '...'` statements.
const SPECIFIER_PATTERNS = [
  /from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]/g,
  /(?:^|[;\s])import\s*['"]([^'"]+)['"]/g,
];

function upwardSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      // A relative specifier whose path contains an `app` segment (with or
      // without trailing slash or extension) leaves core upward.
      if (specifier.startsWith('.') && specifier.split('/').includes('app')) {
        found.add(specifier);
      }
    }
  }
  return [...found];
}

export default async function assertLayerDirection() {
  const offenders = [];
  for (const file of listSourceFiles(join(workDir, 'src', 'core'))) {
    const specifiers = upwardSpecifiers(readSource(file));
    if (specifiers.length > 0) offenders.push(`${relPath(file)} (${specifiers.join(', ')})`);
  }
  if (offenders.length > 0) {
    return fail(`core imports the app layer (upward dependency): ${offenders.join(', ')}`);
  }
  return pass('no core module imports from the app layer');
}
