import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { codexSkillOverrides, runProcess } from './cli-review.mjs';

export function persistGeneratedOutput(outputDirectory, record) {
  if (outputDirectory === undefined) return;
  if (typeof outputDirectory !== 'string' || outputDirectory.trim().length === 0) {
    throw new Error('TAKT_INTERACTIVE_EVAL_OUTPUT_DIR must be a non-empty directory path');
  }
  if (record?.vars === undefined) {
    throw new Error('Promptfoo context.vars is required to save an eval output');
  }
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${randomUUID()}.json`), `${JSON.stringify(record)}\n`, { flag: 'wx' });
}

export default class InteractiveTopicJudge {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return `interactive-topic-judge:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, context, options = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-interactive-topic-'));
    try {
      const { cli, model, reasoning_effort: effort, timeout_ms: timeoutMs } = this.config;
      const complete = (output) => {
        persistGeneratedOutput(process.env.TAKT_INTERACTIVE_EVAL_OUTPUT_DIR, {
          prompt,
          cli,
          model,
          vars: context?.vars,
          output,
        });
        return { output };
      };
      if (cli === 'claude') {
        const output = await runProcess('claude', [
          '-p', '--model', model, '--tools', '', '--disable-slash-commands', '--setting-sources=project',
        ], { cwd, input: prompt, timeoutMs, abortSignal: options.abortSignal });
        return complete(output);
      }
      if (cli === 'codex') {
        const outputPath = join(cwd, 'response.txt');
        await runProcess('codex', [
          'exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check',
          '-c', `model_reasoning_effort=${effort}`,
          ...codexSkillOverrides({ disable_inherited_skills: true }, cwd),
          '-o', outputPath, '-',
        ], { cwd, input: prompt, timeoutMs, abortSignal: options.abortSignal });
        return complete(readFileSync(outputPath, 'utf8'));
      }
      throw new Error(`Unsupported CLI provider: ${cli}`);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
