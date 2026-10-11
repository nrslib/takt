import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { codexSkillOverrides, runProcess } from './cli-review.mjs';

export function buildReplayCliArgs(config, cwd, outputPath, isolationArgs) {
  const { cli, model, reasoning_effort: effort } = config;
  if (cli === 'claude') return [
    '-p', '--model', model, '--tools', '', '--disable-slash-commands', '--setting-sources=project',
    ...isolationArgs,
  ];
  if (cli === 'codex') return [
    'exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check',
    ...isolationArgs,
    '-c', `model_reasoning_effort=${effort}`,
    ...codexSkillOverrides({ disable_inherited_skills: true }, cwd),
    '-o', outputPath, '-',
  ];
  throw new Error(`Unsupported CLI provider: ${cli}`);
}

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

  async replayIsolationArgs(_cwd, _options) {
    return [];
  }

  async runReplay(args, options) {
    return runProcess(this.config.cli, args, options);
  }

  async callApi(prompt, context, options = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-interactive-topic-'));
    try {
      const { cli, model, timeout_ms: timeoutMs } = this.config;
      const isolationArgs = await this.replayIsolationArgs(cwd, options);
      const outputPath = join(cwd, 'response.txt');
      const args = buildReplayCliArgs(this.config, cwd, outputPath, isolationArgs);
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
        const output = await this.runReplay(args, { cwd, input: prompt, timeoutMs, abortSignal: options.abortSignal });
        return complete(output);
      }
      await this.runReplay(args, { cwd, input: prompt, timeoutMs, abortSignal: options.abortSignal });
      return complete(readFileSync(outputPath, 'utf8'));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
