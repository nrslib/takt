import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(evalDir, '.work', 'implement-contract-traceability');
const MAX_CANDIDATE_SOURCE_BYTES = 20_000;

function readCandidateSource(candidateDir) {
  const sourcePath = join(candidateDir, 'src', 'session-label.js');
  let descriptor;
  try {
    const canonicalRoot = realpathSync(candidateDir);
    const canonicalSource = realpathSync(sourcePath);
    const sourceRelativePath = relative(canonicalRoot, canonicalSource);
    const sourceLstat = lstatSync(sourcePath);
    if (
      sourceRelativePath === ''
      || sourceRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || sourceRelativePath === '..'
      || isAbsolute(sourceRelativePath)
      || !sourceLstat.isFile()
      || sourceLstat.isSymbolicLink()
      || sourceLstat.size > MAX_CANDIDATE_SOURCE_BYTES
    ) {
      return undefined;
    }
    descriptor = openSync(canonicalSource, 'r');
    const openedStat = fstatSync(descriptor);
    const pathStat = statSync(canonicalSource);
    if (
      !openedStat.isFile()
      || openedStat.size > MAX_CANDIDATE_SOURCE_BYTES
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
    ) {
      return undefined;
    }
    return readFileSync(descriptor, 'utf8');
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isExported(node) {
  return node.modifiers?.length === 1
    && node.modifiers[0]?.kind === ts.SyntaxKind.ExportKeyword;
}

function isStringTypeGuard(expression, parameterName) {
  if (!ts.isBinaryExpression(expression)) return false;
  if (
    expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    && expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return false;
  }
  const pairs = [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ];
  return pairs.some(([typeExpression, stringExpression]) => (
    ts.isTypeOfExpression(typeExpression)
    && ts.isIdentifier(typeExpression.expression)
    && typeExpression.expression.text === parameterName
    && ts.isStringLiteral(stringExpression)
    && stringExpression.text === 'string'
  ));
}

function isTypeErrorThrow(statement) {
  const throwStatement = ts.isBlock(statement)
    && statement.statements.length === 1
    ? statement.statements[0]
    : statement;
  return throwStatement !== undefined
    && ts.isThrowStatement(throwStatement)
    && throwStatement.expression !== undefined
    && ts.isNewExpression(throwStatement.expression)
    && ts.isIdentifier(throwStatement.expression.expression)
    && throwStatement.expression.expression.text === 'TypeError'
    && (throwStatement.expression.arguments?.every(ts.isStringLiteral) ?? true);
}

function isTrimReturn(statement, parameterName) {
  if (!ts.isReturnStatement(statement) || statement.expression === undefined) return false;
  const expression = statement.expression;
  return ts.isCallExpression(expression)
    && expression.arguments.length === 0
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === parameterName
    && expression.expression.name.text === 'trim';
}

function hasObservableNormalizationBehavior(source) {
  const sourceFile = ts.createSourceFile(
    'session-label.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0 || sourceFile.statements.length !== 1) {
    return false;
  }
  const declaration = sourceFile.statements[0];
  if (
    !ts.isFunctionDeclaration(declaration)
    || !isExported(declaration)
    || declaration.name?.text !== 'normalizeSessionLabel'
    || declaration.parameters.length !== 1
    || declaration.body === undefined
    || declaration.asteriskToken !== undefined
  ) {
    return false;
  }
  const parameter = declaration.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) {
    return false;
  }
  const [guard, result] = declaration.body.statements;
  return declaration.body.statements.length === 2
    && guard !== undefined
    && ts.isIfStatement(guard)
    && guard.elseStatement === undefined
    && isStringTypeGuard(guard.expression, parameter.name.text)
    && isTypeErrorThrow(guard.thenStatement)
    && result !== undefined
    && isTrimReturn(result, parameter.name.text);
}

function usesCaseNormalization(source) {
  const sourceFile = ts.createSourceFile(
    'session-label.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let found = false;
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'toLowerCase' || node.expression.name.text === 'toUpperCase')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

export function assertImplementContractTraceabilityIn(candidateDir) {
  const source = readCandidateSource(candidateDir);
  const observableBehavior = source !== undefined && hasObservableNormalizationBehavior(source);
  const avoidsCaseNormalization = source !== undefined && !usesCaseNormalization(source);
  const checks = [observableBehavior, avoidsCaseNormalization];
  const names = ['observable-normalization-behavior', 'case-preservation-implementation'];
  const failed = names.filter((_, index) => !checks[index]);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'The implementation satisfies the observable normalization behavior.'
      : `Failed checks: ${failed.join(', ')}`,
  };
}

export default function assertImplementContractTraceability() {
  return assertImplementContractTraceabilityIn(workDir);
}
