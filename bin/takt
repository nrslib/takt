#!/usr/bin/env node

/**
 * TAKT CLI wrapper for npm global/local installation
 *
 * This wrapper script ensures takt can be run via:
 * - npm install -g takt && takt
 * - npx takt
 * - npm exec takt
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the actual CLI from dist
const cliPath = join(__dirname, '..', 'dist', 'app', 'cli', 'index.js');

try {
  const cliUrl = pathToFileURL(cliPath).href;
  await import(cliUrl);
} catch (err) {
  console.error('Failed to load TAKT CLI. Have you run "npm run build"?');
  console.error(err.message);
  process.exit(1);
}
