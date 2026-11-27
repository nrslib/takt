import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { buildCodexSkillConfig } from '../../dist/infra/codex/skill-config.js';
import { changedProjectPaths } from '../asserts/frontend-mediator-implement.mjs';
import { prepareWorkingDirectory, resolveTimeoutMs, rewriteWorkingDirectoryPaths } from './cli-review.mjs';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MAX_RUBRIC_CHARACTERS = 200_000;

export function claudeFinalResponse(stdout) {
  const results = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === 'result') results.push(event);
  }
  if (results.length !== 1) throw new Error(`Expected one Claude stream-json result; found ${results.length}`);
  const [result] = results;
  if (result.is_error) throw new Error(`Claude result failed: ${JSON.stringify(result)}`);
  if (typeof result.result !== 'string') throw new Error('Claude stream-json result requires a string result');
  return result.result;
}
const ignoredRubricDirectories = new Set([
  '.git', '.takt', 'node_modules', 'dist', 'build', 'out', 'coverage', '.vite', '.next', '.cache',
]);

function rubricPath(path) {
  if (path.split('/').some(part => ignoredRubricDirectories.has(part))) return false;
  if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)) return false;
  if (/\.(?:map|tsbuildinfo)$|\.min\.[cm]?js$/.test(path)) return false;
  return (path.startsWith('src/') && /\.(?:[cm]?[jt]sx?|css|scss|sass|less|json|svg|html)$/.test(path))
    || (!path.includes('/') && /^(?:package\.json|tsconfig(?:[.-][\w.-]+)?\.json|[\w.-]+\.config\.[cm]?[jt]s|\.eslintrc(?:\.[\w]+)?)$/.test(path));
}

export function readRubricFiles(directory, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredRubricDirectories.has(entry.name) && (path === 'src' || path.startsWith('src/'))) {
        Object.assign(files, readRubricFiles(directory, path));
      }
    } else if (rubricPath(path)) {
      if (entry.isSymbolicLink()) throw new Error(`Rubric source contains a symbolic link: ${path}`);
      if (entry.isFile()) files[path] = readFileSync(join(directory, path), 'utf8');
    }
  }
  return files;
}

function pickEnvironment(env, keys) {
  return Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

export function buildFrontendCodexOptions(cwd, sourceEnv = process.env) {
  const sourceHome = sourceEnv.CODEX_HOME || join(sourceEnv.HOME || homedir(), '.codex');
  const authPath = join(sourceHome, 'auth.json');
  const home = mkdtempSync(join(tmpdir(), 'takt-frontend-codex-home-'));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome);
    copyFileSync(authPath, join(codexHome, 'auth.json'));
    const env = {
      ...pickEnvironment(sourceEnv, ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']),
      HOME: home,
      CODEX_HOME: codexHome,
    };
    return {
      options: { env, config: buildCodexSkillConfig({ cwd, env, inheritance: { repo: false, user: false } }) },
      cleanup,
    };
  } catch (error) {
    cleanup();
    if (error.code === 'ENOENT') throw new Error(`Codex authentication requires auth.json at ${authPath}`, { cause: error });
    throw error;
  }
}

