import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PHASE_CASES, PHASE_PROVIDERS, taskFor } from '../phase-awareness-cases.mjs';

export const PHASE_AWARENESS_TARGET = 'phase-awareness';

function fixturePaths(directory, prefix) {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected fixture symlink: ${path}`);
    return entry.isDirectory() ? fixturePaths(directory, path) : [path];
  });
}

export function preparePhaseAwareness() {
  const evalDir = fileURLToPath(new URL('../', import.meta.url));
  const directory = join(evalDir, 'prompts');
  mkdirSync(directory, { recursive: true });
  const tasks = PHASE_CASES.map((entry) => ({ id: entry.id, task: taskFor(entry) }));
  const frozen = {
    cases: tasks, providers: PHASE_PROVIDERS,
    assets: ['providers/phase-session.mjs', 'providers/phase-session-worker.mjs', 'providers/phase-production.mjs',
      'providers/phase-cli.mjs', 'providers/phase-events.mjs',
      'asserts/phase-awareness.mjs', 'asserts/phase-content.mjs', 'phase-awareness-cases.mjs',
      'providers/report-phase-handoff-audit-v3.mjs', 'scripts/phase-awareness-redgreen.mjs', 'scripts/prepare-phase-awareness.mjs',
      ...fixturePaths(evalDir, 'fixtures/phase-awareness'), 'scenarios/phase-awareness/phase-awareness.yaml']
      .map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(evalDir, path))).digest('hex') })),
  };
  writeFileSync(join(directory, 'phase-awareness.session.md'), '{{task}}\n');
  writeFileSync(join(directory, 'phase-awareness.manifest.json'), JSON.stringify(frozen, null, 2));
}
