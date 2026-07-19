import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveNpmInvocation } from './npm-invocation.mjs';

const serialIntegrationGroups = Object.freeze([
  Object.freeze(['test:it:serial:git']),
  Object.freeze(['test:it:serial:workflow']),
]);

function buildNpmArgs(group, passthroughArgs) {
  const npmArgs = ['run', ...group];
  if (passthroughArgs.length > 0) {
    npmArgs.push('--', ...passthroughArgs);
  }
  return npmArgs;
}

function runNpmCommand(npmArgs) {
  return new Promise((resolve) => {
    const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
    const child = spawn(invocation.executable, [...invocation.args, ...npmArgs], {
      stdio: 'inherit',
      shell: false,
    });

    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
      });
    });

    child.on('error', (error) => {
      console.error(`[takt] Failed to start npm ${npmArgs.join(' ')}: ${error.message}`);
      resolve({
        code: 1,
        signal: null,
      });
    });
  });
}

export async function runSerialIntegrationGroups(passthroughArgs, runCommand = runNpmCommand) {
  const results = [];
  for (const group of serialIntegrationGroups) {
    const npmArgs = buildNpmArgs(group, passthroughArgs);
    const result = await runCommand(npmArgs);
    results.push({ npmArgs, result });
  }

  const failed = results.filter(({ result }) => result.code !== 0);
  for (const { npmArgs, result } of failed) {
    const suffix = result.signal ? ` signal=${result.signal}` : '';
    console.error(`[takt] npm ${npmArgs.join(' ')} failed with exit=${result.code}${suffix}`);
  }

  return failed[0]?.result.code ?? 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await runSerialIntegrationGroups(process.argv.slice(2));
  process.exit(code);
}
