import { spawnSync } from 'node:child_process';
import { markTestExecution } from './test-execution.mjs';

markTestExecution();
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status === null) throw new Error(`Test runner terminated: ${result.signal}`);
process.exitCode = result.status;
