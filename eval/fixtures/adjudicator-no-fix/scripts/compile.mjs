import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

process.stderr.write('ADJUDICATOR_EXECUTION:{"script":"build"}\n');
appendFileSync(new URL('../execution-marker.jsonl', import.meta.url), '{"script":"build"}\n');
execFileSync(process.execPath, ['--check', new URL('../src/channel.mjs', import.meta.url).pathname]);
console.log('channel build passed');
