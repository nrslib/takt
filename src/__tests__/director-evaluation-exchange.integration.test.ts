import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { createDirectorEvaluationExchange } from './helpers/director-evaluation-exchange.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function respond(directory: string, text: string) {
  const path = join(directory, '0001.response.json');
  await writeFile(`${path}.tmp`, JSON.stringify({ kind: 'final', text }));
  await rename(`${path}.tmp`, path);
}

it('uses only the current run response when the same parent contains old responses', async () => {
  const parent = await mkdtemp(join(getGlobalConfigDir(), 'evaluation-')); directories.push(parent);
  const old = JSON.stringify({ kind: 'final', text: 'old response' });
  await writeFile(join(parent, '0001.response.json'), old);
  const previous = await createDirectorEvaluationExchange(parent);
  await writeFile(join(previous.directory, '0001.response.json'), old);
  const current = await createDirectorEvaluationExchange(parent);
  expect(current.directory).not.toBe(previous.directory);
  const pending = current.request({ prompt: 'current input' }, new AbortController().signal);
  await vi.waitFor(() => expect(existsSync(join(current.directory, '0001.input.json'))).toBe(true));
  await respond(current.directory, 'current choice');
  expect(await pending).toMatchObject({ input: { prompt: 'current input', id: '0001' }, decision: { kind: 'final', text: 'current choice' } });
  expect(await readFile(join(parent, '0001.response.json'), 'utf8')).toBe(old);
  expect(await readFile(join(previous.directory, '0001.response.json'), 'utf8')).toBe(old);
});

it('keeps two concurrent runs separate even when both start at 0001', async () => {
  const parent = await mkdtemp(join(getGlobalConfigDir(), 'evaluation-')); directories.push(parent);
  const first = await createDirectorEvaluationExchange(parent); const second = await createDirectorEvaluationExchange(parent);
  const controller = new AbortController();
  const one = first.request({ prompt: 'first' }, new AbortController().signal);
  const two = second.request({ prompt: 'second' }, controller.signal);
  const rejected = expect(two).rejects.toThrow();
  await vi.waitFor(() => expect(existsSync(join(second.directory, '0001.input.json'))).toBe(true));
  await respond(first.directory, 'first choice');
  expect((await one).decision).toEqual({ kind: 'final', text: 'first choice' });
  controller.abort(); await rejected;
  expect(existsSync(join(second.directory, '0001.response.json'))).toBe(false);
});
