import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareIsolatedProbeEnvironment } from './probe-environment.mjs';
import { parseProbeResult } from './probe-process.mjs';
import { runSmokeBatch, runSmokeScript } from './smoke-process.mjs';
import { withProbeWorkspace } from './probe-workspace.mjs';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'takt-prompt-eval-smoke-'));
const occupiedPort = createNetServer();
const SMOKE_SCRIPT_TIMEOUT_MS = 240_000;

async function occupyLegacyFixedPort() {
  await new Promise((resolveListen, reject) => {
    occupiedPort.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolveListen();
        return;
      }
      reject(error);
    });
    occupiedPort.listen(4096, '127.0.0.1', resolveListen);
  });
}

async function runScript(script, args = []) {
  return withProbeWorkspace(root, 'runtime-', (runtimeRoot) => {
    const isolatedEnvironment = prepareIsolatedProbeEnvironment(process.env, runtimeRoot);
    return runSmokeScript(resolve(script), args, isolatedEnvironment, {
      timeoutMs: SMOKE_SCRIPT_TIMEOUT_MS,
    });
  });
}

async function verifyDirectPluginProbe() {
  const { stdout } = await withProbeWorkspace(root, 'direct-runtime-', (runtimeRoot) => (
    runSmokeScript(
      resolve('prompt-evals/plugin-probe.mjs'),
      ['--plugin', 'none'],
      prepareIsolatedProbeEnvironment(process.env, runtimeRoot),
      { timeoutMs: SMOKE_SCRIPT_TIMEOUT_MS },
    )
  ));
  const result = parseProbeResult(stdout);
  if (result.mode !== 'none') {
    throw new Error(`Direct plugin probe returned mode ${String(result.mode)}`);
  }
  assertWorkspaceRemoved(result);
}

async function runCapture(needle) {
  return withProbeWorkspace(root, 'capture-', (workspace) => (
    runScript('prompt-evals/sdk-prompt-capture.mjs', [
      '--cwd', workspace,
      '--taktPrompt', resolve('prompt-evals/prompts/round1.txt'),
      '--needle', needle,
    ])
  ));
}

function assertWorkspaceRemoved(result) {
  if (typeof result.workspace !== 'string' || existsSync(result.workspace)) {
    throw new Error(`Probe workspace was not removed: ${String(result.workspace)}`);
  }
}

async function verifyPluginMode(mode, iteration) {
  let result;
  await withProbeWorkspace(root, `plugin-${mode}-${iteration}-`, async (workspace) => {
    const { stdout } = await runScript('prompt-evals/plugin-probe.mjs', [
      '--plugin', mode,
      '--cwd', workspace,
    ]);
    result = parseProbeResult(stdout);
    if (result.workspace !== workspace) {
      throw new Error(`Plugin probe used unexpected workspace ${String(result.workspace)}`);
    }
    if (result.mode !== mode) {
      throw new Error(`Plugin probe returned mode ${String(result.mode)} for ${mode}`);
    }
    const expectedStatus = mode === 'before' ? 'completed' : 'error';
    if (!result.terminalStatuses.includes(expectedStatus)) {
      throw new Error(`Plugin ${mode} did not observe ${expectedStatus}: ${stdout}`);
    }
    if (mode !== 'none' && result.hookFired !== true) {
      throw new Error(`Plugin ${mode} hook did not fire: ${stdout}`);
    }
  });
  if (result === undefined) {
    throw new Error(`Plugin ${mode} did not produce a result`);
  }
  assertWorkspaceRemoved(result);
}

async function verifySummarizeProbe() {
  const { stdout } = await runScript('prompt-evals/summarize-probe.mjs');
  const result = parseProbeResult(stdout);
  assertWorkspaceRemoved(result);
  if (!Number.isInteger(result.summaryCount) || result.summaryCount < 1) {
    throw new Error(`Summarize probe did not create a summary: ${stdout}`);
  }
}

async function verifySdkToolCleanupProbe() {
  let result;
  await withProbeWorkspace(root, 'sdk-tool-cleanup-', async (workspace) => {
    const outPath = join(workspace, 'cleanup-result.json');
    const { stdout } = await runScript('prompt-evals/sdk-tool-eval.mjs', [
      '--cleanupProbe', 'true',
      '--cwd', workspace,
      '--out', outPath,
    ]);
    result = parseProbeResult(stdout);
    const output = JSON.parse(readFileSync(outPath, 'utf8'));
    if (result.workspace !== workspace || output.cleanupProbe !== true) {
      throw new Error(`SDK tool cleanup probe returned an invalid result: ${stdout}`);
    }
  });
  if (result === undefined) {
    throw new Error('SDK tool cleanup probe did not produce a result');
  }
  assertWorkspaceRemoved(result);
}

