import fs, { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const root = process.env.TAKT_TEST_UPDATE_ROOT;
if (process.env.TAKT_TEST_UPDATE_FAILURE === 'save') {
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (path, ...args) => {
    if (String(path).startsWith(join(root, 'configstore')) && existsSync(join(root, 'release-fetch'))) {
      originalWrite(join(root, 'save-failed'), '');
      throw Object.assign(new Error('Test cache write denied'), { code: 'EACCES' });
    }
    return originalWrite(path, ...args);
  };
  const originalOpen = fs.openSync;
  fs.openSync = (path, flags, ...args) => {
    if (String(path).startsWith(join(root, 'configstore')) && String(flags).includes('w') && existsSync(join(root, 'release-fetch'))) {
      originalWrite(join(root, 'save-failed'), '');
      throw Object.assign(new Error('Test cache write denied'), { code: 'EACCES' });
    }
    return originalOpen(path, flags, ...args);
  };
  syncBuiltinESMExports();
}
globalThis.fetch = async () => {
  writeFileSync(join(root, 'fetch-started.json'), JSON.stringify({ pid: process.pid }));
  const deadline = Date.now() + 5000;
  while (!existsSync(join(root, 'release-fetch'))) {
    if (Date.now() >= deadline) throw new Error('Test fetch release timed out');
    await setTimeout(20);
  }
  if (process.env.TAKT_TEST_UPDATE_FAILURE === 'fetch') throw new Error('Test registry unavailable');
  return new Response(JSON.stringify({
    name: 'takt', version: '99.0.0',
    'dist-tags': { latest: '99.0.0' },
    versions: { '99.0.0': { name: 'takt', version: '99.0.0' } },
  }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
