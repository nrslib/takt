import ts from 'typescript';

const integrationBoundaryNames = new Set([
  'WorkflowEngine',
  'TeamLeaderRunner',
  'captureReviewScopeProofSnapshot',
  'createWorkflowRunLifecycle',
  'runAllTasks',
  'runCommandQualityGate',
  'spawnManagedProcess',
  'runProbeProcess',
  'runSmokeScript',
  'prepareRuntimeEnvironment',
  'resolveTask',
  'initializeGitFixture',
]);

const integrationBuiltinModules = new Set([
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:net',
]);

/**
 * @param {string} filePath
 * @param {string} sourceText
 */
export function hasIntegrationBoundary(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const importedBoundaryNames = new Set();
  const importedBuiltinModules = new Set();
  const mockedModules = new Set();
  let invokesBoundary = false;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const importClause = statement.importClause;
    if (
      integrationBuiltinModules.has(statement.moduleSpecifier.text)
      && !importClause?.isTypeOnly
    ) {
      importedBuiltinModules.add(statement.moduleSpecifier.text);
    }
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (!element.isTypeOnly && integrationBoundaryNames.has(importedName)) {
        importedBoundaryNames.add(element.name.text);
      }
    }
  }

  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && ['vi', 'jest'].includes(node.expression.expression.text)
        && node.expression.name.text === 'mock'
        && firstArgument !== undefined
        && ts.isStringLiteral(firstArgument)
      ) {
        mockedModules.add(firstArgument.text);
      }
      if (ts.isIdentifier(node.expression) && importedBoundaryNames.has(node.expression.text)) {
        invokesBoundary = true;
      }
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && importedBoundaryNames.has(node.expression.text)
    ) {
      invokesBoundary = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const importsUnmockedBuiltin = [...importedBuiltinModules]
    .some((moduleName) => !mockedModules.has(moduleName));
  return invokesBoundary || importsUnmockedBuiltin;
}
