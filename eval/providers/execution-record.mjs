import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const recordings = new AsyncLocalStorage();
const STREAM_LIMIT = 16 * 1024 * 1024;

export function currentExecutionRecord() {
  return recordings.getStore();
}

function createRecord(root, identity, prompt) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(resolve(root), 'trial-'));
  const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(directory, 'prompt.md'), prompt, { mode: 0o600 });
  save('identity.json', identity);
  save('result.json', { status: 'running', startedAt: new Date().toISOString() });
  let processIndex = 0;
  let projectIndex = 0;
  return {
    directory,
    finish(response) {
      save('result.json', { status: response.error ? 'failed' : 'completed', finishedAt: new Date().toISOString(), response });
    },
    preserveProject(isolated) {
      const name = `project-${++projectIndex}`;
      const snapshotDirectory = join(directory, name);
      save(`${name}.json`, { cwd: isolated.cwd, snapshotDirectory });
      return {
        cwd: isolated.cwd,
        cleanup() {
          cpSync(isolated.cwd, snapshotDirectory, { recursive: true });
          isolated.cleanup();
        },
      };
    },
    beginProcess(invocation) {
      const prefix = `process-${++processIndex}`;
      const state = { ...invocation, startedAt: new Date().toISOString(), status: 'running', stdout: { bytes: 0, truncated: false }, stderr: { bytes: 0, truncated: false } };
      const update = () => save(`${prefix}.json`, state);
      for (const stream of ['stdout', 'stderr']) writeFileSync(join(directory, `${prefix}.${stream}`), '', { mode: 0o600 });
      update();
      return {
        chunk(stream, chunk) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = Math.max(0, STREAM_LIMIT - state[stream].bytes);
          appendFileSync(join(directory, `${prefix}.${stream}`), buffer.subarray(0, remaining));
          state[stream].bytes += buffer.length;
          state[stream].truncated ||= buffer.length > remaining;
          update();
        },
        finish(exit) {
          Object.assign(state, exit, { status: 'finished', finishedAt: new Date().toISOString() });
          update();
        },
      };
    },
  };
}

// Context-local ownership keeps concurrent cases, languages and repeats separate.
export function recordProviderCalls(provider, callApi) {
  return async function (prompt, context, options) {
    const root = process.env.TAKT_EVAL_RECORD_DIR;
    if (root === undefined) return callApi.call(provider, prompt, context, options);
    if (!root.trim()) throw new Error('TAKT_EVAL_RECORD_DIR must be a non-empty directory path');
    const record = createRecord(root, {
      provider: provider.id(), promptLabel: context?.prompt?.label,
      vars: context?.vars, repeatIndex: context?.repeatIndex,
      evaluationId: context?.evaluationId, testCaseId: context?.testCaseId,
      description: context?.test?.description,
    }, prompt);
    return recordings.run(record, async () => {
      let response;
      try {
        response = await callApi.call(provider, prompt, context, options);
      } catch (error) {
        response = { error: error instanceof Error ? error.message : String(error) };
      }
      response = { ...response, metadata: { ...response.metadata, execution_record: record.directory } };
      record.finish(response);
      return response;
    });
  };
}
