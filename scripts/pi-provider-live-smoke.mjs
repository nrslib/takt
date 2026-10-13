#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'openai-codex/gpt-6.1-sol';
const TIMEOUT_MS = 120_000;

/** Counts both SDK requests and HTTP submissions; rejects before sending extras. */
export function createSmokeBudget() {
  let turn = 0;
  let requests = 0;
  let submissions = 0;
  let turnRequests = 0;
  let turnSubmissions = 0;
  return {
    /** Starts one authorized turn and resets only its per-turn counters. */
    beginTurn() {
      assert.ok(turn < 2, 'Smoke is limited to two turns');
      turn += 1;
      turnRequests = 0;
      turnSubmissions = 0;
    },
    /** Rejects extra inference or deviations from the authorized model/options. */
    request(model, options) {
      assert.ok(turn > 0 && turn <= 2);
      assert.equal(`${model.provider}/${model.id}`, MODEL);
      assert.equal(model.api, 'openai-codex-responses');
      assert.equal(options.maxRetries, 0);
      assert.equal(options.transport, 'sse');
      assert.equal(options.reasoning, 'high');
      assert.equal(options.timeoutMs, TIMEOUT_MS);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      assert.ok(turnRequests < 1 && requests < 2, 'Additional SDK inference request blocked');
      turnRequests += 1;
      requests += 1;
    },
    /** Allows one Codex HTTP submission per already-counted SDK request. */
    submit(url) {
      assert.equal(new URL(url).href, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(turnRequests, 1);
      assert.ok(turnSubmissions < 1 && submissions < 2, 'Additional HTTP inference request blocked');
      turnSubmissions += 1;
      submissions += 1;
    },
    /** Reports consumed counters without changing the request budget. */
    counts() { return { requests, submissions }; },
  };
}

/** Check protected files without letting inspection errors skip cleanup. */
export async function verifySmokeFilesAndCleanup({ root, agentDir, files, before }, io = { readFile, rm }) {
  const errors = [];
  for (const file of files) {
    let after;
    try {
      const bytes = await io.readFile(join(agentDir, file));
      after = createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        errors.push(`${file} could not be verified`);
        continue;
      }
    }
    if (after !== before.get(file)) errors.push(`${file} must not be modified`);
  }
  try {
    await io.rm(root, { recursive: true, force: true });
  } catch {
    errors.push('Smoke temporary directory cleanup failed');
  }
  return errors;
}

