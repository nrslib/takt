import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');

function resolveLocalModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const unresolved = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [unresolved.slice(0, -3) + '.ts', unresolved.slice(0, -3) + '.tsx']
    : [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, resolve(unresolved, 'index.ts')];

  return candidates.find((candidate) => existsSync(candidate));
}

function isRuntimeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  if (!ts.isNamedImports(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function staticRuntimeImports(modulePath: string): string[] {
  const source = readFileSync(modulePath, 'utf-8');
  const sourceFile = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && isRuntimeImport(statement)) {
      const specifier = statement.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) imports.push(specifier.text);
    }
    if (
      ts.isExportDeclaration(statement)
      && !statement.isTypeOnly
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push(statement.moduleSpecifier.text);
    }
  }

  return imports;
}

function dynamicImports(modulePath: string): string[] {
  const source = readFileSync(modulePath, 'utf-8');
  const sourceFile = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function collectStaticRuntimeDependencies(entry: string): string[] {
  const pending = [resolve(sourceRoot, entry)];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || visited.has(modulePath)) continue;
    visited.add(modulePath);

    for (const specifier of staticRuntimeImports(modulePath)) {
      const dependency = resolveLocalModule(modulePath, specifier);
      if (dependency !== undefined && dependency.startsWith(sourceRoot)) pending.push(dependency);
    }
  }

  return [...visited]
    .map((modulePath) => relative(sourceRoot, modulePath).replaceAll('\\', '/'))
    .sort();
}

describe('CLI lazy-loading boundary', () => {
  it.each([
    'app/cli/index.ts',
    'app/cli/program.ts',
    'app/cli/commands.ts',
  ])('should keep heavy execution modules outside the static graph of %s', (entry) => {
    const dependencies = collectStaticRuntimeDependencies(entry);
    const forbiddenDependencies = dependencies.filter((dependency) => (
      dependency.startsWith('features/tasks/')
      || dependency.startsWith('features/pipeline/')
      || dependency.startsWith('features/interactive/')
      || dependency.startsWith('core/workflow/engine/')
      || dependency.startsWith('infra/providers/')
      || /^infra\/(claude|claude-headless|claude-terminal|codex|copilot|cursor|kiro|opencode)\//.test(dependency)
      || dependency === 'infra/git/index.ts'
      || dependency === 'app/cli/routing.ts'
      || dependency === 'app/cli/opencodeExitCleanup.ts'
      || dependency === 'shared/utils/updateNotifier.ts'
      || dependency === 'shared/utils/updateNotifierWorker.ts'
    ));

    expect(
      forbiddenDependencies,
      `Static graph from ${entry} reached: ${forbiddenDependencies.slice(0, 12).join(', ')}`,
    ).toHaveLength(0);
  });

  it('should keep command implementations outside the static graph of commands.ts', () => {
    const dependencies = collectStaticRuntimeDependencies('app/cli/commands.ts');
    const eagerImplementations = dependencies.filter((dependency) => (
      (dependency.startsWith('features/') && dependency !== 'features/config/facetTypes.ts')
      || dependency.startsWith('commands/repertoire/')
      || dependency.startsWith('infra/config/')
      || dependency.startsWith('shared/ui/')
    ));

    expect(
      eagerImplementations,
      `Command definitions eagerly reached: ${eagerImplementations.slice(0, 12).join(', ')}`,
    ).toHaveLength(0);
  });

  it('should import direct command implementations instead of feature barrels', () => {
    const imports = dynamicImports(resolve(sourceRoot, 'app/cli/commands.ts'));
    const featureBarrels = [
      '../../features/tasks/index.js',
      '../../features/config/index.js',
      '../../features/prompt/index.js',
      '../../features/catalog/index.js',
      '../../features/analytics/index.js',
      '../../features/workflowAuthoring/index.js',
      '../../features/exec/index.js',
    ];

    for (const featureBarrel of featureBarrels) {
      expect(imports).not.toContain(featureBarrel);
    }

    expect(imports).toEqual(expect.arrayContaining([
      './initialization.js',
      '../../features/tasks/execute/runAllTasks.js',
      '../../features/tasks/watch/index.js',
      '../../features/tasks/add/index.js',
      '../../features/tasks/list/index.js',
      '../../features/tasks/resume/index.js',
      '../../features/exec/command.js',
      '../../features/config/ejectBuiltin.js',
      '../../features/config/resetConfig.js',
      '../../features/config/resetCategories.js',
      '../../features/config/deploySkill.js',
      '../../features/config/deploySkillCodex.js',
      '../../features/prompt/preview.js',
      '../../features/catalog/catalogFacets.js',
      '../../features/workflowAuthoring/init.js',
      '../../features/workflowAuthoring/doctor.js',
      '../../features/analytics/metrics.js',
      '../../features/analytics/purge.js',
      '../../commands/repertoire/add.js',
      '../../commands/repertoire/remove.js',
      '../../commands/repertoire/list.js',
    ]));
  });
});
