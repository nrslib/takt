import { runCli } from './cli.mjs';

try {
  process.stdout.write(await runCli(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
