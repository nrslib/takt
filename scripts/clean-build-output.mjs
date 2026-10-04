#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export function cleanBuildOutput(projectRoot) {
  rmSync(join(projectRoot, 'dist'), { recursive: true, force: true });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  cleanBuildOutput(resolve(dirname(scriptPath), '..'));
}
