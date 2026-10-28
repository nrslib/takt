import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function phaseEnvironment(source) {
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

export function buildPhaseInvocation(config, call, helpers, artifactDir, env) {
  const { systemPrompt, instruction, options } = call;
  if (config.cli === 'codex') {
    const skillConfig = helpers.buildCodexSkillConfig({ cwd: options.cwd, env, inheritance: { repo: false, user: false } });
    const skillEntries = skillConfig?.skills?.config;
    const args = ['exec', ...(options.sessionId ? ['resume', options.sessionId] : []),
      '--json', '--skip-git-repo-check', '-m', config.model,
      '-c', `model_reasoning_effort=${JSON.stringify(config.reasoning_effort)}`,
      '-c', `sandbox_mode=${JSON.stringify(options.permissionMode === 'edit' ? 'workspace-write' : 'read-only')}`,
      '-c', 'approval_policy="never"',
      ...(skillEntries ? ['-c', `skills.config=[${skillEntries.map((item) => `{ path = ${JSON.stringify(item.path)}, enabled = false }`).join(', ')}]`] : []),
    ];
    if (options.outputSchema) {
      const path = join(artifactDir, 'schema.json');
      writeFileSync(path, JSON.stringify(options.outputSchema, null, 2));
      args.push('--output-schema', path);
    }
    args.push('-');
    return { command: 'codex', args, input: systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction, toolsDisabled: false };
  }
  if (config.cli !== 'claude') throw new Error(`Unsupported CLI: ${config.cli}`);
  const sdk = helpers.buildSdkOptions({ ...options, systemPrompt });
  const args = ['-p', '--model', config.model, '--output-format', 'stream-json', '--verbose',
    ...(sdk.systemPrompt ? ['--system-prompt', sdk.systemPrompt] : []),
    '--setting-sources', sdk.settingSources.join(','),
    '--permission-mode', sdk.permissionMode,
    // No interactive permission responder exists in a print-mode eval.
    '--permission-prompts', 'none',
    ...(options.sessionId ? ['--resume', options.sessionId] : ['--session-id', randomUUID()]),
  ];
  if (sdk.allowedTools !== undefined) args.push('--allowed-tools', sdk.allowedTools.join(','));
  if (sdk.tools !== undefined) args.push('--tools', sdk.tools.join(','));
  if (sdk.maxTurns !== undefined) args.push('--max-turns', String(sdk.maxTurns));
  if (sdk.outputFormat) args.push('--json-schema', JSON.stringify(sdk.outputFormat.schema));
  if (sdk.strictMcpConfig) args.push('--strict-mcp-config');
  return { command: 'claude', args, input: instruction, toolsDisabled: sdk.tools?.length === 0 };
}

export async function capturePhaseProcess(invocation, { cwd, env, timeoutMs, artifactDir, abortSignal }) {
  abortSignal?.throwIfAborted();
  const stdout = [];
  const stderr = [];
  let failure;
  let killTimer;
  const child = spawn(invocation.command, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const stop = () => {
    if (child.pid === undefined || killTimer !== undefined) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 5000);
  };
  const timer = setTimeout(() => { failure = new Error('CLI timeout'); stop(); }, timeoutMs);
  const abort = () => { failure = new Error('CLI aborted'); stop(); };
  abortSignal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.on('error', (error) => { failure = error; stop(); });
  try {
    const exit = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(invocation.input);
    const status = await exit;
    const raw = Buffer.concat(stdout).toString('utf8');
    writeFileSync(join(artifactDir, 'events.jsonl'), raw);
    writeFileSync(join(artifactDir, 'stderr.txt'), Buffer.concat(stderr));
    writeFileSync(join(artifactDir, 'exit.json'), JSON.stringify(status));
    if (failure) throw failure;
    if (status.code !== 0) throw new Error(`CLI exited ${status.code}: ${Buffer.concat(stderr).toString('utf8').slice(-1500)}`);
    return raw;
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    abortSignal?.removeEventListener('abort', abort);
  }
}
