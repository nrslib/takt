import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorkingDirectory, mergeCliReviewConfig, rewriteWorkingDirectoryPaths, createCliReviewSession } from './cli-review.mjs';
import { auditAdjudicator, snapshotFiles } from './adjudicator-no-fix-audit.mjs';

const evalDirectory = fileURLToPath(new URL('../', import.meta.url));

// Phase 1 only. Reviewer reports and facet snapshots are already seeded by prepare.
export default class CliAdjudicatorNoFixProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.createSession = dependencies.createSession ?? createCliReviewSession;
  }

  id() { return `cli-adjudicator-no-fix:${this.config.cli}:${this.config.model}`; }

  async callApi(prompt, context, options = {}) {
    let workspace;
    let artifactDirectory;
    let metadata;
    try {
      const config = mergeCliReviewConfig(this.config, context);
      if (!config.isolate_working_dir) throw new Error('Adjudicator audit requires isolate_working_dir');
      workspace = prepareWorkingDirectory(config);
      const { cwd } = workspace;
      artifactDirectory = join(resolve(evalDirectory, this.config.artifact_dir ?? '.results/adjudicator-no-fix'), randomUUID());
      mkdirSync(artifactDirectory, { recursive: true });
      const save = (name, data) => writeFileSync(join(artifactDirectory, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      const dispatched = rewriteWorkingDirectoryPaths(prompt, workspace);
      save('phase1-prompt.md', dispatched);
      const before = snapshotFiles(cwd);
      save('before.json', before);
      const events = [];
      let raw = '';
      let output = '';
      let failure;
      save('stdout.jsonl', raw);
      save('stderr.txt', '');
      save('events.json', events);
      try {
        const session = this.createSession(config, {
          cwd, abortSignal: options.abortSignal, sandboxMode: 'workspace-write',
          allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
          onInvocation: (invocation) => save('invocation.json', invocation),
          onOutput: ({ stdout, stderr }) => {
            raw = stdout;
            save('stdout.jsonl', stdout);
            save('stderr.txt', stderr);
          },
          onEvent: (event) => {
            events.push(event);
            save('events.json', events);
          },
        });
        output = await session.run(dispatched);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const after = snapshotFiles(cwd);
      const audit = auditAdjudicator({ raw, events, cli: config.cli, cwd, before, after, error: failure });
      save('after.json', after);
      save('phase1-response.md', output);
      save('events.json', events);
      save('audit.json', audit);
      if (failure) save('error.txt', failure);
      metadata = { artifactDirectory, phase1_audit: audit };
      return failure ? { error: failure, metadata } : { output, metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (artifactDirectory) writeFileSync(join(artifactDirectory, 'error.txt'), message);
      return { error: message, metadata };
    } finally {
      workspace?.cleanup();
    }
  }
}
