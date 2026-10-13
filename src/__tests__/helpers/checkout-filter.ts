import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createCheckoutFilter(root: string, kind: 'smudge' | 'process') {
  const markerPath = join(root, 'filter-marker');
  const scriptPath = join(root, 'filter.cjs');
  const configPath = join(root, 'filter.gitconfig');
  writeFileSync(scriptPath, kind === 'smudge' ? `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed');
process.stdout.write(fs.readFileSync(0));
` : `
const fs = require('node:fs');
function read(size) {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(0, data, offset, size - offset, null);
    if (!count) return null;
    offset += count;
  }
  return data;
}
function group() {
  const chunks = [];
  for (;;) {
    const header = read(4);
    if (!header) return null;
    const length = parseInt(header.toString(), 16);
    if (!length) return chunks;
    const chunk = read(length - 4);
    if (!chunk) throw new Error('Incomplete filter packet');
    chunks.push(chunk);
  }
}
function send(chunks) {
  for (const chunk of chunks) {
    const data = Buffer.from(chunk);
    fs.writeSync(1, (data.length + 4).toString(16).padStart(4, '0'));
    fs.writeSync(1, data);
  }
  fs.writeSync(1, '0000');
}
group(); send(['git-filter-server\\n', 'version=2\\n']);
group(); send(['capability=clean\\n', 'capability=smudge\\n']);
while (group() !== null) {
  const content = group();
  fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed');
  send(['status=success\\n']); send(content); send([]);
}
`);
  writeFileSync(configPath, '');
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}'`;
  const configure = (key: string, value: string) => execFileSync('git', ['config', '--file', configPath, key, value]);
  configure(`filter.probe.${kind}`, command);
  configure('filter.probe.required', 'true');
  return { markerPath, configPath };
}
