#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProcessTreeSupport, trackProcessTree } from '../lib/process-tree.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function resolveComparisonOutputDir(repo, outputDir, paths = path) {
  const output = paths.resolve(repo, outputDir);
  const allowed = [paths.join(repo, '.tmp'), paths.join(repo, 'eval', '.results')];
  if (!allowed.some((root) => {
    const relative = paths.relative(root, output);
    return relative !== '' && relative !== '..'
      && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  })) {
    throw new Error('Output directory must be under .tmp/ or eval/.results/');
  }
  return output;
}

function parseArgs(args) {
  const options = { mode: 'both', base: 'main', suites: [], facets: [] };
  const keys = {
    '--mode': 'mode', '--base': 'base', '--suite': 'suites', '--facet': 'facets',
    '--output-dir': 'outputDir', '--filter-providers': 'filter',
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index]];
    const value = args[index + 1];
    if (!key || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${args[index]}`);
    }
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = value;
  }
  if (!['both', 'red', 'green'].includes(options.mode)
    || options.suites.length === 0 || options.facets.length === 0 || !options.outputDir) {
    throw new Error('Usage: compare-facets.mjs --suite <name> --facet <path> --output-dir <new-dir> [--base main] [--mode both|red|green] [--filter-providers <regex>]');
  }
  if (options.suites.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name))
    || new Set(options.suites).size !== options.suites.length
    || new Set(options.facets).size !== options.facets.length) {
    throw new Error('Suite names must be unique kebab-case names; facets must be unique');
  }
  return options;
}

function git(args) {
  return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readCandidate(path) {
  const parts = path.split('/');
  if (!/^builtins\/(ja|en)\/(facets\/.+\.md|workflows\/[^/]+\.yaml)$/.test(path)
    || parts.some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error(`Not a builtin facet or workflow: ${path}`);
  }
  let current = repo;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Symlink is not supported: ${path}`);
    }
  }
  if (!existsSync(current)) return { content: null, mode: null };
  const stat = lstatSync(current);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
  return { content: readFileSync(current), mode: stat.mode & 0o777 };
}

function putFile(path, content, mode) {
  if (content === null) {
    rmSync(path, { force: true });
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    chmodSync(path, mode);
  }
}

function hash(content) {
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}

function copyWorkspace(destination, paths) {
  mkdirSync(destination, { recursive: true });
  for (const path of paths) {
    const source = join(repo, path);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    cpSync(source, join(destination, path), { recursive: true });
  }
  if (!existsSync(join(repo, 'dist'))) throw new Error('Run npm run build before comparing facets');
  cpSync(join(repo, 'dist'), join(destination, 'dist'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(destination, 'node_modules'), 'junction');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertProcessTreeSupport();
  const output = resolveComparisonOutputDir(repo, options.outputDir);
  const base = git(['rev-parse', '--verify', `${options.base}^{commit}`]).toString().trim();
  const files = options.facets.map((path) => {
    const candidate = readCandidate(path);
    const entry = git(['ls-tree', base, '--', path]).toString();
    if (entry && !/^100(644|755) blob /.test(entry)) throw new Error(`Not a regular baseline file: ${path}`);
    const baseline = entry ? git(['show', `${base}:${path}`]) : null;
    if (candidate.content === null && baseline === null) throw new Error(`Missing in both revisions: ${path}`);
    return { path, ...candidate, baseline };
  });
  // Freeze the input list before producing anything under eval/.results.
  const paths = [...new Set([
    ...git(['ls-files', '-z']).toString().split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'eval']).toString().split('\0'),
    ...options.facets,
  ].filter(Boolean))];
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  let activeTree;
  let stopping;
  let interrupted;
  const manifest = {
    startedAt: new Date().toISOString(), base, mode: options.mode,
    suites: options.suites, filterProviders: options.filter ?? null,
    files: files.map((file) => ({ path: file.path, baselineSha256: hash(file.baseline), candidateSha256: hash(file.content), mode: file.mode })),
    runs: [],
  };
  const save = () => writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const interrupt = (signal) => {
    interrupted ??= signal;
    manifest.interrupted = interrupted;
    save();
    if (activeTree && !stopping) {
      stopping = activeTree.stop();
      // The run awaits this promise after the child's close event.
      stopping.catch(() => {});
    }
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    save();
    const inputWorkspace = join(output, 'input-workspace');
    manifest.inputWorkspace = inputWorkspace;
    copyWorkspace(inputWorkspace, paths);
    for (const file of files) {
      if (file.content !== null) putFile(join(output, 'facets/green', file.path), file.content, file.mode);
      if (file.baseline !== null) putFile(join(output, 'facets/red', file.path), file.baseline, 0o644);
    }
    const phases = options.mode === 'both' ? ['red', 'green'] : [options.mode];
    for (const phase of phases) {
      for (const suite of options.suites) {
        if (interrupted) break;
        const directory = join(output, phase, suite);
        const workspace = join(directory, 'workspace');
        mkdirSync(directory, { recursive: true });
        cpSync(inputWorkspace, workspace, { recursive: true, verbatimSymlinks: true });
        if (phase === 'red') {
          for (const file of files) putFile(join(workspace, file.path), file.baseline, file.mode ?? 0o644);
        }
        const resultFile = join(directory, 'results.json');
        const rawDirectory = join(directory, 'raw');
        const args = ['eval/scripts/run-evals.mjs', '--prepare', suite, '--no-cache', '--output', resultFile];
        if (options.filter !== undefined) args.push('--filter-providers', options.filter);
        const log = openSync(join(directory, 'runner.log'), 'w');
        const record = { phase, suite, args, workspace, resultFile, rawDirectory, startedAt: new Date().toISOString() };
        manifest.runs.push(record);
        save();
        console.log(`${phase}: ${suite} → ${directory}`);
        try {
          const env = { ...process.env, TAKT_EVAL_RECORD_DIR: rawDirectory, TAKT_INTERACTIVE_EVAL_OUTPUT_DIR: rawDirectory };
          // A caller's Git override must never point copied fixtures at the source checkout.
          for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
          const result = await new Promise((resolveRun, rejectRun) => {
            const child = spawn(process.execPath, args, {
              cwd: workspace, stdio: ['ignore', log, log], detached: process.platform !== 'win32', env,
            });
            activeTree = trackProcessTree(child);
            child.once('error', rejectRun);
            child.once('close', (code, signal) => resolveRun({ code, signal }));
          });
          Object.assign(record, result, { finishedAt: new Date().toISOString(), resultExists: existsSync(resultFile) });
          await (stopping ?? activeTree.stop());
        } catch (error) {
          record.error = error.message;
          throw error;
        } finally {
          activeTree?.dispose();
          activeTree = undefined;
          stopping = undefined;
          closeSync(log);
          save();
        }
      }
    }
  } finally {
    manifest.interrupted = interrupted ?? null;
    manifest.finishedAt = new Date().toISOString();
    save();
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
  process.exitCode = interrupted ? (interrupted === 'SIGINT' ? 130 : 143)
    : manifest.runs.some((run) => run.code !== 0 || !run.resultExists) ? 1 : 0;
}

// シンボリックリンク経由で起動しても直接実行と分かるよう、両方を実体のパスにそろえて比べる
if (process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
