import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectManagedProvider, installManagedSdk } from '../infra/managed-providers/package.js';
import { loadManagedSdk } from '../infra/managed-providers/loader.js';

const readFailure = vi.hoisted(() => ({ enabled: false, closed: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (readFailure.enabled && String(args[0]).endsWith('/claude') && args[1] === 'r') {
        vi.spyOn(file, 'read').mockRejectedValue(new Error('Injected read failure'));
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => { readFailure.closed(); await close(); });
      }
      return file;
    },
  };
});

let directory: string;
let binary: string;
let npm: string;
beforeEach(async () => {
  readFailure.enabled = false;
  readFailure.closed.mockClear();
  directory = await mkdtemp(join(process.cwd(), '.managed-integrity-'));
  binary = join(directory, 'binary');
  npm = join(directory, 'npm.cjs');
  vi.stubEnv('TAKT_CONFIG_DIR', join(directory, 'config'));
  vi.stubEnv('TAKT_TEST_INTEGRITY_BINARY', binary);
  await writeFile(npm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = '@anthropic-ai/claude-agent-sdk';
const sdk = path.join('node_modules', name);
fs.mkdirSync(sdk, { recursive: true });
fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name, version: manifest.dependencies[name], type: 'module', exports: './index.js' }));
fs.writeFileSync(path.join(sdk, 'index.js'), 'export function query() {}\\nexport class AbortError extends Error {}\\n');
const suffix = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : '';
const native = path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk-' + process.platform + '-' + process.arch + suffix);
fs.mkdirSync(native, { recursive: true });
fs.copyFileSync(process.env.TAKT_TEST_INTEGRITY_BINARY, path.join(native, process.platform === 'win32' ? 'claude.exe' : 'claude'));
`, { mode: 0o755 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function writeBinary(size: number): Promise<string> {
  const chunk = Buffer.alloc(64 * 1024, 0x5a);
  const digest = createHash('sha256');
  const file = await open(binary, 'w');
  try {
    for (let written = 0; written < size;) {
      const bytes = chunk.subarray(0, Math.min(chunk.length, size - written));
      await file.write(bytes);
      digest.update(bytes);
      written += bytes.length;
    }
  } finally { await file.close(); }
  return digest.digest('hex');
}

async function installedBinary(): Promise<{ directory: string; path: string }> {
  const inspected = await inspectManagedProvider('claude-sdk');
  expect(inspected.state).toBe('ready');
  const marker = JSON.parse(await readFile(join(inspected.directory!, '.ready.json'), 'utf8')) as { files: Record<string, string> };
  const name = Object.keys(marker.files).find((name) => /\/claude(?:\.exe)?$/u.test(name));
  expect(name).toBeDefined();
  return { directory: inspected.directory!, path: join(inspected.directory!, name!) };
}

interface Measurement { peakBuffers: number; maxRss: number; state: string; sha256?: string; repeatedBinaryBytes?: number }
async function measure(mode: 'buffer' | 'inspect', path: string): Promise<Measurement> {
  const script = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
const { inspectManagedProvider } = await import(${JSON.stringify(fileURLToPath(new URL('../infra/managed-providers/package.ts', import.meta.url)))});
const targetBinary = ${JSON.stringify(path)};
global.gc();
const baseline = process.memoryUsage().arrayBuffers;
let peakBuffers = 0;
let binaryBytesRead = 0;
const sample = () => { peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers - baseline); };
const read = fs.readFile;
fs.readFile = async (...args) => { const result = await read(...args); sample(); return result; };
const open = fs.open;
fs.open = async (...args) => {
  const isTargetBinary = String(args[0]) === targetBinary;
  const file = await open(...args);
  const read = file.read.bind(file);
  file.read = async (...readArgs) => {
    const result = await read(...readArgs);
    if (isTargetBinary) binaryBytesRead += result.bytesRead;
    sample();
    return result;
  };
  return file;
};
syncBuiltinESMExports();
let state = 'ready', sha256, repeatedBinaryBytes;
if (${JSON.stringify(mode)} === 'buffer') sha256 = createHash('sha256').update(await fs.readFile(${JSON.stringify(path)})).digest('hex');
else {
  state = (await inspectManagedProvider('claude-sdk')).state;
  const firstInspectionBytes = binaryBytesRead;
  state = (await inspectManagedProvider('claude-sdk')).state;
  repeatedBinaryBytes = binaryBytesRead - firstInspectionBytes;
}
sample();
console.log(JSON.stringify({ peakBuffers, maxRss: process.resourceUsage().maxRSS, state, sha256, repeatedBinaryBytes }));
`;
  const child = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { error += data.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  expect(code, error).toBe(0);
  return JSON.parse(output.trim()) as Measurement;
}

