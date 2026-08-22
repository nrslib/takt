import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runSmokeBatch, runSmokeScript } from '../smoke-process.mjs';

const configPath = process.argv[2];
if (configPath === undefined) {
  throw new Error('Smoke batch fixture requires a config path');
}

const parsed = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
const caseTimeoutMs = parsed.caseTimeoutMs;
if (!Number.isInteger(caseTimeoutMs) || caseTimeoutMs <= 0) {
  throw new Error('Smoke batch fixture config requires a positive integer caseTimeoutMs');
}
if (!Array.isArray(parsed.cases)) {
  throw new Error('Smoke batch fixture config requires a cases array');
}

const cases = parsed.cases.map((candidate) => {
  if (
    typeof candidate?.name !== 'string'
    || typeof candidate?.script !== 'string'
    || !Array.isArray(candidate?.args)
    || !candidate.args.every((argument) => typeof argument === 'string')
  ) {
    throw new Error('Smoke batch fixture contains an invalid case');
  }
  return {
    name: candidate.name,
    run: () => runSmokeScript(
      resolve(candidate.script),
      candidate.args,
      process.env,
      {
        timeoutMs: caseTimeoutMs,
        reportMarker: 'SMOKE_CASE_RESULT ',
      },
    ),
  };
});

await runSmokeBatch(cases);
