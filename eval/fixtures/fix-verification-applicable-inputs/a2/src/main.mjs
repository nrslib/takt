import { runCli } from './cli.mjs';

try {
  process.stdout.write(runCli(process.argv.slice(2), process.env, process.cwd()));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
