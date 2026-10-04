import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callCodex } from '../../dist/infra/codex/index.js';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default class TaktCodexProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.label = options.label;
  }

  id() {
    return 'takt:codex';
  }

  async callApi(prompt, _context, options = {}) {
    const workingDirectory = resolve(evalDirectory, this.config.working_dir);
    const response = await callCodex('prompt-eval', prompt, {
      cwd: workingDirectory,
      abortSignal: options.abortSignal,
      permissionMode: this.config.permission_mode ?? 'readonly',
      reasoningEffort: this.config.model_reasoning_effort,
      skills: { repo: false, user: false },
    });

    if (response.error) {
      return { error: response.error };
    }

    return {
      output: response.content,
      metadata: response.sessionId ? { sessionId: response.sessionId } : undefined,
    };
  }
}
