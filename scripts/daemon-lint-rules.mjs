import * as fs from 'node:fs';

const syncFs = Object.keys(fs).filter((name) => name.endsWith('Sync'));
const syncProcess = ['spawnSync', 'execFileSync', 'execSync'];
const modulePattern = '/^(node:)?(fs|child_process|module)$/';

/** 同じ規則を ESLint の opt-in override と棚卸し・規則テストが使う。 */
export const daemonRules = {
  '@typescript-eslint/no-restricted-imports': ['error', {
    paths: [
      ...['fs', 'node:fs'].map((name) => ({ name, importNames: syncFs, allowTypeImports: true, message: 'Use node:fs/promises in daemon code.' })),
      ...['child_process', 'node:child_process'].map((name) => ({ name, importNames: syncProcess, allowTypeImports: true, message: 'Use asynchronous spawn in daemon code.' })),
      ...['module', 'node:module'].map((name) => ({ name, importNames: ['createRequire'], allowTypeImports: true })),
    ],
    patterns: [{ group: ['vm', 'node:vm'], allowTypeImports: true }],
  }],
  'no-restricted-syntax': ['error',
    ...['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].map((kind) => ({
      selector: `ImportDeclaration[importKind!='type'][source.value=${modulePattern}] > ${kind}`,
      message: 'Use named asynchronous imports in daemon code.',
    })),
    { selector: `ExportAllDeclaration[exportKind!='type'][source.value=${modulePattern}]`, message: 'Do not re-export builtin namespaces.' },
    { selector: `ExportNamedDeclaration[exportKind!='type'][source.value=${modulePattern}] > ExportSpecifier[exportKind!='type'][local.name=/Sync$|^createRequire$|^default$/]`, message: 'Do not re-export synchronous builtins or createRequire.' },
    { selector: 'TSImportEqualsDeclaration[importKind!="type"]', message: 'Use ESM value imports in daemon code.' },
    { selector: 'MemberExpression[computed=false][property.name=/Sync$/], MemberExpression[computed=true][property.value=/Sync$/], Property[key.name=/Sync$/]', message: 'Synchronous methods are forbidden in daemon code.' },
    { selector: 'ImportExpression[source.value=/^(node:)?(fs|child_process|module|vm)$/]', message: 'Dynamic builtin namespaces bypass daemon import restrictions.' },
    { selector: 'ImportExpression:not([source.type="Literal"])', message: 'Daemon dynamic imports must have a literal specifier.' },
    { selector: 'Identifier[name=/^(Atomics|require|createRequire|eval|Function)$/]', message: 'Blocking primitives and dynamic loading escape hatches are forbidden in daemon code.' },
    { selector: 'MemberExpression[computed=true][property.value=/^(Atomics|require|createRequire|getBuiltinModule|eval|Function)$/]', message: 'Dynamic loading escape hatches are forbidden in daemon code.' },
    { selector: 'MemberExpression[computed=false][property.name="getBuiltinModule"]', message: 'Do not bypass builtin import restrictions.' },
    { selector: 'Property[key.name="getBuiltinModule"], Property[key.value="getBuiltinModule"]', message: 'Do not alias getBuiltinModule.' },
  ],
};
