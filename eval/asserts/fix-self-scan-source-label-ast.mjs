/**
 * AST-based detection of leftover multi-parameter `sourceLabel` shapes.
 * A regex/paren walker misreads strings containing `)` and misses alias
 * exports (`export { impl as sourceLabel }`), and `Function.length` does
 * not count default parameters — so calls, bindings, and export aliases
 * are resolved from the parsed tree instead (typescript is already a
 * devDependency; its parser handles plain JS).
 *
 * The module self-checks its detector against the known evasion shapes on
 * load and throws if any regression case stops being detected.
 */
import ts from 'typescript';

function bindingParamCounts(sourceFile) {
  const counts = new Map();
  const localAliases = new Map();
  const reExports = [];
  const importAliases = new Set();
  const record = (name, node) => {
    if (name) counts.set(name, node.parameters.length);
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node)) record(node.name?.text, node);
    if (ts.isVariableDeclaration(node) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && ts.isIdentifier(node.name)) {
      record(node.name.text, node.initializer);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const exported = spec.name.text;
        const local = (spec.propertyName ?? spec.name).text;
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          reExports.push({ exported, local, specifier: node.moduleSpecifier.text });
        } else {
          localAliases.set(exported, local);
        }
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const spec of node.importClause.namedBindings.elements) {
        if ((spec.propertyName ?? spec.name).text === 'sourceLabel') {
          importAliases.add(spec.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { counts, localAliases, reExports, importAliases };
}

// Returns human-readable violations for multi-argument sourceLabel calls
// and multi-parameter functions exported or bound as sourceLabel.
// `resolveModule(specifier)` supplies the source text of a relative module
// so `export { impl as sourceLabel } from './impl.js'` can be followed one
// hop; an unresolvable sourceLabel re-export is itself a violation.
export function sourceLabelViolations(source, fileName = 'module.js', resolveModule = () => undefined) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const violations = [];
  const { counts, localAliases, reExports, importAliases } = bindingParamCounts(sourceFile);

  const callNames = new Set(['sourceLabel', ...importAliases]);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : (ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined);
      if (name !== undefined && callNames.has(name) && node.arguments.length > 1) {
        violations.push(`call with ${node.arguments.length} arguments: \`${node.getText().split('\n')[0].slice(0, 60)}\``);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const boundNames = new Set(['sourceLabel']);
  if (localAliases.has('sourceLabel')) boundNames.add(localAliases.get('sourceLabel'));
  for (const name of boundNames) {
    const params = counts.get(name);
    if (params !== undefined && params > 1) {
      violations.push(`function \`${name}\` (exported or bound as sourceLabel) declares ${params} parameters`);
    }
  }

  for (const { exported, local, specifier } of reExports) {
    if (exported !== 'sourceLabel') continue;
    const targetSource = resolveModule(specifier);
    if (targetSource === undefined) {
      violations.push(`re-export \`${local}\` as sourceLabel from unresolvable module '${specifier}'`);
      continue;
    }
    const target = bindingParamCounts(
      ts.createSourceFile(specifier, targetSource, ts.ScriptTarget.ES2022, true),
    );
    const params = target.counts.get(local);
    if (params === undefined) {
      violations.push(`re-export \`${local}\` as sourceLabel: definition not found in '${specifier}'`);
    } else if (params > 1) {
      violations.push(`function \`${local}\` (re-exported as sourceLabel from '${specifier}') declares ${params} parameters`);
    }
  }
  return violations;
}

// Regression self-check: every known evasion must stay detected, every
// clean shape must stay clean. Throws at load time on drift. Entries may
// carry a mock module resolver as a third element.
const TWO_PARAM_IMPL = `export function impl(name, origin = 'unknown') { return name; }`;
const ONE_PARAM_IMPL = `export function impl(origin) { return origin; }`;
const MUST_DETECT = [
  ['string containing a paren', `sourceLabel(")", origin);`],
  ['template literal containing a paren', 'sourceLabel(`)`, origin);'],
  ['nested call', 'sourceLabel(normalize(name), origin);'],
  ['default parameter', `export function sourceLabel(origin, fallback = 'unknown') { return fallback; }`],
  ['alias export with default parameter', `function impl(name, origin = 'unknown') { return name; }\nexport { impl as sourceLabel };`],
  ['arrow binding with two parameters', `const sourceLabel = (name, origin) => name;`],
  ['re-export from another module with two parameters',
    `export { impl as sourceLabel } from './impl.js';`, () => TWO_PARAM_IMPL],
  ['re-export from an unresolvable module',
    `export { ghost as sourceLabel } from './missing.js';`, () => undefined],
  ['import alias called with two arguments',
    `import { sourceLabel as label } from './resolve.js';\nlabel(name, origin);`],
];
const MUST_ALLOW = [
  ['single argument call', 'sourceLabel(entry.origin);'],
  ['single parameter function', 'export function sourceLabel(origin) { return origin; }'],
  ['destructuring single parameter', 'export function sourceLabel({ origin }) { return origin; }'],
  ['unrelated two-argument call', 'otherLabel(a, b);'],
  ['url string near a call', `const url = 'https://example.test'; sourceLabel(entry.origin);`],
  ['re-export from another module with one parameter',
    `export { impl as sourceLabel } from './impl.js';`, () => ONE_PARAM_IMPL],
  ['import alias called with one argument',
    `import { sourceLabel as label } from './resolve.js';\nlabel(name);`],
];
for (const [label, source, resolver] of MUST_DETECT) {
  if (sourceLabelViolations(source, 'case.js', resolver).length === 0) {
    throw new Error(`sourceLabel detector regression: no longer detects ${label}`);
  }
}
for (const [label, source, resolver] of MUST_ALLOW) {
  if (sourceLabelViolations(source, 'case.js', resolver).length > 0) {
    throw new Error(`sourceLabel detector regression: false positive on ${label}`);
  }
}
