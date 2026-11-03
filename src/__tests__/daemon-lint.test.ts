import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { daemonRules } from '../../scripts/daemon-lint-rules.mjs';

const linter = new Linter();
function lint(code: string) {
  return linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: daemonRules,
  }], { filename: 'daemon.ts' });
}

describe('daemon lint prohibition rules', () => {
  it.each([
    "import { spawnSync } from 'node:child_process'; spawnSync('git');",
    "import { execFileSync as execute } from 'child_process'; execute('git');",
    "import { execSync } from 'child_process'; execSync('git');",
    "import { readFileSync as read } from 'node:fs'; read('file');",
    "import { existsSync, writeFileSync } from 'fs';",
    "import fs from 'node:fs'; fs.readFileSync('file');",
    "import * as cp from 'child_process'; const run = cp.spawnSync;",
    "import * as fs from 'fs'; fs['readFileSync']('file');",
    "export { default as filesystem } from 'node:fs';",
    "import filesystem = require('node:fs');",
    'const directory = await opendir(path); directory.readSync();',
    "const directory = await opendir(path); directory['closeSync']();",
    'const { readSync } = await opendir(path);',
    'Atomics.wait(new Int32Array(), 0, 0);',
    'const { wait } = Atomics;',
    "const blocking = globalThis['Atomics'];",
    "import { createRequire as load } from 'node:module';",
    "import * as mod from 'module'; mod.createRequire(import.meta.url);",
    "const load = require; load('node:fs');",
    "module.require('fs');",
    "globalThis['require']('fs');",
    "process.getBuiltinModule('fs');",
    "process['getBuiltinModule']('fs');",
    'const { getBuiltinModule: load } = process;',
    "export { readFileSync as read } from 'fs';",
    "export { spawnSync } from 'node:child_process';",
    "export { createRequire as load } from 'module';",
    "export * from 'node:fs';",
    "export * as filesystem from 'fs';",
    "await import('node:fs');",
    "await import('child_process');",
    'await import(variable);',
    "import { runInNewContext } from 'node:vm';",
    'const compile = Function;',
    'eval(code);',
  ])('rejects blocking APIs and loading escape hatches: %s', (code) => {
    const messages = lint(code);
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.severity === 2).length).toBeGreaterThan(0);
  });

  it.each([
    "import { readFile, writeFile } from 'node:fs/promises'; await readFile('file');",
    "import * as fs from 'fs/promises'; await fs.readFile('file');",
    "const fs = await import('node:fs/promises'); await fs.writeFile('file', 'text');",
    "import { promises as fs } from 'node:fs'; await fs.readFile('file');",
    "import { spawn, execFile } from 'node:child_process'; spawn('git', []);",
    "import type { SpawnSyncReturns } from 'node:child_process';",
    "import type * as fs from 'node:fs';",
    "export type { SpawnSyncReturns } from 'node:child_process';",
    "await import('./async-helper.js');",
  ])('allows async operations and type-only references: %s', (code) => {
    expect(lint(code)).toEqual([]);
  });
});
