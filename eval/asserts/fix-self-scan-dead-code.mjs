/**
 * Change-induced dead code: after FU-5 labels the `default` origin inside
 * the mapping, the caller-supplied placeholder parameter has no purpose
 * left, and after FU-4 migrates the renderer, `legacyFormatLine` loses its
 * last caller. A clean fix deletes both instead of leaving them behind.
 *
 * Checks are structural rather than string-absence based:
 * - `sourceLabel` calls, bindings, and export aliases are resolved from the
 *   parsed AST (fix-self-scan-source-label-ast.mjs), so strings containing
 *   parens, nested calls, default parameters, and `export { impl as
 *   sourceLabel }` are all handled;
 * - exports are compared against the pristine fixture's reference graph, so
 *   an export that HAD callers but lost them all (or a new never-referenced
 *   export — e.g. a renamed leftover) fails, while pre-existing entry-point
 *   exports do not;
 * - a src module that fails to import is itself reported instead of being
 *   treated as a relocation.
 */
import {
  listSourceFiles,
  readSource,
  relPath,
  workDir,
  fixtureDir,
  stripComments,
  fail,
  pass,
} from './fix-self-scan-lib.mjs';
import { sourceLabelViolations } from './fix-self-scan-source-label-ast.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Imports every module in a killable child process with a hard timeout, so
// a fixture module that never terminates (sync loop, hanging top-level
// await) cannot stall the assertion run. Returns violation strings.
function importFailuresIsolated(relFiles) {
  const script = `
    import { pathToFileURL } from 'node:url';
    import { resolve } from 'node:path';
    const failures = [];
    for (const rel of ${JSON.stringify(relFiles)}) {
      try {
        await import(pathToFileURL(resolve(rel)).href);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push([rel, message.split('\\n')[0]]);
      }
    }
    console.log(JSON.stringify(failures));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.signal !== null) {
    return [`module import phase was killed after 30s (${result.signal}) — a src module does not terminate on import`];
  }
  if (result.status !== 0) {
    const message = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0];
    return [`module import phase crashed: ${message}`];
  }
  try {
    return JSON.parse(result.stdout).map(([rel, message]) => `${rel} (module fails to import: ${message})`);
  } catch {
    return ['module import phase produced unreadable output'];
  }
}

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// name -> reference count across src/ + tests/. Same-file uses count too
// (an export consumed only inside its own module is alive), but the
// definition and export statements themselves do not.
function referenceGraph(rootDir) {
  const files = [
    ...listSourceFiles(join(rootDir, 'src')),
    ...listSourceFiles(join(rootDir, 'tests')),
  ].map((file) => ({ file, source: stripComments(readSource(file)) }));
  const graph = new Map();
  for (const { file, source } of files) {
    for (const name of exportedNames(source)) {
      let refs = 0;
      for (const other of files) {
        const matches = (other.source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        if (other.file !== file) {
          refs += matches;
          continue;
        }
        const definitions =
          (other.source.match(
            new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`, 'g'),
          ) ?? []).length
          + (other.source.match(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 'g')) ?? []).length;
        refs += Math.max(0, matches - definitions);
      }
      graph.set(name, { refs, file: relative(rootDir, file) });
    }
  }
  return graph;
}

export default async function assertNoChangeInducedDeadCode() {
  const offenders = [];

  for (const file of listSourceFiles()) {
    const resolveModule = (specifier) => {
      const target = resolve(dirname(file), specifier);
      return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    };
    for (const violation of sourceLabelViolations(readSource(file), relPath(file), resolveModule)) {
      offenders.push(`${relPath(file)} (sourceLabel ${violation})`);
    }
  }

  offenders.push(...importFailuresIsolated(listSourceFiles().map((file) => relative(workDir, file))));

  const baseline = referenceGraph(fixtureDir);
  const current = referenceGraph(workDir);
  for (const [name, { refs, file }] of current) {
    const before = baseline.get(name);
    if (before !== undefined && before.refs > 0 && refs === 0) {
      offenders.push(`${file} (export ${name} lost every caller in this change and was left behind)`);
    }
    if (before === undefined && refs === 0) {
      offenders.push(`${file} (new export ${name} has no references — likely a renamed leftover)`);
    }
  }

  if (offenders.length > 0) {
    return fail(`change-induced dead code survived the fix: ${offenders.join('; ')}`);
  }
  return pass('no multi-argument sourceLabel remains, all modules import, and no export lost its callers');
}
