import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/frontend-mediator/', import.meta.url));
const workDirectory = fileURLToPath(new URL('../.work/frontend-mediator-implement/', import.meta.url));
const ignoredDirectories = new Set(['.git', '.takt', 'node_modules', 'dist', 'coverage']);
const sourcePattern = /\.[cm]?[jt]sx?$/;
const testPattern = /(?:^|\/)(?:__tests__|__mocks__|tests?|test-setup)(?:\/|\.)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:setupTests|test-utils)\.[cm]?[jt]sx?$/i;
const statePackages = new Set([
  'xstate', '@xstate/react', '@xstate/store', 'zustand', 'redux', 'react-redux',
  '@reduxjs/toolkit', 'jotai', 'recoil', 'mobx', 'mobx-react', 'mobx-react-lite',
  'valtio', 'robot3', 'react-robot', '@tanstack/store', '@tanstack/react-store',
]);

// The provider and assertions read the files themselves; agent summaries are not evidence.
export function readProjectFiles(directory, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symbolic link: ${path}`);
    if (entry.isDirectory()) Object.assign(files, readProjectFiles(directory, path));
    else if (entry.isFile()) files[path] = readFileSync(join(directory, path), 'utf8');
  }
  return files;
}

export function changedProjectPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path]).sort();
}

function packageName(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function reactBaseNames(source) {
  const components = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'react') continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (['Component', 'PureComponent'].includes((item.propertyName ?? item.name).text)) {
          components.add(item.name.text);
        }
      }
    }
  }
  return { components, namespaces };
}

function isReactClass(node, bases) {
  return node.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword
    && clause.types.some(type => {
      const base = type.expression;
      return (ts.isIdentifier(base) && bases.components.has(base.text))
        || (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression)
          && bases.namespaces.has(base.expression.text)
          && ['Component', 'PureComponent'].includes(base.name.text));
    })) === true;
}

function hasInstanceState(node) {
  const collectionFields = new Set();
  const mutableFields = new Set();
  const instanceMembers = node.members.filter(member => !member.modifiers?.some(
    modifier => modifier.kind === ts.SyntaxKind.StaticKeyword,
  ));
  function addField(name, modifiers) {
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) mutableFields.add(name);
  }
  function isCollection(expression) {
    return ts.isArrayLiteralExpression(expression) || (ts.isNewExpression(expression)
      && ts.isIdentifier(expression.expression) && ['Array', 'Map', 'Set'].includes(expression.expression.text));
  }
  for (const member of instanceMembers) {
    if (ts.isPropertyDeclaration(member)
      && (!member.initializer || (!ts.isArrowFunction(member.initializer) && !ts.isFunctionExpression(member.initializer)))) {
      addField(member.name.getText(), member.modifiers);
      if (member.initializer && isCollection(member.initializer)) collectionFields.add(member.name.getText());
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (ts.isParameterPropertyDeclaration(parameter, member)) addField(parameter.name.getText(), parameter.modifiers);
      }
    }
  }
  let updatesState = false;
  function fieldName(expression) {
    if (ts.isPropertyAccessExpression(expression)) {
      return expression.expression.kind === ts.SyntaxKind.ThisKeyword
        ? expression.name.getText() : fieldName(expression.expression);
    }
    if (ts.isElementAccessExpression(expression)) {
      return expression.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text : fieldName(expression.expression);
    }
    return undefined;
  }
  function inspectUpdate(child, constructor) {
    if (ts.isClassDeclaration(child) || ts.isClassExpression(child)) return;
    if (ts.isBinaryExpression(child)
      && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const field = fieldName(child.left);
      if (field !== undefined) {
        if (constructor) {
          addField(field, undefined);
          if (isCollection(child.right)) collectionFields.add(field);
        } else updatesState = true;
      }
    }
    if (!constructor && (ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator)
      && fieldName(child.operand) !== undefined) updatesState = true;
    if (!constructor && ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
      && ['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].includes(child.expression.name.text)
      && collectionFields.has(fieldName(child.expression.expression))) updatesState = true;
    ts.forEachChild(child, nested => inspectUpdate(nested, constructor));
  }
  for (const member of instanceMembers) inspectUpdate(member, ts.isConstructorDeclaration(member));
  const subscriptionMember = /^(?:listeners?|subscribers?|subscribe|unsubscribe|notify|emit|publish|addListener|removeListener)$/i;
  const subscribesOrNotifies = instanceMembers.some(member => member.name
    && subscriptionMember.test(member.name.getText()))
    || [...collectionFields].some(name => subscriptionMember.test(name));
  // Internal mutable state alone does not establish UI ownership; leave it to the structural rubric.
  return (updatesState || mutableFields.size > 0) && subscribesOrNotifies;
}

function inspectSource(path, text, allowedPackages) {
  const production = !testPattern.test(path);
  // Object factories, transition tables and generic hooks require structural rubric review.
  // Do not guess ownership from their names and reject valid page hooks or local reducers.
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const failures = [];
  const bases = reactBaseNames(source);
  const rejectImport = specifier => {
    const name = packageName(specifier);
    if (statePackages.has(name) && !allowedPackages.has(name)) {
      failures.push(`${path}: new state library ${specifier}`);
    }
  };
  function visit(node) {
    if (production && ts.isIdentifier(node) && /mediator/i.test(node.text)) {
      failures.push(`${path}: mediator identifier ${node.text}`);
    }
    if (production && (ts.isClassDeclaration(node) || ts.isClassExpression(node)) && !isReactClass(node, bases)
      && hasInstanceState(node)) {
      failures.push(`${path}: non-React class holding mutable UI state`);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      rejectImport(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      rejectImport(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return failures;
}

export function inspectFrontendArtifacts(directory) {
  const before = readProjectFiles(fixtureDirectory);
  const after = readProjectFiles(directory);
  const changedPaths = changedProjectPaths(before, after);
  const manifest = JSON.parse(before['package.json']);
  const allowedPackages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  const failures = [];
  if (!after['src/routes/order-edit.tsx']) failures.push('page artifact missing');
  if (!changedPaths.some(path => path.startsWith('src/') && sourcePattern.test(path))) {
    failures.push('no source changes');
  }
  for (const path of changedPaths) {
    if (after[path] === undefined) continue;
    if (!testPattern.test(path) && /mediator/i.test(path)) failures.push(`${path}: mediator filename`);
    if (sourcePattern.test(path)) failures.push(...inspectSource(path, after[path], allowedPackages));
  }
  return {
    pass: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    reason: failures.length === 0 ? 'Artifact checks passed; operation ownership is graded by llm-rubric'
      : [...new Set(failures)].join('; '),
  };
}

export default function assertFrontendMediator(_output, context) {
  try {
    const artifactDirectory = context?.providerResponse?.metadata?.artifactDirectory;
    if (context && !artifactDirectory) throw new Error('Provider artifact metadata missing');
    const directory = artifactDirectory ? resolve(artifactDirectory, 'project') : workDirectory;
    if (!existsSync(directory)) throw new Error('Artifact project missing');
    return inspectFrontendArtifacts(directory);
  } catch (error) {
    return { pass: false, score: 0, reason: error.message };
  }
}
