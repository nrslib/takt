#!/usr/bin/env node

/**
 * devloopd CLI wrapper for npm global/local installation.
 *
 * devloopd is packaged beside takt so subscription-only local readiness checks
 * can run before invoking workflow execution.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '..', 'dist', 'app', 'devloopd', 'index.js');

try {
  const cliUrl = pathToFileURL(cliPath).href;
  await import(cliUrl);
} catch (err) {
  console.error('Failed to load devloopd CLI. Have you run "npm run build"?');
  console.error(err.message);
  process.exit(1);
}
