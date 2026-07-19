import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);

if (args.outcome === undefined) {
  throw new Error('Smoke fixture requires --outcome');
}

if (args.delay !== undefined) {
  const delay = Number(args.delay);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error(`Invalid smoke fixture delay: ${args.delay}`);
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
}

if (args.outcome === 'evaluation-failure') {
  process.stderr.write('No main prompt contained the required needle\n');
  process.exitCode = 7;
} else if (args.outcome === 'execution-error') {
  throw new Error('Smoke fixture execution failed');
} else if (args.outcome === 'success') {
  if (args.completionFile !== undefined) {
    writeFileSync(args.completionFile, 'completed\n', 'utf8');
  }
  process.stdout.write('SMOKE_CASE_RESULT {"status":"passed"}\n');
} else {
  throw new Error(`Unknown smoke fixture outcome: ${args.outcome}`);
}
