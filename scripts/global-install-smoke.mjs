#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.argv[2];
assert.ok(packageRoot, 'Pass the globally installed TAKT package directory');
const cli = realpathSync(join(packageRoot, 'bin/takt'));
const installedRoot = dirname(dirname(cli));
const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'takt');
const installedRequire = createRequire(cli);
await import(pathToFileURL(installedRequire.resolve('@modelcontextprotocol/sdk/client')).href);
const { AjvJsonSchemaValidator } = await import(
  pathToFileURL(installedRequire.resolve('@modelcontextprotocol/sdk/validation/ajv')).href
);
const validate = new AjvJsonSchemaValidator().getValidator({ type: 'string' });
assert.equal(validate('installed').valid, true);
assert.equal(validate(123).valid, false);

const temporaryRoot = mkdtempSync(join(tmpdir(), 'takt-global-smoke-'));
try {
  const project = join(temporaryRoot, 'project');
  const config = join(temporaryRoot, 'config');
  mkdirSync(project);
  mkdirSync(config);
  writeFileSync(join(config, 'config.yaml'), 'language: en\n');
  const options = {
    cwd: project,
    env: { ...process.env, TAKT_CONFIG_DIR: config, TAKT_NO_TTY: '1', NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  };
  const version = execFileSync(process.execPath, [cli, '--version'], options);
  assert.equal(version.trim(), manifest.version);
  execFileSync(process.execPath, [cli, '--help'], options);
  // Enter the normal startup path; --version and --help skip its lazy imports.
  const startup = execFileSync(process.execPath, [cli], { ...options, input: '/cancel\n' });
  process.stdout.write(startup);
  assert.match(startup, /cancelled/i);
  console.log(`Global TAKT ${manifest.version}: startup and MCP/AJV validation passed`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