// Importing the budget for unit tests must never start a live inference.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { AgentSession, getAgentDir, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const budget = createSmokeBudget();
  const root = await mkdtemp(join(tmpdir(), 'takt-pi-live-'));
  const agentDir = getAgentDir();
  const files = ['auth.json', 'models.json', 'models-store.json', 'settings.json'];
  const before = new Map();
  const originalSettings = SettingsManager.inMemory;
  const originalStream = ModelRuntime.prototype.streamSimple;
  const originalBind = AgentSession.prototype.bindExtensions;
  const sessions = [];
  let turnSignal;
  let watchdog;
  let stage = 'preflight';
  try {
    for (const file of files) {
      try {
        const bytes = await readFile(join(agentDir, file));
        before.set(file, createHash('sha256').update(bytes).digest('hex'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        before.set(file, undefined);
      }
    }
    // These overrides exist only in this explicitly invoked process. No user
    // settings are read or written, and normal TAKT defaults are unaffected.
    SettingsManager.inMemory = function (settings, options) {
      const manager = originalSettings.call(this, {
        ...settings,
        transport: 'sse',
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: TIMEOUT_MS } },
        compaction: { enabled: false },
        cacheWarming: 'off',
      }, options);
      assert.equal(manager.getRetrySettings().enabled, false);
      assert.equal(manager.getProviderRetrySettings().maxRetries, 0);
      assert.equal(manager.getCompactionSettings().enabled, false);
      assert.equal(manager.getCacheWarmingMode(), 'off');
      assert.equal(manager.getTransport(), 'sse');
      return manager;
    };
    AgentSession.prototype.bindExtensions = async function (options) {
      assert.equal(this.sessionManager.isPersisted(), false);
      sessions.push(this);
      const result = await originalBind.call(this, options);
      for (const tool of this.getAllTools()) {
        if (tool.name === 'codemode') {
          // TAKT always registers its named factory, even with noExtensions.
          // Registration does not grant execution; the inference guard below
          // still requires an empty active-tool list for this smoke.
          assert.equal(tool.sourceInfo.source, 'inline');
          assert.equal(tool.sourceInfo.path, '<inline:codemode>');
        } else {
          assert.ok(tool.sourceInfo.source === 'builtin' || tool.name === 'bash');
        }
      }
      return result;
    };
    ModelRuntime.prototype.streamSimple = function (model, context, options) {
      budget.request(model, options);
      assert.ok(turnSignal instanceof AbortSignal);
      assert.equal(sessions.at(-1).getActiveToolNames().length, 0);
      stage = 'inference';
      return originalStream.call(this, model, context, {
        ...options,
        maxTokens: 64,
        signal: AbortSignal.any([options.signal, turnSignal]),
        fetch: async (url, init) => {
          budget.submit(url);
          return fetch(url, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([init.signal, turnSignal]),
          });
        },
      });
    };
    const versions = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    for (const name of ['pi-ai', 'pi-coding-agent']) {
      assert.equal(versions.packages[`node_modules/@earendil-works/${name}`].version, '1.1.0');
    }
    const { PiProvider } = await import('../dist/infra/providers/pi.js');
    const agent = new PiProvider().setup({ name: 'pi-live-smoke' });
    const probe = `takt-probe-${randomUUID()}`;
    const prompts = [
      `Remember this nonsecret probe: ${probe}. Reply only with that probe.`,
      'Reply only with the probe from the previous user message.',
    ];
    let sessionId;
    for (const [index, prompt] of prompts.entries()) {
      budget.beginTurn();
      const controller = new AbortController();
      turnSignal = controller.signal;
      const deadline = setTimeout(() => controller.abort(new Error('Smoke turn deadline exceeded')), TIMEOUT_MS);
      // Hard deadline also covers SDK setup/abort cleanup that ignores signals.
      watchdog = setTimeout(() => {
        console.error(JSON.stringify({ status: 'error', reason: 'Smoke turn deadline exceeded', ...budget.counts() }));
        for (const session of sessions) session.dispose();
        rmSync(root, { recursive: true, force: true });
        process.exit(1);
      }, TIMEOUT_MS);
      try {
        const response = await agent.call(prompt, {
          cwd: root, sessionId, model: MODEL, allowedTools: [], permissionMode: 'readonly',
          abortSignal: turnSignal,
          providerOptions: { pi: {
            thinkingLevel: 'high', noExtensions: true, noSkills: true,
            noPromptTemplates: true, noThemes: true, noContextFiles: true,
          } },
        });
        assert.equal(response.status, 'done', response.error);
        assert.equal(response.content.trim(), probe);
        assert.ok(response.sessionId);
        if (sessionId !== undefined) assert.equal(response.sessionId, sessionId);
        sessionId = response.sessionId;
        console.log(JSON.stringify({ turn: index + 1, status: response.status, response: response.content.trim(), sessionId, ...budget.counts() }));
      } finally {
        clearTimeout(deadline);
        clearTimeout(watchdog);
      }
    }
    assert.deepEqual(budget.counts(), { requests: 2, submissions: 2 });
    assert.deepEqual(await readdir(root), []);
    console.log(JSON.stringify({ status: 'done', model: MODEL, thinkingLevel: 'high', retry: false, transport: 'sse', timeoutMs: TIMEOUT_MS, ...budget.counts() }));
  } catch (error) {
    // Provider errors returned by TAKT are sanitized. Never serialize SDK
    // request options, credentials, or arbitrary exception objects.
    console.error(JSON.stringify({ status: stage === 'preflight' ? 'blocked' : 'error', reason: error.message, ...budget.counts() }));
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    for (const session of sessions) session.dispose();
    SettingsManager.inMemory = originalSettings;
    ModelRuntime.prototype.streamSimple = originalStream;
    AgentSession.prototype.bindExtensions = originalBind;
    const errors = await verifySmokeFilesAndCleanup({ root, agentDir, files, before });
    if (errors.length > 0) {
      console.error(JSON.stringify({ status: 'error', reason: errors.join('; '), ...budget.counts() }));
      process.exitCode = 1;
    }
  }
}