describe('managed provider binary integrity', () => {
  it.each([0, 65535, 65536, 65537])('preserves SHA-256 at the %i byte boundary and rejects changed content after mtime restoration', async (size) => {
    const expected = await writeBinary(size);
    await installManagedSdk('claude-sdk', { npmPath: npm });
    const installed = await installedBinary();
    const marker = JSON.parse(await readFile(join(installed.directory, '.ready.json'), 'utf8')) as { files: Record<string, string> };
    expect(marker.files[relative(installed.directory, installed.path)]).toBe(expected);
    expect(typeof (await loadManagedSdk('claude-sdk')).modules[0].query).toBe('function');
    const restoredMtime = new Date('2020-01-01T00:00:00.000Z');
    await utimes(installed.path, restoredMtime, restoredMtime);
    expect((await inspectManagedProvider('claude-sdk')).state).toBe('ready');
    const file = await open(installed.path, 'r+');
    try { await file.write(Buffer.from([0x5b]), 0, 1, Math.max(0, size - 1)); } finally { await file.close(); }
    await utimes(installed.path, restoredMtime, restoredMtime);
    expect((await inspectManagedProvider('claude-sdk')).state).toBe('missing');
    await expect(loadManagedSdk('claude-sdk')).rejects.toThrow('takt install claude-sdk');
  });

  it('closes a failed read and preserves the published generation', async () => {
    await writeBinary(65537);
    await installManagedSdk('claude-sdk', { npmPath: npm });
    const installed = await installedBinary();
    readFailure.enabled = true;
    await expect(installManagedSdk('claude-sdk', { npmPath: npm, force: true })).rejects.toThrow('Injected read failure');
    expect(readFailure.closed).toHaveBeenCalled();
    readFailure.enabled = false;
    expect((await inspectManagedProvider('claude-sdk')).directory).toBe(installed.directory);
    expect((await inspectManagedProvider('claude-sdk')).state).toBe('ready');
  });

  it('preserves the publication error when the current generation cannot be resolved during cleanup', async () => {
    await writeBinary(65537);
    const current = join(directory, 'config', 'claude-sdk', 'sdk');
    await mkdir(current, { recursive: true });

    let installError: unknown;
    try {
      await installManagedSdk('claude-sdk', { npmPath: npm, force: true });
    } catch (caught) {
      installError = caught;
    }

    expect(installError).toBeInstanceOf(Error);
    expect((installError as Error).message).not.toBe('Managed current generation is not a link.');
    expect((await stat(current)).isDirectory()).toBe(true);
    expect((await readdir(join(directory, 'config', 'claude-sdk'))).filter((name) => /^sdk-/u.test(name))).toHaveLength(0);
  });

  it('bounds binary retention for 32 MiB and 256 MiB while the former whole-buffer method grows', async () => {
    const results: Array<{ size: number; buffer: Measurement; inspect: Measurement }> = [];
    for (const size of [32, 256]) {
      const expected = await writeBinary(size * 1024 * 1024);
      await installManagedSdk('claude-sdk', { npmPath: npm, force: true });
      const installed = await installedBinary();
      const marker = JSON.parse(await readFile(join(installed.directory, '.ready.json'), 'utf8')) as { files: Record<string, string> };
      expect(marker.files[relative(installed.directory, installed.path)]).toBe(expected);
      const buffer = await measure('buffer', installed.path);
      const inspect = await measure('inspect', installed.path);
      expect(buffer.sha256).toBe(expected);
      expect(inspect.state).toBe('ready');
      expect(inspect.repeatedBinaryBytes).toBe(size * 1024 * 1024);
      expect(inspect.peakBuffers).toBeLessThan(8 * 1024 * 1024);
      results.push({ size, buffer, inspect });
    }
    expect(results[1]!.buffer.peakBuffers - results[0]!.buffer.peakBuffers).toBeGreaterThan(200 * 1024 * 1024);
    expect(Math.abs(results[1]!.inspect.peakBuffers - results[0]!.inspect.peakBuffers)).toBeLessThan(4 * 1024 * 1024);
    expect(results[1]!.buffer.maxRss - results[0]!.buffer.maxRss).toBeGreaterThan(128 * 1024);
    expect(Math.abs(results[1]!.inspect.maxRss - results[0]!.inspect.maxRss)).toBeLessThan(32 * 1024);
    console.log('managed binary memory measurements', JSON.stringify(results));
  }, 60_000);
});
