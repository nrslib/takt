import { spawn } from 'node:child_process';

const groups = [
  ['test:it:serial:git'],
  ['test:it:serial:workflow'],
];

const passthroughArgs = process.argv.slice(2);

function runGroup(args) {
  return new Promise((resolve) => {
    const npmArgs = ['run', ...args];
    if (passthroughArgs.length > 0) {
      npmArgs.push('--', ...passthroughArgs);
    }

    const child = spawn('npm', npmArgs, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('exit', (code, signal) => {
      resolve({
        command: `npm run ${args.join(' ')}`,
        code: code ?? 1,
        signal,
      });
    });

    child.on('error', (error) => {
      console.error(`[takt] Failed to start npm run ${args.join(' ')}: ${error.message}`);
      resolve({
        command: `npm run ${args.join(' ')}`,
        code: 1,
        signal: null,
      });
    });
  });
}

const results = await Promise.all(groups.map(runGroup));
const failed = results.filter((result) => result.code !== 0);

if (failed.length > 0) {
  for (const result of failed) {
    const suffix = result.signal ? ` signal=${result.signal}` : '';
    console.error(`[takt] ${result.command} failed with exit=${result.code}${suffix}`);
  }
  process.exit(1);
}
