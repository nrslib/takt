import { sha256 } from './canonical-json.js';
import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type { RunSessionHandle } from './runtime-handles.js';

class BoundSessionCommands {
  readonly #binding: RuntimeBinding;

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  start(input: { readonly sessionKey: string }): RunSessionHandle {
    assertExactInput(input, ['sessionKey']);
    const sessionId = sha256([
      this.#binding.runId,
      this.#binding.scopeId,
      input.sessionKey,
    ].join('\0'));
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => {
        context.run(`
          INSERT INTO run_sessions (
            run_id, scope_id, session_id, session_key, started_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        this.#binding.runId,
        this.#binding.scopeId,
        sessionId,
        input.sessionKey,
        now);
      },
    );
    return this.#binding.handles.issueSession(this.#binding.scopeId, sessionId);
  }

  end(sessionHandle: RunSessionHandle): void {
    const session = this.#binding.handles.resolveSession(sessionHandle);
    if (session.scopeId !== this.#binding.scopeId) {
      throw new Error('Session handle cross-scope reference rejected');
    }
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => {
        const result = context.run(`
          UPDATE run_sessions
          SET ended_at = ?
          WHERE
            run_id = ?
            AND scope_id = ?
            AND session_id = ?
            AND ended_at IS NULL
        `, now, this.#binding.runId, this.#binding.scopeId, session.sessionId);
        if (Number(result.changes) !== 1) {
          throw new Error('Run session is missing or ended');
        }
      },
    );
  }
}

export type RuntimeSessionCommands = BoundSessionCommands;

export function createRuntimeSessionCommands(
  binding: RuntimeBinding,
): RuntimeSessionCommands {
  return new BoundSessionCommands(binding);
}
