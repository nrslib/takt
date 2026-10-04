import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { buildCodexSkillConfig } from '../../dist/infra/codex/skill-config.js';
import { prepareWorkingDirectory, rewriteWorkingDirectoryPaths } from './cli-review.mjs';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (prefix === '' && entry.name === '.takt') continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, name);
    if (entry.isSymbolicLink()) files[name] = `link:${readlinkSync(path)}`;
    else if (entry.isDirectory()) Object.assign(files, snapshot(directory, name));
    else if (entry.isFile()) files[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return files;
}

function readLabelSource(directory) {
  const path = join(directory, 'src/label.js');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 20_000
      || !realpathSync(path).startsWith(`${realpathSync(directory)}${sep}`)) return undefined;
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

// Each call gets an independent writable project, and exposes actions rather than self-reported success.
export default class ScopeActionCoderProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return `scope-action-coder:${this.config.model}`;
  }

  async callApi(prompt, _context, options = {}) {
    const workingDirectory = prepareWorkingDirectory({ ...this.config, isolate_working_dir: true });
    try {
      const before = snapshot(workingDirectory.cwd);
      const config = buildCodexSkillConfig({
        cwd: workingDirectory.cwd,
        env: process.env,
        inheritance: { repo: false, user: false },
      });
      const thread = new Codex({ config }).startThread({
        model: this.config.model,
        modelReasoningEffort: this.config.reasoning_effort,
        workingDirectory: workingDirectory.cwd,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        skipGitRepoCheck: true,
      });
      const result = await thread.run(rewriteWorkingDirectoryPaths(prompt, workingDirectory), {
        signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(options.abortSignal ? [options.abortSignal] : [])]),
      });
      const after = snapshot(workingDirectory.cwd);
      const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter(path => before[path] !== after[path]).sort();
      const commands = result.items.filter(item => item.type === 'command_execution');
      const patches = result.items.filter(item => item.type === 'file_change');
      const output = {
        response: result.finalResponse,
        changedPaths,
        commands,
        patches,
        labelSource: readLabelSource(workingDirectory.cwd),
      };
      const artifactDirectory = join(evalDirectory, '.results', 'implement-scope-actions', randomUUID());
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(join(artifactDirectory, 'prompt.md'), prompt);
      writeFileSync(join(artifactDirectory, 'result.json'), JSON.stringify({
        threadId: thread.id, model: this.config.model, reasoningEffort: this.config.reasoning_effort,
        before, after, ...output,
      }, null, 2));
      return {
        output: JSON.stringify(output),
        metadata: { threadId: thread.id, artifactDirectory },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      workingDirectory.cleanup();
    }
  }
}
