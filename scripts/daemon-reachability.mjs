import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const excludedEntry = /(?:^|\/)(?:__tests__|fixtures|node_modules|dist)(?:\/|$)|\.d\.[cm]?ts$/;
const forbiddenOwnDependency = /(?:^|\/)(?:__tests__|fixtures|dist)(?:\/|$)/;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (excludedEntry.test(path.replaceAll('\\', '/'))) return [];
    return entry.isDirectory() ? sourceFiles(path) : sourceExtension.test(path) ? [path] : [];
  }));
  return groups.flat();
}

/** C が実装する唯一のターン子入口。値 import の除外には使わない。 */
export const daemonProcessBoundaries = Object.freeze([
  Object.freeze({ entry: 'src/app/daemon-turn/index.ts', owner: 'C', protocol: 'src/core/daemon/processProtocol.ts' }),
]);

/** 起動・利用側の lifecycle/readiness/client は、値依存から到達した場合だけ含む。 */
export async function daemonEntries(root) {
  return (await sourceFiles(join(root, 'src'))).filter((file) => {
    const path = relative(root, file).replaceAll('\\', '/');
    return path.startsWith('src/app/daemon/') || path.startsWith('src/core/daemon/')
      || path.startsWith('src/infra/daemon/')
      || path.startsWith('src/features/daemon/') && !/(?:^|\/)(lifecycle|conversationReadiness|conversationIpcClient)\.[cm]?[jt]s$/.test(path);
  });
}

