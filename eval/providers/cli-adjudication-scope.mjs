import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordProviderCalls } from './execution-record.mjs';
import { parsePhaseEvents } from './phase-events.mjs';
import {
  createCliReviewSession, mergeCliReviewConfig, prepareWorkingDirectory,
  rewriteWorkingDirectoryPaths,
} from './cli-review.mjs';
import { renderAdjudicationPrompt, resolveAdjudicationPrompt } from './cli-review-adjudication.mjs';

export function scopeTrace(raw, cli, phase) {
  const parsed = parsePhaseEvents(raw, cli, false);
  const seen = new Set();
  const tools = parsed.tools.map((tool) => {
    if (/Warning: truncated output|Output (?:was )?truncated|characters truncated|tokens truncated/i.test(tool.output)) {
      throw new Error(`${phase}: truncated tool output cannot establish scope`);
    }
    const input = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input);
    const categories = [
      ['policy', /polic(?:y|ies)/i], ['knowledge', /knowledge/i],
      ['report', /reports|history|fix-plan|verification|resolution/i],
      ['diff', /git\s+diff/i], ['code', /\bsrc\/|\btests?\//i],
    ].filter(([, pattern]) => pattern.test(input)).map(([category]) => category);
    const key = JSON.stringify([tool.name, tool.input]);
    const repeated = seen.has(key);
    seen.add(key);
    return { ...tool, categories, repeated, characters: tool.output.length, bytes: Buffer.byteLength(tool.output) };
  });
  const returnedByCategory = Object.fromEntries(['policy', 'knowledge', 'report', 'diff', 'code'].map(category => {
    const matching = tools.filter(tool => tool.categories.includes(category));
    return [category, {
      characters: matching.reduce((sum, tool) => sum + tool.characters, 0),
      bytes: matching.reduce((sum, tool) => sum + tool.bytes, 0),
    }];
  }));
  return { phase, sessionId: parsed.sessionId, answer: parsed.answer, tools, returnedByCategory };
}

// The grader receives real tool returns, not an agent-authored account of its reads.
export default class CliAdjudicationScopeProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.callApi = recordProviderCalls(this, this.callApi);
    this.prepareWorkspace = dependencies.prepareWorkspace ?? prepareWorkingDirectory;
    this.createSession = dependencies.createSession ?? createCliReviewSession;
    this.readPrompt = dependencies.readPrompt ?? ((path) => readFileSync(path, 'utf8'));
    this.artifactRoot = dependencies.artifactRoot
      ?? fileURLToPath(new URL('../.results/adjudication-scope/', import.meta.url));
  }

  id() { return `cli-adjudication-scope:${this.config.cli}:${this.config.model}`; }

  async callApi(prompt, context, options = {}) {
    let workspace;
    let artifactDirectory;
    try {
      const config = mergeCliReviewConfig(this.config, context);
      if (!config.isolate_working_dir) throw new Error('Scope evaluation requires an isolated workspace');
      if (typeof context.vars?.task !== 'string') throw new Error('Scope evaluation requires task');
      workspace = this.prepareWorkspace(config);
      artifactDirectory = join(this.artifactRoot, randomUUID());
      mkdirSync(artifactDirectory, { recursive: true });
      const save = (name, value) => writeFileSync(join(artifactDirectory, name),
        typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      let phase;
      let raw;
      const traces = [];
      const session = this.createSession(config, {
        cwd: workspace.cwd, abortSignal: options.abortSignal,
        onEvent() {},
        onInvocation: (invocation) => save(`${phase}.invocation.json`, invocation),
        onOutput: ({ stdout, stderr }) => {
          raw = stdout;
          save(`${phase}.stdout.jsonl`, stdout);
          save(`${phase}.stderr.txt`, stderr);
        },
      });
      const run = async (name, text) => {
        phase = name;
        raw = '';
        const dispatched = rewriteWorkingDirectoryPaths(text, workspace);
        save(`${phase}.prompt.md`, dispatched);
        const response = await session.run(dispatched);
        const trace = scopeTrace(raw, config.cli, phase);
        if (response !== trace.answer) throw new Error(`${phase}: response does not match event evidence`);
        traces.push(trace);
        save(`${phase}.trace.json`, trace);
        return response;
      };
      const analysis = await run('phase1', prompt);
      const template = this.readPrompt(resolveAdjudicationPrompt(config.report_prompt));
      const report = await run('phase2', renderAdjudicationPrompt(template, {
        task: context.vars.task, previousResponse: analysis, scenario: '',
      }));
      if (traces[0].sessionId !== traces[1].sessionId) throw new Error('Report did not resume the analysis session');
      save('report.md', report);
      return {
        output: JSON.stringify({ initialPrompt: rewriteWorkingDirectoryPaths(prompt, workspace), analysis, report, traces }),
        metadata: { artifactDirectory },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (artifactDirectory) writeFileSync(join(artifactDirectory, 'error.txt'), message);
      return { error: message, metadata: { artifactDirectory } };
    } finally {
      workspace?.cleanup();
    }
  }
}
