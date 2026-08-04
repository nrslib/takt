/**
 * Layer direction: src/core declares (src/core/constants.js) that core must
 * never import from src/app. Wiring the run summary to override semantics
 * by importing the app layer from core violates that rule; the clean fix
 * places the shared semantics in the lower layer.
 *
 * Module specifiers are extracted from the parsed AST (import/export-from
 * declarations, dynamic import(), require()), so a comment or string that
 * merely mentions an import cannot produce a false violation. The extractor
 * self-checks its regression shapes at load time.
 *
 * Note: the fixture baseline has no upward import, so this metric is a
 * regression guard against the fix introducing one — it has not produced a
 * red -> green signal on its own (opus avoids this trap at this fixture
 * scale; the real-run evidence comes from a 40-file change).
 */
import ts from 'typescript';
import { join } from 'node:path';
import { listSourceFiles, readSource, relPath, workDir, fail, pass } from './fix-self-scan-lib.mjs';

// Extracts every real module specifier: static import / export-from
// declarations (side-effect imports included), dynamic import(), require().
export function moduleSpecifiers(source, fileName = 'module.js') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const arg = node.arguments[0];
      if ((isDynamicImport || isRequire) && arg !== undefined && ts.isStringLiteral(arg)) {
        specifiers.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

// A relative specifier whose path contains an `app` segment (with or
// without trailing slash or extension) leaves core upward.
function upwardSpecifiers(source, fileName) {
  return [...new Set(
    moduleSpecifiers(source, fileName)
      .filter((specifier) => specifier.startsWith('.') && specifier.split('/').includes('app')),
  )];
}

export default async function assertLayerDirection() {
  const offenders = [];
  for (const file of listSourceFiles(join(workDir, 'src', 'core'))) {
    const specifiers = upwardSpecifiers(readSource(file), relPath(file));
    if (specifiers.length > 0) offenders.push(`${relPath(file)} (${specifiers.join(', ')})`);
  }
  if (offenders.length > 0) {
    return fail(`core imports the app layer (upward dependency): ${offenders.join(', ')}`);
  }
  return pass('no core module imports from the app layer');
}

// Regression self-check: real import forms must be detected; comments and
// strings that mention imports must not. Throws at load time on drift.
const MUST_DETECT = [
  ['named import', `import { x } from '../app/override.js';`],
  ['side-effect import', `import '../app/foo.js';`],
  ['extension-less specifier', `import { x } from '../app';`],
  ['export from', `export { x } from '../app/override.js';`],
  ['dynamic import', `const m = await import('../app/foo.js');`],
  ['require call', `const m = require('../app/foo.js');`],
];
const MUST_ALLOW = [
  ['comment mentioning an import', `// import '../app/foo.js'\nexport const x = 1;`],
  ['block comment mentioning an import', `/* import { y } from '../app/foo.js' */\nexport const x = 1;`],
  ['string containing an import statement', `const note = "import '../app/foo.js'";`],
  ['template literal containing an import', 'const note = `import "../app/foo.js"`;'],
  ['downward import', `import { ORIGINS } from './constants.js';`],
  ['app substring in a non-app segment', `import { x } from './happy/path.js';`],
];
for (const [label, source] of MUST_DETECT) {
  if (upwardSpecifiers(source, 'case.js').length === 0) {
    throw new Error(`layer specifier extractor regression: no longer detects ${label}`);
  }
}
for (const [label, source] of MUST_ALLOW) {
  if (upwardSpecifiers(source, 'case.js').length > 0) {
    throw new Error(`layer specifier extractor regression: false positive on ${label}`);
  }
}