/** 値 import、再 export、literal dynamic import、自前 worker entry を推移的に追う。 */
export async function daemonReachability({ root, entries }) {
  const compilerOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext, allowJs: true, resolveJsonModule: true };
  const files = new Set();
  const issues = [];
  const boundaries = [];
  const pending = entries.map((entry) => resolve(root, entry));
  const addIssue = (file, node, source, message) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    issues.push({ file: relative(root, file).replaceAll('\\', '/'), line: line + 1, column: character + 1, message });
  };
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file) || /\.d\.[cm]?ts$/.test(file)) continue;
    if (!existsSync(file)) throw new Error(`Missing daemon entry: ${file}`);
    if (!sourceExtension.test(file)) continue;
    files.add(file);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const follow = (specifier, node) => {
      const resolvedModule = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule;
      if (resolvedModule !== undefined && !resolvedModule.isExternalLibraryImport) {
        const dependency = relative(root, resolvedModule.resolvedFileName).replaceAll('\\', '/');
        if (forbiddenOwnDependency.test(dependency)) addIssue(file, node, source, `Forbidden own value dependency: ${dependency}`);
        else pending.push(resolvedModule.resolvedFileName);
      } else if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('#')) {
        addIssue(file, node, source, `Unresolved own module: ${specifier}`);
      }
    };
    const literal = (node) => node !== undefined && ts.isStringLiteralLike(node);
    const entrySpecifier = (node) => {
      if (literal(node)) return node.text;
      if (node !== undefined && ts.isCallExpression(node) && node.expression.getText(source) === 'fileURLToPath') return entrySpecifier(node.arguments[0]);
      if (node !== undefined && ts.isNewExpression(node) && node.expression.getText(source) === 'URL'
        && literal(node.arguments?.[0]) && node.arguments?.[1]?.getText(source) === 'import.meta.url') return node.arguments[0].text;
      return undefined;
    };
    const executionNames = new Set(['Worker', 'fork']);
    const workerNames = new Set(['Worker']);
    const nodeLaunchNames = new Set(['spawnManagedProcess', 'crossSpawn', 'execFileSyncRuntime', 'runBoundedCommand']);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !/^(node:)?(worker_threads|child_process)$/.test(statement.moduleSpecifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          const original = binding.propertyName?.text ?? binding.name.text;
          if (original === 'Worker') workerNames.add(binding.name.text);
          if (['Worker', 'fork'].includes(original)) executionNames.add(binding.name.text);
          if (/^(spawn|execFile)(Sync)?$/.test(original)) nodeLaunchNames.add(binding.name.text);
        }
      }
    }
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const typeOnly = clause?.isTypeOnly || (clause?.name === undefined && bindings !== undefined
          && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly));
        if (!typeOnly) follow(node.moduleSpecifier.text, node);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && !node.isTypeOnly) {
        if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)
          || node.exportClause.elements.length === 0 || node.exportClause.elements.some((entry) => !entry.isTypeOnly)) follow(node.moduleSpecifier.text, node);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        if (literal(node.moduleReference.expression)) follow(node.moduleReference.expression.text, node);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (literal(node.arguments[0])) follow(node.arguments[0].text, node);
        else addIssue(file, node, source, 'Non-literal dynamic import');
      } else if (ts.isCallExpression(node) && node.expression.getText(source) === 'require' && literal(node.arguments[0])) {
        follow(node.arguments[0].text, node);
      }
      const expression = (ts.isNewExpression(node) || ts.isCallExpression(node)) ? node.expression.getText(source) : '';
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isIdentifier(node.name)
        && executionNames.has(node.initializer.getText(source))) {
        executionNames.add(node.name.text);
        if (workerNames.has(node.initializer.getText(source))) workerNames.add(node.name.text);
      }
      const processBoundary = (entryNode) => {
        const specifier = entrySpecifier(entryNode);
        if (specifier === undefined || literal(entryNode) && !isAbsolute(specifier)) return false;
        const entry = relative(root, resolve(dirname(file), specifier)).replaceAll('\\', '/').replace(/\.[cm]?js$/, '.ts');
        const declaration = daemonProcessBoundaries.find((boundary) => boundary.entry === entry);
        if (declaration === undefined) return false;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        boundaries.push({ ...declaration, file: relative(root, file).replaceAll('\\', '/'), line: line + 1 });
        return true;
      };
      if (executionNames.has(expression) || /\.(?:Worker|fork)$/.test(expression)) {
        const specifier = entrySpecifier(node.arguments?.[0]);
        if (specifier === undefined || !sourceExtension.test(specifier)) addIssue(file, node, source, 'Unknown own execution entry');
        else if (workerNames.has(expression) || /\.Worker$/.test(expression) || !processBoundary(node.arguments?.[0])) follow(specifier, node);
      }
      if (ts.isCallExpression(node) && (nodeLaunchNames.has(expression) || /\.(spawn|execFile)(Sync)?$/.test(expression))) {
        const executable = node.arguments[0];
        if (executable?.getText(source) === 'process.execPath' || literal(executable) && /^(node|node.exe)$/.test(executable.text)) {
          const args = node.arguments[1];
          const entryNode = args !== undefined && ts.isArrayLiteralExpression(args) ? args.elements[0] : undefined;
          if (!processBoundary(entryNode)) addIssue(file, node, source, 'Unknown own execution entry (Node subprocess boundary)');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: [...files].map((file) => relative(root, file).replaceAll('\\', '/')).sort(), issues, boundaries };
}

/** 現段階では棚卸しのみ。--check を明示したときだけ禁止箇所で失敗する。 */
async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
  const [{ ESLint }, tseslint, { daemonRules }] = await Promise.all([import('eslint'), import('typescript-eslint'), import('./daemon-lint-rules.mjs')]);
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { parser: tseslint.default.parser },
    plugins: { '@typescript-eslint': tseslint.default.plugin }, rules: daemonRules,
  }] });
  const results = await eslint.lintFiles(graph.files);
  const violations = results.filter((result) => result.messages.length > 0).map((result) => ({
    file: relative(root, result.filePath).replaceAll('\\', '/'),
    count: result.messages.length,
    messages: result.messages.map(({ line, column, ruleId, message }) => ({ line, column, ruleId, message })),
  }));
  const report = { reachableFiles: graph.files.length, files: graph.files, violations, issues: graph.issues, declaredProcessBoundaries: daemonProcessBoundaries, boundaries: graph.boundaries };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Reachable files: ${graph.files.length}`);
    for (const { file, count } of violations) console.log(`${file}\t${count}`);
    for (const issue of graph.issues) console.log(`${issue.file}:${issue.line}\t${issue.message}`);
  }
  if (process.argv.includes('--check') && (violations.length > 0 || graph.issues.length > 0)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