export function buildFrontendClaudeEnv(env = process.env) {
  return pickEnvironment(env, ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'HOME', 'USER',
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
}

// Both implementation and rubric calls use fresh work copies and disable inherited skills.
export default class FrontendMediatorCoderProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.artifactRoot = options.artifactRoot ?? join(evalDirectory, '.results/frontend-mediator-coder');
  }

  id() {
    return `frontend-mediator-coder:${this.config.role ?? 'implement'}:${this.config.provider}:${this.config.model ?? 'default'}`;
  }

  async runAgent(prompt, cwd, _context, options) {
    const { provider } = this.config;
    if (provider === 'openai:codex-sdk') {
      if (!this.config.model || !this.config.model_reasoning_effort) {
        throw new Error('Codex requires explicit model and model_reasoning_effort');
      }
      const timeoutMs = resolveTimeoutMs(this.config);
      if (timeoutMs === 0) throw new Error('Codex requires a positive timeout_ms');
      if (options.abortSignal?.aborted) throw new Error('Codex aborted before starting', { cause: options.abortSignal.reason });
      const isolated = buildFrontendCodexOptions(cwd);
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('Codex aborted', { cause: options.abortSignal.reason }));
      const timer = setTimeout(() => {
        controller.abort(new Error(`Codex timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      options.abortSignal?.addEventListener('abort', abort, { once: true });
      try {
        const thread = new Codex(isolated.options).startThread({
          model: this.config.model,
          modelReasoningEffort: this.config.model_reasoning_effort,
          workingDirectory: cwd,
          sandboxMode: this.config.role === 'rubric' ? 'read-only' : 'workspace-write',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
          networkAccessEnabled: false,
          webSearchMode: 'disabled',
        });
        const result = await thread.run(prompt, { signal: controller.signal });
        controller.signal.throwIfAborted();
        return { output: result.finalResponse, metadata: { threadId: thread.id } };
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', abort);
        isolated.cleanup();
      }
    }
    if (provider === 'claude') {
      const timeoutMs = resolveTimeoutMs({ timeout_ms: this.config.timeout_ms ?? 1_800_000 });
      if (timeoutMs === 0) throw new Error('Claude implementation requires a positive timeout_ms');
      if (options.abortSignal?.aborted) throw new Error('Claude implementation aborted before starting');
      const output = await new Promise((resolveOutput, reject) => {
        let failure;
        let outputBytes = 0;
        const stdout = [];
        const stderr = [];
        const logs = options.artifactDirectory
          ? ['claude.stdout.log', 'claude.stderr.log'].map(name => join(options.artifactDirectory, name))
          : [];
        for (const path of logs) writeFileSync(path, '');
        const child = spawn('claude', [
          '-p', '--model', this.config.model,
          ...(this.config.role === 'rubric'
            ? ['--output-format', 'text']
            : ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']),
          '--allowed-tools', this.config.role === 'rubric' ? 'Read,Glob,Grep' : 'Read,Write,Edit,Glob,Grep,Bash',
          '--permission-mode', this.config.role === 'rubric' ? 'dontAsk' : 'acceptEdits', '--setting-sources=project',
          '--disable-slash-commands', '--safe-mode', '--no-session-persistence',
        ], { cwd, env: buildFrontendClaudeEnv(), detached: true });
        const killGroup = error => {
          failure ??= error;
          if (!child.pid) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') reject(error);
          }
        };
        const timer = setTimeout(() => {
          killGroup(new Error(`Claude implementation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const abort = () => killGroup(new Error('Claude implementation aborted', { cause: options.abortSignal.reason }));
        options.abortSignal?.addEventListener('abort', abort, { once: true });
        child.on('error', error => { failure ??= error; });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          options.abortSignal?.removeEventListener('abort', abort);
          if (failure) reject(Object.assign(failure, { exitCode: code, signal }));
          else if (code !== 0) reject(Object.assign(
            new Error(`Claude implementation exited with ${signal ?? code}: ${Buffer.concat(stderr).toString('utf8')}`),
            { exitCode: code, signal },
          ));
          else resolveOutput(Buffer.concat(stdout).toString('utf8'));
        });
        for (const [stream, chunks, log] of [[child.stdout, stdout, logs[0]], [child.stderr, stderr, logs[1]]]) {
          stream.on('data', chunk => {
            try {
              if (log) appendFileSync(log, chunk);
            } catch (error) {
              killGroup(error);
              return;
            }
            outputBytes += chunk.length;
            if (outputBytes > 16 * 1024 * 1024) killGroup(new Error('Claude output exceeded 16 MiB'));
            else chunks.push(chunk);
          });
        }
        child.stdin.on('error', killGroup);
        child.stdin.end(prompt);
      });
      return { output: this.config.role === 'rubric' ? output : claudeFinalResponse(output) };
    }
    throw new Error(`Unsupported mutable provider: ${provider}`);
  }

  async callApi(prompt, context, options = {}) {
    let workingDirectory;
    let artifactDirectory;
    try {
      workingDirectory = prepareWorkingDirectory({ ...this.config, isolate_working_dir: true });
      const renderedPrompt = rewriteWorkingDirectoryPaths(prompt, workingDirectory);
      if (this.config.role === 'rubric') {
        return await this.runAgent(renderedPrompt, workingDirectory.cwd, context, options);
      }
      artifactDirectory = join(this.artifactRoot, randomUUID());
      mkdirSync(artifactDirectory, { recursive: true });
      const before = readRubricFiles(workingDirectory.cwd);
      writeFileSync(join(artifactDirectory, 'prompt.md'), renderedPrompt);
      let response;
      try {
        response = await this.runAgent(renderedPrompt, workingDirectory.cwd, context, { ...options, artifactDirectory });
      } finally {
        cpSync(workingDirectory.cwd, join(artifactDirectory, 'project'), {
          recursive: true,
          filter: source => !relative(workingDirectory.cwd, source).split(/[\\/]/).includes('node_modules'),
        });
      }
      const after = readRubricFiles(workingDirectory.cwd);
      const changedPaths = changedProjectPaths(before, after);
      const output = {
        response: response.output,
        changedPaths,
        deletedPaths: changedPaths.filter(path => after[path] === undefined),
        // Only changed source/config files enter the grader prompt.
        files: Object.fromEntries(changedPaths.filter(path => after[path] !== undefined)
          .map(path => [path, after[path]])),
      };
      const serialized = JSON.stringify(output);
      if (serialized.length > MAX_RUBRIC_CHARACTERS) {
        throw new Error(`Rubric input exceeds ${MAX_RUBRIC_CHARACTERS} characters (${serialized.length})`);
      }
      writeFileSync(join(artifactDirectory, 'result.json'), JSON.stringify({
        provider: this.config, ...response, observed: output,
      }, null, 2));
      return {
        ...response,
        output: serialized,
        metadata: { ...response.metadata, artifactDirectory },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (artifactDirectory) {
        writeFileSync(join(artifactDirectory, 'result.json'), JSON.stringify({
          provider: this.config, error: message, code: error?.code, exitCode: error?.exitCode, signal: error?.signal,
        }, null, 2));
      }
      return { error: message, metadata: { artifactDirectory } };
    } finally {
      workingDirectory?.cleanup();
    }
  }
}
