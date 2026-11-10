import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';
import { copyManagerTurnContextHarness } from './prepare-manager-turn-context-red.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scenario = 'eval/scenarios/manager-work-split/manager-work-split.yaml';

function dependencies(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const references = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      references.push(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) references.push(node.arguments[0]);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') references.push(node.arguments?.[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references.filter((node) => node && ts.isStringLiteral(node) && node.text.startsWith('.'))
    .map((node) => resolve(dirname(path), node.text))
    .filter((path) => path.startsWith(join(root, 'eval/')) && path.endsWith('.mjs'));
}

test('red preparation copies exactly the manager suite fixtures and its harness dependencies', () => {
  const suite = parse(readFileSync(join(root, scenario), 'utf8'));
  const required = new Set([scenario, 'eval/manager-work-split-config.mjs', 'eval/manager-turn-context-baseline.mjs']);
  function collectReferences(value) {
    if (typeof value === 'string' && value.startsWith('file://')) {
      required.add(relative(root, resolve(root, dirname(scenario), value.slice('file://'.length))));
    } else if (Array.isArray(value)) value.forEach(collectReferences);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectReferences);
  }
  collectReferences(suite);
  const cases = new Set(suite.tests.map(({ vars }) => vars.case));
  for (const name of cases) required.add(`eval/cases/manager-work-split/${name}.yaml`);
  // Follow imports and the SDK worker entrypoint; the main runner uses the manager config filter.
  for (const path of required) {
    if (path.endsWith('.mjs')) {
      for (const dependency of dependencies(join(root, path))) required.add(relative(root, dependency));
    }
  }

  const target = mkdtempSync(join(tmpdir(), 'takt-manager-red-copy-'));
  const untouched = ['src/production.ts', 'builtins/ja/facets/instructions/manager.md',
    'eval/asserts/external-confirmation.mjs', 'eval/cases/another-suite/fixture.yaml',
    'eval/scripts/run-evals.mjs', 'eval/scripts/merge-ci-public-results.mjs',
    'eval/suite-registry.mjs', 'eval/adjudicator-no-fix-cases.mjs'];
  try {
    for (const path of untouched) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      writeFileSync(join(target, path), `baseline:${path}`);
    }
    const copied = copyManagerTurnContextHarness(root, target);
    assert.deepEqual(new Set(copied), required, 'missing dependencies or unrelated assets in the copy manifest');
    for (const path of required) assert.deepEqual(readFileSync(join(target, path)), readFileSync(join(root, path)), path);
    assert.deepEqual(new Set(readdirSync(join(target, 'eval/cases/manager-work-split'))),
      new Set([...cases].map((name) => `${name}.yaml`)));
    for (const path of untouched) assert.equal(readFileSync(join(target, path), 'utf8'), `baseline:${path}`);
    const files = readdirSync(target, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      .map((entry) => relative(target, join(entry.parentPath, entry.name)));
    assert.deepEqual(new Set(files), new Set([...required, ...untouched]));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
