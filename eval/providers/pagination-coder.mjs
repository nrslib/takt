import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { buildCodexSkillConfig } from '../../dist/infra/codex/skill-config.js';
import { prepareWorkingDirectory, rewriteWorkingDirectoryPaths, runProcess } from './cli-review.mjs';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default class PaginationCoderProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return `pagination-coder:${this.config.model}`;
  }

  async callApi(prompt, _context, options = {}) {
    const workingDirectory = prepareWorkingDirectory({ ...this.config, isolate_working_dir: true });
    const artifactDirectory = join(evalDirectory, '.results', 'db-pagination-implement', randomUUID());
    mkdirSync(artifactDirectory, { recursive: true });
    try {
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
      const renderedPrompt = rewriteWorkingDirectoryPaths(prompt, workingDirectory);
      writeFileSync(join(artifactDirectory, 'prompt.md'), renderedPrompt);
      const result = await thread.run(renderedPrompt, { signal: options.abortSignal });
      cpSync(workingDirectory.cwd, join(artifactDirectory, 'project'), { recursive: true });
      writeFileSync(join(artifactDirectory, 'agent.json'), JSON.stringify({
        threadId: thread.id, model: this.config.model, reasoningEffort: this.config.reasoning_effort,
        ...result,
      }, null, 2));
      const measurement = JSON.parse(await runProcess(process.execPath, [
        join(evalDirectory, 'asserts', 'measure-pagination.mjs'), workingDirectory.cwd,
      ], { cwd: workingDirectory.cwd, timeoutMs: 30_000, abortSignal: options.abortSignal }));
      const output = {
        response: result.finalResponse,
        historySource: readFileSync(join(workingDirectory.cwd, 'src/history.mjs'), 'utf8'),
        repositorySource: readFileSync(join(workingDirectory.cwd, 'src/repository.mjs'), 'utf8'),
        measurement,
      };
      writeFileSync(join(artifactDirectory, 'result.json'), JSON.stringify(output, null, 2));
      return { output: JSON.stringify(output), metadata: { threadId: thread.id, artifactDirectory } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), metadata: { artifactDirectory } };
    } finally {
      workingDirectory.cleanup();
    }
  }
}