async function verifySdkToolNormalProbe() {
  let expectedToolPath;
  let providerMode = 'success';
  let toolTurn = 0;
  const provider = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const streaming = /"stream"\s*:\s*true/.test(body);
      const isTitle = body.includes('title generator');
      const emitTool = providerMode !== 'zero' && !isTitle && ++toolTurn === 1;
      if (emitTool && expectedToolPath === undefined) {
        throw new Error('SDK tool fake provider received a request before the tool target was prepared');
      }
      const toolCall = {
        id: 'call_sdk_tool_probe',
        type: 'function',
        function: {
          name: 'read',
          arguments: JSON.stringify({
            filePath: expectedToolPath,
            ...(providerMode === 'error' ? { offset: 'not-a-number' } : {}),
          }),
        },
      };
      if (!streaming) {
        const message = emitTool
          ? { role: 'assistant', content: null, tool_calls: [toolCall] }
          : { role: 'assistant', content: 'done' };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'probe', object: 'chat.completion', created: Date.now(), model: 'probe',
          choices: [{ index: 0, message, finish_reason: emitTool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: 'probe', object: 'chat.completion.chunk', created: Date.now(), model: 'probe',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      if (emitTool) {
        send({
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.function.name, arguments: '' },
          }],
        });
        send({ tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }] });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: 'done' });
        send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolveListen, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolveListen);
  });
  const address = provider.address();
  if (address === null || typeof address === 'string') {
    throw new Error('SDK tool fake provider did not expose a TCP port');
  }

  try {
    const runEvaluation = async (mode) => {
      providerMode = mode;
      toolTurn = 0;
      return withProbeWorkspace(root, `sdk-tool-${mode}-`, async (workspace) => {
        const outPath = join(workspace, 'normal-result.json');
        const promptPath = join(workspace, 'tool-prompt.txt');
        expectedToolPath = join(workspace, 'tool-target.txt');
        writeFileSync(promptPath, 'Read tool-target.txt with the read tool, then report completion.\n', 'utf8');
        writeFileSync(expectedToolPath, 'SDK_TOOL_PROBE_CONTENT\n', 'utf8');
        const { stdout } = await runScript('prompt-evals/sdk-tool-eval.mjs', [
          '--model', 'probe/probe',
          '--providerBaseUrl', `http://127.0.0.1:${address.port}/v1`,
          '--prompt', promptPath,
          '--cwd', workspace,
          '--out', outPath,
        ]);
        const result = parseProbeResult(stdout);
        const output = JSON.parse(readFileSync(outPath, 'utf8'));
        return { result, output, stdout, workspace };
      });
    };
    const expectEvaluationFailure = async (mode, expectedMessage) => {
      try {
        await runEvaluation(mode);
      } catch (error) {
        const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
        if (error.code === 1 && output.includes(expectedMessage)) {
          return;
        }
        throw error;
      }
      throw new Error(`SDK tool ${mode} probe unexpectedly succeeded`);
    };

    const { result, output, stdout, workspace } = await runEvaluation('success');
    const [call] = output.calls;
    if (
      result.workspace !== workspace
      || result.calls !== 1
      || output.model !== 'probe/probe'
      || output.calls.length !== 1
      || call.tool !== 'read'
      || call.status !== 'completed'
      || call.input?.filePath !== expectedToolPath
      || typeof call.output !== 'string'
      || !call.output.includes('SDK_TOOL_PROBE_CONTENT')
    ) {
      throw new Error(`SDK tool normal probe returned an invalid result: ${stdout}`);
    }
    await expectEvaluationFailure('zero', 'completed without observing a tool call');
    await expectEvaluationFailure('error', 'observed non-completed calls');
  } finally {
    await new Promise((resolveClose) => {
      provider.close(() => resolveClose());
      provider.closeAllConnections();
    });
  }
}

try {
  await occupyLegacyFixedPort();
  await runSmokeBatch([
    {
      name: 'prompt-capture',
      run: async () => {
        await runCapture('TAKT');
        try {
          await runCapture('MUST-NOT-EXIST-IN-PROMPT');
          throw new Error('Prompt capture unexpectedly accepted a missing needle');
        } catch (error) {
          const expectedMessage = 'No main prompt contained the required needle';
          const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
          if (error.code !== 1 || !output.includes(expectedMessage)) {
            throw error;
          }
        }
      },
    },
    { name: 'plugin-none-1', run: () => verifyPluginMode('none', 0) },
    { name: 'plugin-before-1', run: () => verifyPluginMode('before', 0) },
    { name: 'plugin-definition-1', run: () => verifyPluginMode('definition', 0) },
    { name: 'plugin-none-2', run: () => verifyPluginMode('none', 1) },
    { name: 'plugin-before-2', run: () => verifyPluginMode('before', 1) },
    { name: 'plugin-definition-2', run: () => verifyPluginMode('definition', 1) },
    { name: 'summarize', run: verifySummarizeProbe },
    { name: 'sdk-tool-normal', run: verifySdkToolNormalProbe },
    { name: 'sdk-tool-cleanup', run: verifySdkToolCleanupProbe },
    { name: 'plugin-direct', run: verifyDirectPluginProbe },
  ]);
} finally {
  await new Promise((resolveClose) => occupiedPort.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true });
}
