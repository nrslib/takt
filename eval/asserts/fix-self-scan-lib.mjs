/**
 * Shared helpers for the fix-self-scan assertions. The metrics inspect the
 * work copy the agent edited (eval/.work/fix-self-scan) for problems the
 * post-edit self-scan is supposed to catch: change-induced dead code,
 * upward layer imports, and duplicated override semantics.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../.work/fix-self-scan');
export const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/fix-self-scan');

// Strips line and block comments without corrupting string contents (a
// naive `//` regex would truncate lines at URLs inside string literals).
export function stripComments(source) {
  let out = '';
  let mode = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 1; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 1; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { mode = 'string'; quote = ch; }
      out += ch;
    } else if (mode === 'string') {
      if (ch === '\\') { out += ch + (next ?? ''); i += 1; continue; }
      if (ch === quote) mode = 'code';
      out += ch;
    } else if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; }
    } else if (ch === '*' && next === '/') { mode = 'code'; i += 1; }
  }
  return out;
}

export function listSourceFiles(root = join(workDir, 'src')) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js') || name.endsWith('.mjs')) files.push(path);
    }
  };
  walk(root);
  return files;
}

export function readSource(path) {
  return readFileSync(path, 'utf8');
}

export function relPath(path) {
  return relative(workDir, path);
}

export async function loadModule(relativePath) {
  return import(`${pathToFileURL(join(workDir, relativePath)).href}?eval=${Date.now()}`);
}

export function fail(reason) {
  return { pass: false, score: 0, reason };
}

export function pass(reason) {
  return { pass: true, score: 1, reason };
}
