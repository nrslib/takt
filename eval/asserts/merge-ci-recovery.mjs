import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const ajv = new Ajv();
const validators = Object.fromEntries([
  ['investigation', 'merge-ci-investigation'], ['review', 'simple-review-result'],
].map(([kind, schema]) => [kind, ajv.compile(JSON.parse(readFileSync(
  new URL(`../../builtins/schemas/${schema}.json`, import.meta.url), 'utf8',
)))]));

export function readFinalResult(output, kind) {
  let json = output.trim();
  if (!json.startsWith('{')) {
    const blocks = [...json.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)];
    const last = blocks.at(-1);
    if (!last || json.slice(last.index + last[0].length).trim() !== '') throw new Error('Missing final JSON block');
    json = last[1];
  }
  const value = JSON.parse(json);
  if (!validators[kind](value)) throw new Error(ajv.errorsText(validators[kind].errors));
  return kind === 'investigation' ? value.verdict : value.result;
}

const expected = {
  clock: 'defect', 'clock-main': 'defect', runner: 'external', 'runner-403': 'insufficient_evidence',
  secret: 'external', 'secret-empty': 'insufficient_evidence',
  'product-fix': 'APPROVE', 'product-delete': 'REJECT', 'clock-fix': 'APPROVE', 'clock-relax': 'REJECT', 'gate-removal': 'REJECT',
};

export default function grade(output, context) {
  try {
    const actual = readFinalResult(output, context.vars.kind);
    const target = expected[context.vars.case];
    if (target === undefined) throw new Error('Unknown evaluation case');
    const pass = actual === target;
    return { pass, score: pass ? 1 : 0, reason: `Structured result: expected ${target}, received ${actual}` };
  } catch (error) {
    return { pass: false, score: 0, reason: error.message };
  }
}
