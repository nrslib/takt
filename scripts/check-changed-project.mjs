import { isDeepStrictEqual } from 'node:util';
import {
  changedPathsAgainst,
  findChangedNpmScripts,
  git,
  packageManifestPath,
  readInput,
  readPackageManifests,
  runProjectNpm,
} from './changed-project-inputs.mjs';

const check = process.argv[2];
if (check !== 'build' && check !== 'lint') {
  throw new Error('Expected build or lint');
}

const commonInputs = [
  'tsconfig.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  'patches',
  'scripts/check-changed-project.mjs',
  'scripts/changed-project-inputs.mjs',
  'scripts/npm-invocation.mjs',
];
const buildInputs = [
  'tsconfig.opencode-probe.json',
  'scripts/clean-build-output.mjs',
  'scripts/copy-build-assets.mjs',
  ':(glob)tools/opencode-probe/**/*.d.mts',
  ':(glob)vendor/faceted-prompting/dist/**/*.d.ts',
  'vendor/faceted-prompting/package.json',
  ':(glob)src/shared/prompts/*/*.md',
  ':(glob)src/shared/prompts/*/parts/*.md',
  ':(glob)src/shared/i18n/labels_*.yaml',
  ':(glob)src/core/runtime/presets/*.sh',
  ':(glob)src/infra/deepseek-harness/*.mjs',
];
const lintInputs = [
  ':(glob)eslint.config.*',
  'scripts/daemon-reachability.mjs',
  'scripts/daemon-lint-rules.mjs',
  'scripts/catch-lint-rules.mjs',
];
const sourceInputs = [
  ':(glob)src/**/*.[cm]ts',
  ':(glob)src/**/*.ts',
  ':(glob)src/**/*.tsx',
  ':(exclude)src/__tests__',
];
const packageFields = [
  'name', 'type', 'imports', 'exports', 'main', 'types', 'typesVersions',
  'dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'optionalDependencies', 'overrides', 'engines', 'packageManager', 'workspaces',
];
const scriptNames = new Set([
  check, `pre${check}`, `post${check}`, 'postinstall', 'patch:dependencies',
  'prepatch:dependencies', 'postpatch:dependencies',
]);

const head = git('rev-parse', 'HEAD').trim();
const changed = changedPathsAgainst(head, [
  packageManifestPath,
  ...commonInputs,
  ...sourceInputs,
  ...(check === 'build'
    ? [...buildInputs, ':(glob)src/**/*.json']
    : [...lintInputs, ':(glob)src/**/*.js', ':(glob)src/**/*.[cm]js']),
]);
let packageChanges = [];
if (changed.delete(packageManifestPath)) {
  const manifests = readPackageManifests(head, readInput(packageManifestPath));
  const changedFields = packageFields.filter((field) =>
    !isDeepStrictEqual(manifests.baseline[field], manifests.worktree[field]));
  const changedScripts = findChangedNpmScripts(manifests, (name) => scriptNames.has(name));
  packageChanges = [...changedFields, ...changedScripts.map((name) => `scripts.${name}`)];
}

if (changed.size === 0 && packageChanges.length === 0) {
  process.stdout.write(`npm run ${check} skipped: no relevant inputs changed against HEAD.\n`);
} else {
  process.stdout.write(`Running npm run ${check} against: ${JSON.stringify({
    head, changedPaths: [...changed].sort(), packageChanges,
  })}\n`);
  process.exitCode = runProjectNpm(['run', check]);
}
