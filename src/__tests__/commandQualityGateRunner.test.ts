import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatCommandGateFailure } from '../core/workflow/quality-gates/commandGateMessage.js';
import { runCommandQualityGate } from '../core/workflow/quality-gates/commandGateRunner.js';
import { runQualityGates } from '../core/workflow/quality-gates/qualityGateRunner.js';
import { makeStep } from './engine-test-helpers.js';

describe('command quality gates', () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'takt-command-gate-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should pass when the command exits with code 0', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'quality-check',
        command: 'node -e "process.stdout.write(\'ok\')"',
      },
      projectRoot,
    });

    expect(result.ok).toBe(true);
  });

  it('should fail with command, cwd, exit code, stdout, and stderr when the command exits non-zero', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'quality-check',
        command: 'node -e "console.log(\'out\'); console.error(\'err\'); process.exit(1)"',
        cwd: '.',
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'quality-check',
        type: 'command',
        command: 'node -e "console.log(\'out\'); console.error(\'err\'); process.exit(1)"',
        cwd: projectRoot,
        projectRoot,
        exitCode: 1,
        stdout: 'out\n',
        stderr: 'err\n',
        timedOut: false,
      });
      expect(result.failure.outputLogPath).toBeDefined();
      expect(existsSync(result.failure.outputLogPath!)).toBe(true);
      expect(readFileSync(result.failure.outputLogPath!, 'utf-8')).toContain('out\n');
    }
  });

  it('should execute relative cwd from the worktree project root', async () => {
    const projectRoot = createTempDir();
    mkdirSync(join(projectRoot, 'subdir'));
    const expectedCwd = realpathSync(join(projectRoot, 'subdir'));

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'pwd-check',
        command: 'node -e "process.stdout.write(process.cwd())"',
        cwd: 'subdir',
      },
      projectRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      stdout: expectedCwd,
    });
  });

  it('should allow cwd inside the project root', async () => {
    const projectRoot = createTempDir();
    mkdirSync(join(projectRoot, 'checks'));

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'inside-cwd-check',
        command: 'node -e "process.stdout.write(\'inside\')"',
        cwd: 'checks',
      },
      projectRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      stdout: 'inside',
    });
  });

  it('should execute absolute cwd inside the project root', async () => {
    const projectRoot = createTempDir();
    const checksDir = join(projectRoot, 'checks');
    mkdirSync(checksDir);
    const expectedCwd = realpathSync(checksDir);

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'absolute-cwd-check',
        command: 'node -e "process.stdout.write(process.cwd())"',
        cwd: checksDir,
      },
      projectRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      stdout: expectedCwd,
    });
  });

  it('should reject cwd that resolves through a project symlink to outside the project root', async () => {
    const projectRoot = createTempDir();
    const outsideDir = createTempDir();
    symlinkSync(outsideDir, join(projectRoot, 'external-link'), 'dir');

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'external-symlink-cwd-check',
        command: 'node -e "process.stdout.write(\'should-not-run\')"',
        cwd: 'external-link',
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'external-symlink-cwd-check',
        cwd: join(projectRoot, 'external-link'),
        projectRoot,
        timedOut: false,
      });
      expect(result.failure.stderr).toContain('Command quality gate cwd must stay inside the project root');
      expect(result.failure.stdout).toBe('');
    }
  });

  it('should report timeout details when the command exceeds timeout_ms', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'slow-check',
        command: 'node -e "setTimeout(() => {}, 1000)"',
        timeoutMs: 50,
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'slow-check',
        type: 'command',
        command: 'node -e "setTimeout(() => {}, 1000)"',
        cwd: projectRoot,
        timedOut: true,
        timeoutMs: 50,
      });
      expect(result.failure.exitCode).toBeUndefined();
    }
  });

  it('should settle a timeout even when the command ignores SIGTERM', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'stubborn-check',
        command: 'node -e "process.on(\'SIGTERM\',()=>{}); setInterval(()=>{},1000)"',
        timeoutMs: 50,
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'stubborn-check',
        timedOut: true,
        timeoutMs: 50,
      });
      expect(result.failure.exitCode).toBeUndefined();
    }
  });

  it('should apply the default timeout when timeout_ms is omitted', async () => {
    vi.useFakeTimers();
    const projectRoot = createTempDir();

    const resultPromise = runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'default-timeout-check',
        command: 'node -e "process.on(\'SIGTERM\',()=>{}); setInterval(()=>{},1000)"',
      },
      projectRoot,
    });

    await vi.advanceTimersByTimeAsync(300_100);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'default-timeout-check',
        timedOut: true,
        timeoutMs: 300_000,
      });
      expect(result.failure.exitCode).toBeUndefined();
    }
  });

  it('should fail and stop the command when stdout exceeds the output byte limit', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'noisy-check',
        command: 'node -e "process.stdout.write(\'x\'.repeat(70000)); setInterval(()=>{},1000)"',
        timeoutMs: 1000,
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'noisy-check',
        outputLimitExceeded: true,
        outputLimitBytes: 65536,
      });
      expect(result.failure.stdout.length).toBeLessThan(66000);
      expect(result.failure.stdout).toContain('[OUTPUT TRUNCATED: exceeded 65536 bytes]');
      expect(result.failure.outputLogPath).toBeDefined();
      expect(existsSync(result.failure.outputLogPath!)).toBe(true);
    }
  });

  it('should fail and stop the command when stderr exceeds the output byte limit', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'noisy-stderr-check',
        command: 'node -e "process.stderr.write(\'x\'.repeat(70000)); setInterval(()=>{},1000)"',
        timeoutMs: 1000,
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'noisy-stderr-check',
        outputLimitExceeded: true,
        outputLimitBytes: 65536,
      });
      expect(result.failure.stderr.length).toBeLessThan(66000);
      expect(result.failure.stderr).toContain('[OUTPUT TRUNCATED: exceeded 65536 bytes]');
      expect(result.failure.outputLogPath).toBeDefined();
      expect(existsSync(result.failure.outputLogPath!)).toBe(true);
    }
  });

  it('should fail and stop the command when stdout and stderr exceed the combined output byte limit', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'combined-noisy-check',
        command: 'node -e "process.stdout.write(\'o\'.repeat(40000)); process.stderr.write(\'e\'.repeat(40000)); setInterval(()=>{},1000)"',
        timeoutMs: 1000,
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        gateName: 'combined-noisy-check',
        outputLimitExceeded: true,
        outputLimitBytes: 65536,
        timedOut: false,
      });
      expect(result.failure.stdout.length + result.failure.stderr.length).toBeLessThan(67000);
      expect(`${result.failure.stdout}${result.failure.stderr}`).toContain('[OUTPUT TRUNCATED: exceeded 65536 bytes]');
      expect(result.failure.outputLogPath).toBeDefined();
      expect(existsSync(result.failure.outputLogPath!)).toBe(true);
    }
  });

  it('should pass when stdout and stderr reach the combined output byte limit exactly', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'combined-boundary-check',
        command: 'node -e "process.stdout.write(\'o\'.repeat(32768)); process.stderr.write(\'e\'.repeat(32768))"',
        timeoutMs: 1000,
      },
      projectRoot,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.length + result.stderr.length).toBe(65536);
      expect(`${result.stdout}${result.stderr}`).not.toContain('[OUTPUT TRUNCATED: exceeded 65536 bytes]');
    }
  });

  it('should not expose command secrets in unnamed command gate log paths or failure messages', async () => {
    const projectRoot = createTempDir();

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        command: 'node -e "process.stdout.write(\'api_key=top-secret\'); process.stderr.write(\'password=hunter2\'); process.exit(1)" -- --token top-secret --api-key other-secret',
      },
      projectRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outputLogPath).toBeDefined();
      expect(result.failure.outputLogPath).not.toContain('top-secret');
      expect(result.failure.outputLogPath).not.toContain('token-top-secret');
      expect(existsSync(result.failure.outputLogPath!)).toBe(true);

      const outputLog = readFileSync(result.failure.outputLogPath!, 'utf-8');
      expect(outputLog).toContain('Command: [REDACTED]');
      expect(outputLog).toContain('api_key=[REDACTED]');
      expect(outputLog).toContain('password=[REDACTED]');
      expect(outputLog).not.toContain('top-secret');
      expect(outputLog).not.toContain('other-secret');
      expect(outputLog).not.toContain('hunter2');
      expect(outputLog).not.toContain('--token top-secret');
      expect(outputLog).not.toContain('--api-key other-secret');

      const message = formatCommandGateFailure(result.failure);
      expect(message).toContain('Output log: .takt/quality-gates/logs/');
      expect(message).not.toContain('top-secret');
      expect(message).not.toContain('other-secret');
      expect(message).not.toContain('token-top-secret');
      expect(message).not.toContain('hunter2');
    }
  });

  it('should not expose non-allowlisted environment variables to command gates', async () => {
    const projectRoot = createTempDir();
    const originalSecret = process.env.TAKT_COMMAND_GATE_SECRET_TOKEN;
    process.env.TAKT_COMMAND_GATE_SECRET_TOKEN = 'secret-from-env';

    try {
      const result = await runCommandQualityGate({
        gate: {
          type: 'command',
          name: 'env-check',
          command: 'node -e "process.stdout.write(process.env.TAKT_COMMAND_GATE_SECRET_TOKEN || \'missing\')"',
        },
        projectRoot,
      });

      expect(result).toMatchObject({
        ok: true,
        stdout: 'missing',
      });
    } finally {
      if (originalSecret === undefined) {
        delete process.env.TAKT_COMMAND_GATE_SECRET_TOKEN;
      } else {
        process.env.TAKT_COMMAND_GATE_SECRET_TOKEN = originalSecret;
      }
    }
  });

  it('Given run-local child process env and unrelated secrets, When command gate runs, Then excludes credential-bearing OTEL env', async () => {
    const projectRoot = createTempDir();
    const envKeys = [
      'TAKT_OBSERVABILITY',
      'TAKT_OBSERVABILITY_ENABLED',
      'TAKT_OBSERVABILITY_MONITOR',
      'TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER',
      'TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
      'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
      'OTEL_EXPORTER_OTLP_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_CLIENT_KEY',
      'TAKT_COMMAND_GATE_SECRET_TOKEN',
    ] as const;
    const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.TAKT_OBSERVABILITY_ENABLED = 'true';
    process.env.TAKT_OBSERVABILITY_MONITOR = 'true';
    process.env.TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER = 'true';
    process.env.TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.example:4318';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://otel.example:4318/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://otel.example:4318/v1/metrics';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20ambient';
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = '3000';
    process.env.OTEL_EXPORTER_OTLP_METRICS_COMPRESSION = 'none';
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = '/ambient/root.pem';
    process.env.OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE = '/ambient/client.pem';
    process.env.OTEL_EXPORTER_OTLP_CLIENT_KEY = '/ambient/client.key';
    process.env.TAKT_COMMAND_GATE_SECRET_TOKEN = 'secret-from-env';
    writeFileSync(
      join(projectRoot, 'env-check.cjs'),
      [
        'const keys = [',
        '  "TAKT_OBSERVABILITY",',
        '  "TAKT_OBSERVABILITY_ENABLED",',
        '  "TAKT_OBSERVABILITY_MONITOR",',
        '  "TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER",',
        '  "TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE",',
        '  "OTEL_EXPORTER_OTLP_ENDPOINT",',
        '  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",',
        '  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",',
        '  "OTEL_EXPORTER_OTLP_HEADERS",',
        '  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",',
        '  "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION",',
        '  "OTEL_EXPORTER_OTLP_CERTIFICATE",',
        '  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",',
        '  "OTEL_EXPORTER_OTLP_CLIENT_KEY",',
        '  "TAKT_COMMAND_GATE_SECRET_TOKEN",',
        '];',
        'process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));',
      ].join('\n'),
      'utf-8',
    );

    try {
      const result = await runCommandQualityGate({
        gate: {
          type: 'command',
          name: 'env-check',
          command: 'node ./env-check.cjs',
        },
        projectRoot,
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true,"monitor":true,"session_log_exporter":true,"usage_events_phase":true}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-otel.example:4318',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://snapshot-otel.example:4318/v1/traces',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://snapshot-otel.example:4318/v1/metrics',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20snapshot',
          OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '12000',
          OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: 'gzip',
          OTEL_EXPORTER_OTLP_CERTIFICATE: '/snapshot/root.pem',
          OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: '/snapshot/client.pem',
          OTEL_EXPORTER_OTLP_CLIENT_KEY: '/snapshot/client.key',
          TAKT_COMMAND_GATE_SECRET_TOKEN: 'secret-from-overlay',
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('Command gate unexpectedly failed');
      }
      expect(JSON.parse(result.stdout)).toEqual({
        TAKT_OBSERVABILITY: '{"enabled":true,"monitor":true,"session_log_exporter":true,"usage_events_phase":true}',
        TAKT_OBSERVABILITY_ENABLED: null,
        TAKT_OBSERVABILITY_MONITOR: null,
        TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER: null,
        TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE: null,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-otel.example:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://snapshot-otel.example:4318/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://snapshot-otel.example:4318/v1/metrics',
        OTEL_EXPORTER_OTLP_HEADERS: null,
        OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '12000',
        OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: 'gzip',
        OTEL_EXPORTER_OTLP_CERTIFICATE: '/snapshot/root.pem',
        OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: null,
        OTEL_EXPORTER_OTLP_CLIENT_KEY: null,
        TAKT_COMMAND_GATE_SECRET_TOKEN: null,
      });
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('Given unsafe OTLP endpoints in child process env, When command gate runs, Then does not expose them', async () => {
    const projectRoot = createTempDir();
    writeFileSync(
      join(projectRoot, 'endpoint-check.cjs'),
      [
        'const keys = [',
        '  "OTEL_EXPORTER_OTLP_ENDPOINT",',
        '  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",',
        '  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",',
        '  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",',
        '];',
        'process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));',
      ].join('\n'),
      'utf-8',
    );

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'endpoint-check',
        command: 'node ./endpoint-check.cjs',
      },
      projectRoot,
      childProcessEnv: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test/v1?token=top-secret',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://user:pass@collector.example.test/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://collector.example.test/v1/metrics#top-secret',
        OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '12000',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Command gate unexpectedly failed');
    }
    expect(JSON.parse(result.stdout)).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '12000',
    });
  });

  it('should run command gates in definition order and stop after the first failure', async () => {
    const projectRoot = createTempDir();
    const logPath = join(projectRoot, 'gate.log');

    const result = await runQualityGates({
      qualityGates: [
        'AI-only gate',
        {
          type: 'command',
          name: 'first',
          command: `node -e "require('fs').appendFileSync('${logPath}', 'first\\n')"`,
        },
        {
          type: 'command',
          name: 'second',
          command: `node -e "require('fs').appendFileSync('${logPath}', 'second\\n'); process.exit(1)"`,
        },
        {
          type: 'command',
          name: 'third',
          command: `node -e "require('fs').appendFileSync('${logPath}', 'third\\n')"`,
        },
      ],
      projectRoot,
      step: makeStep('implement'),
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(logPath, 'utf-8')).toBe('first\nsecond\n');
    if (!result.ok) {
      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('Quality gate failed: second');
      expect(result.response.content).toContain('Command:');
      expect(result.response.content).toContain('Exit code: 1');
    }
  });

  it('should keep shell script paths executable through the configured command string', async () => {
    const projectRoot = createTempDir();
    mkdirSync(join(projectRoot, '.takt', 'quality-gates'), { recursive: true });
    const scriptPath = join(projectRoot, '.takt', 'quality-gates', 'check.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nprintf script-ok\n', { encoding: 'utf-8', mode: 0o755 });

    const result = await runCommandQualityGate({
      gate: {
        type: 'command',
        name: 'script-check',
        command: './.takt/quality-gates/check.sh',
      },
      projectRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      stdout: 'script-ok',
    });
  });

  it('should format sanitized command output for AI feedback', () => {
    const projectRoot = createTempDir();
    const outputLogPath = join(projectRoot, '.takt', 'quality-gates', 'logs', 'quality-check.log');
    const message = formatCommandGateFailure({
      gateName: 'quality-check',
      type: 'command',
      command: './.takt/quality-gates/check.sh',
      cwd: projectRoot,
      projectRoot,
      exitCode: 1,
      stdout: 'unit failed\n',
      stderr: 'lint failed\n',
      timedOut: false,
      outputLogPath,
    });

    expect(message).toContain('Quality gate failed: quality-check');
    expect(message).toContain('Type: command');
    expect(message).toContain('Command: ./.takt/quality-gates/check.sh');
    expect(message).toContain('Cwd: .');
    expect(message).toContain('Exit code: 1');
    expect(message).toContain('Output log: .takt/quality-gates/logs/quality-check.log');
    expect(message).toContain('Stdout:\nunit failed');
    expect(message).toContain('Stderr:\nlint failed');
  });

  it('should redact command gate metadata before it is sent to the agent', () => {
    const projectRoot = createTempDir();
    const secretOutput = [
      `cwd=${projectRoot}`,
      'Authorization: Bearer sk-abcdef12345678',
      'api_key=top-secret',
      'x'.repeat(4_100),
    ].join('\n');

    const message = formatCommandGateFailure({
      gateName: 'leaky-check',
      type: 'command',
      command: `node ${projectRoot}/scripts/check.js?token=top-secret`,
      cwd: join(projectRoot, 'subdir'),
      projectRoot,
      exitCode: 1,
      stdout: secretOutput,
      stderr: 'password=hunter2',
      timedOut: false,
    });

    expect(message).toContain('<project-root>');
    expect(message).toContain('token=[REDACTED]');
    expect(message).toContain('Authorization: Bearer [REDACTED]');
    expect(message).toContain('api_key=[REDACTED]');
    expect(message).toContain('password=[REDACTED]');
    expect(message).toContain('[TRUNCATED ');
    expect(message).not.toContain(projectRoot);
    expect(message).not.toContain('top-secret');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('sk-abcdef12345678');
  });

  it('should redact space-separated secret CLI arguments before AI feedback', () => {
    const projectRoot = createTempDir();

    const message = formatCommandGateFailure({
      gateName: 'leaky-cli-check --api-key other-secret',
      type: 'command',
      command: './check.sh --token top-secret --password hunter2',
      cwd: projectRoot,
      projectRoot,
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    expect(message).toContain('--token [REDACTED]');
    expect(message).toContain('--api-key [REDACTED]');
    expect(message).toContain('--password [REDACTED]');
    expect(message).not.toContain('top-secret');
    expect(message).not.toContain('other-secret');
    expect(message).not.toContain('hunter2');
  });

});
