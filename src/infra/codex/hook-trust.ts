import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isHookRecord, type CodexToolPermissionHookDefinition } from './tool-permission-hook-protocol.js';

const SESSION_HOOK_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';
const SESSION_HOOK_SOURCE_PATH = '/<session-flags>/config.toml';
const TRUST_TIMEOUT_MS = 10_000;

interface HookTrustCandidate extends CodexToolPermissionHookDefinition {
  key: string;
  currentHash: string;
}

export function selectCodexHookTrust(candidates: readonly HookTrustCandidate[], definition: CodexToolPermissionHookDefinition) {
  const match = candidates.find((candidate) => candidate.key === SESSION_HOOK_KEY
    && candidate.command === definition.command && candidate.matcher === definition.matcher
    && candidate.timeout === definition.timeout && candidate.currentHash.trim().length > 0);
  if (match === undefined) throw new Error('No matching session PreToolUse trust hash');
  return { key: match.key, trustedHash: match.currentHash };
}

function parseHookTrustCandidates(result: unknown, cwd: string): HookTrustCandidate[] {
  if (!isHookRecord(result) || !Array.isArray(result.data)) throw new Error('Invalid hooks/list response');
  const candidates: HookTrustCandidate[] = [];
  for (const entry of result.data) {
    if (!isHookRecord(entry) || entry.cwd !== cwd) continue;
    if (!Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length !== 0) {
      throw new Error('Invalid effective hook configuration');
    }
    for (const hook of entry.hooks) {
      if (!isHookRecord(hook) || hook.source !== 'sessionFlags' || hook.sourcePath !== SESSION_HOOK_SOURCE_PATH
        || hook.eventName !== 'preToolUse' || hook.handlerType !== 'command' || hook.enabled !== true || hook.async !== false) continue;
      if (typeof hook.key !== 'string' || typeof hook.command !== 'string' || typeof hook.matcher !== 'string'
        || typeof hook.timeoutSec !== 'number' || typeof hook.currentHash !== 'string') {
        throw new Error('Invalid session hook trust metadata');
      }
      candidates.push({ key: hook.key, command: hook.command, matcher: hook.matcher, timeout: hook.timeoutSec, currentHash: hook.currentHash });
    }
  }
  return candidates;
}

export async function resolveCodexHookTrust(input: {
  executablePath: string; cwd: string; env: Record<string, string>;
  definition: CodexToolPermissionHookDefinition; abortSignal?: AbortSignal;
}) {
  input.abortSignal?.throwIfAborted();
  const { command, matcher, timeout } = input.definition;
  const definitionOverride = `hooks.PreToolUse=[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`;
  const child = spawn(input.executablePath, [
    '-c', 'approval_policy="never"', '-c', 'features.hooks=true', '-c', definitionOverride, 'app-server',
  ], { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  // Drain diagnostics without exposing argv, environment or user configuration.
  child.stderr.resume();
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ReturnType<typeof selectCodexHookTrust>>((resolve, reject) => {
      const fail = () => reject(new Error('Failed to obtain Codex PreToolUse trust'));
      timer = setTimeout(fail, TRUST_TIMEOUT_MS);
      onAbort = fail;
      input.abortSignal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', fail);
      child.once('exit', fail);
      child.stdin.on('error', fail);
      lines.on('error', fail);
      let initialized = false;
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      lines.on('line', (line) => {
        try {
          const response: unknown = JSON.parse(line);
          if (!isHookRecord(response)) throw new Error('Invalid RPC response');
          if (response.id === 1 && !initialized) {
            if (response.error !== undefined || !isHookRecord(response.result)) throw new Error('Initialization failed');
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'hooks/list', params: { cwds: [input.cwd] } });
          } else if (response.id === 2) {
            if (!initialized || response.error !== undefined) throw new Error('Hook listing failed');
            resolve(selectCodexHookTrust(parseHookTrustCandidates(response.result, input.cwd), input.definition));
          }
        } catch { fail(); }
      });
      if (input.abortSignal?.aborted) { fail(); return; }
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'takt', version: '1' }, capabilities: { experimentalApi: true },
      } });
    });
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) input.abortSignal?.removeEventListener('abort', onAbort);
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      child.kill('SIGTERM');
      try { await closed; } finally { clearTimeout(killTimer); }
    } else {
      await closed;
    }
  }
}
