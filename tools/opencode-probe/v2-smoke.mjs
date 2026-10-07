import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureOwnedProbeEntrypoint } from './probe-entrypoint.mjs';
import { reportProbePhase } from './probe-process.mjs';
import { OpenCodeClient, resetSharedServer } from '../../dist/infra/opencode/client.js';
import { OpenCodeProvider } from '../../dist/infra/providers/opencode.js';
import { OptionsBuilder } from '../../dist/core/workflow/engine/OptionsBuilder.js';
import { runAgent } from '../../dist/agents/runner.js';
import { ProviderNeutralStructuredCaller } from '../../dist/agents/structured-caller.js';
import { runStatusJudgmentPhase } from '../../dist/core/workflow/status-judgment-phase.js';
import { normalizeRule } from '../../dist/infra/config/loaders/workflowRuleNormalizer.js';

await ensureOwnedProbeEntrypoint(import.meta.url);
const cli = process.argv[process.argv.indexOf('--cli') + 1];
if (!process.argv.includes('--cli') || !cli) throw new Error('Pass --cli /absolute/path/to/opencode-v2');
process.env.TAKT_OPENCODE_VERSION = 'v2';
process.env.TAKT_OPENCODE_PATH = resolve(cli);
process.env.OPENCODE_CONFIG_PROJECT_DISABLE = '1';
process.env.OPENCODE_DISABLE_MODELS_FETCH = '1';
const workspace = mkdtempSync(join(tmpdir(), 'takt-opencode-v2-'));
const target = join(workspace, 'target.txt');
writeFileSync(target, 'original');
const captures = [];
const contexts = [];
const counts = new Map();
let abortOnRequest;
const toolFor = (name, input) => {
  if (name === 'skill_repo' || name === 'skill_user' || name === 'skill_ask' || name === 'skill_deny' || name?.startsWith('skill_workflow_')) {
    const fixture = name === 'skill_user' ? 'probe-user' : 'probe-repo';
    const blocks = [...JSON.stringify(input).matchAll(/<id>([^<]+)<\/id>.*?<name>([^<]+)<\/name>/g)];
    const id = blocks.find((block) => block[2] === fixture)?.[1];
    return { name: 'skill', args: { id: id ?? 'probe-repo' } };
  }
  if (name === 'read') return { name: 'read', args: { path: target, offset: '1', limit: '10' } };
  if (name === 'write' || name === 'write_again' || name === 'denied') return { name: 'write', args: { path: target, content: name } };
  if (name === 'mcp' || name === 'mcp_auto') return { name: 'probe_echo', args: { text: 'MCP_OK' } };
  if (name === 'question') return { name: 'question', args: { questions: [{ header: 'Choice', question: 'Select one', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } };
};
const provider = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const input = JSON.parse(body);
    if (request.url === '/context') {
      contexts.push(input);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const lastUser = input.messages?.filter((message) => message.role === 'user').at(-1);
    const title = input.messages?.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('title generator'));
    const compact = body.includes('Do not include the <template> tags');
    const name = title || compact ? undefined : JSON.stringify(lastUser).match(/PROBE_CASE:([a-z_]+)/)?.[1];
    if (name) captures.push({ name, input });
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (name === 'abort') { abortOnRequest(); return; }
    const tool = count === 1 ? toolFor(name, input) : undefined;
    const status = body.includes('PROBE_CASE:skill_status');
    const content = compact ? '## Objective\nVerify the TAKT OpenCode integration.\n## Next Move\nContinue the probe.' : status ? '{"step":1,"reason":"approved"}' : name === 'judge' ? '{"verdict":"ok"}' : `OK:${name ?? 'title'}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: 'probe', object: 'chat.completion.chunk', model: 'probe',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (tool) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name: tool.name, arguments: '' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content });
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
const observer = join(workspace, 'context-observer');
mkdirSync(observer);
writeFileSync(join(observer, 'index.js'), `export default {
  id: 'takt-probe-context-observer',
  async setup(context) {
    const registration = await context.session.hook('context', async (request) => {
      const response = await fetch(${JSON.stringify(`http://127.0.0.1:${provider.address().port}/context`)}, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error('Probe context capture failed');
    });
    return () => registration.dispose();
  },
};`);
const config = { providers: { probe: {
  name: 'Probe', package: '@opencode/ai/providers/openai-compatible',
  settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'probe' },
  models: { probe: { name: 'Probe', limit: { context: 32768, output: 4096 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
} }, plugins: [observer] };
mkdirSync(join(process.env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
const userConfigPath = join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
writeFileSync(userConfigPath, JSON.stringify(config));
const client = new OpenCodeClient();
const defaults = { cwd: workspace, model: 'probe/probe', permissionMode: 'readonly', allowedTools: ['Read'] };
const results = [];
const skillFailures = [];
async function call(name, options = {}) {
  const result = await client.callCustom('probe', `PROBE_CASE:${name}`, `SYSTEM_${name.toUpperCase()}`, {
    ...defaults, abortSignal: AbortSignal.timeout(20_000), ...options,
  });
  results.push({ name, status: result.status, sessionId: result.sessionId, content: result.content });
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.ok(result.content.includes(name === 'judge' ? 'verdict' : `OK:${name}`), JSON.stringify(result));
  const request = captures.find((capture) => capture.name === name).input;
  assert.ok(JSON.stringify(request.messages.filter((m) => m.role === 'system')).includes(`SYSTEM_${name.toUpperCase()}`));
  return result;
}
function toolsFor(name) {
  return captures.find((capture) => capture.name === name).input.tools.map((tool) => tool.function.name);
}
function assertSkills(name, enabled, listingExpected) {
  const requests = captures.filter((capture) => capture.name === name);
  assert.ok(requests.length > 0, `Missing request: ${name}`);
  for (const { input } of requests) {
    assert.equal((input.tools ?? []).some((tool) => tool.function.name === 'skill'), enabled, name);
    // OpenCode may retain native guidance on a previously Skill-enabled session.
    if (listingExpected === undefined) continue;
    const body = JSON.stringify(input).replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    assert.equal(/<id>[^<]+<\/id>\\n\s*<name>probe-(?:repo|user)<\/name>/.test(body), listingExpected, name);
    for (const description of ['PROBE_REPO_SKILL_DESCRIPTION', 'PROBE_USER_SKILL_DESCRIPTION']) {
      assert.equal(body.includes(description), listingExpected, `${name}: ${description}`);
    }
  }
}
function checkSkills(name, enabled, listingExpected) {
  try {
    assertSkills(name, enabled, listingExpected);
  } catch (error) {
    skillFailures.push({ name, error: error.message });
  }
}

async function probeSkills() {
  resetSharedServer();
  delete process.env.OPENCODE_CONFIG_PROJECT_DISABLE;
  execFileSync('git', ['init', '--quiet', workspace]);
  const fixturePaths = [];
  for (const [root, name] of [[workspace, 'probe-repo'], [process.env.HOME, 'probe-user']]) {
    for (const source of ['.agents', '.claude', '.opencode']) {
      const directory = join(root, source, 'skills', name);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'SKILL.md');
      const kind = name === 'probe-repo' ? 'REPO' : 'USER';
      writeFileSync(path, `---\nname: ${name}\ndescription: PROBE_${kind}_SKILL_DESCRIPTION\n---\nPROBE_${kind}_SKILL_LOADED\n`);
      fixturePaths.push(path);
    }
  }
  const projectConfigPath = join(workspace, 'opencode.json');
  writeFileSync(projectConfigPath, '{}');
  fixturePaths.push(projectConfigPath, userConfigPath);
  const contents = fixturePaths.map((path) => readFileSync(path, 'utf8'));
  const quoted = '例: <available_skills><skill>sample</skill></available_skills>';
  writeFileSync(join(workspace, 'AGENTS.md'), `PROBE_ORDINARY_INSTRUCTION\n${quoted}\n`);
  for (const [name, allowedTools] of [['skill_off', undefined], ['skill_off_review', ['Read']], ['skill_off_report', []]]) {
    await call(name, { allowedTools });
    checkSkills(name, false, false);
  }
  await call('skill_false', { skillsEnabled: false });
  checkSkills('skill_false', false, false);
  const first = await call('skill_repo', { skillsEnabled: true });
  checkSkills('skill_repo', true, true);
  assert.ok(JSON.stringify(captures.filter((capture) => capture.name === 'skill_repo')).includes('PROBE_REPO_SKILL_LOADED'));
  await call('skill_user', { skillsEnabled: true });
  checkSkills('skill_user', true, true);
  await call('skill_on', { skillsEnabled: true, allowedTools: undefined });
  checkSkills('skill_on', true, true);
  await call('skill_on_empty', { skillsEnabled: true, allowedTools: [] });
  checkSkills('skill_on_empty', true, true);
  assert.ok(JSON.stringify(captures.filter((capture) => capture.name === 'skill_user')).includes('PROBE_USER_SKILL_LOADED'));
  const step = { name: 'implement', personaDisplayName: 'coder', instruction: 'task', passPreviousResponse: false,
    rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' }), normalizeRule({ condition: 'needs_fix', next: 'implement' })] };
  const configured = { opencode: { skills: { enabled: true } } };
  const builder = new OptionsBuilder({ projectCwd: workspace, provider: 'opencode', model: 'probe/probe', providerOptions: configured },
    () => workspace, () => workspace, () => undefined, () => join(workspace, 'reports'), () => 'en', () => [step], () => 'probe', () => undefined);
  const reportOptions = builder.buildResumeOptions(step, first.sessionId, {});
  const report = await runAgent(undefined, 'PROBE_CASE:skill_report', reportOptions);
  assert.equal(report.status, 'done', JSON.stringify(report));
  assert.equal(report.sessionId, first.sessionId);
  assert.equal(reportOptions.providerOptions.opencode.skills.enabled, true);
  assert.equal(configured.opencode.skills.enabled, true);
  checkSkills('skill_report', false, undefined);
  results.push({ name: 'skill_report', status: report.status, sessionId: report.sessionId, configuredSkills: reportOptions.providerOptions.opencode.skills.enabled });
  const retryOptions = builder.buildNewSessionReportOptions(step, { allowedTools: [] });
  assert.equal(retryOptions.executionPhase, 2);
  assert.equal(retryOptions.sessionId, undefined);
  assert.equal(retryOptions.providerOptions.opencode.skills.enabled, true);
  const retry = await runAgent(undefined, 'PROBE_CASE:skill_report_retry', retryOptions);
  assert.equal(retry.status, 'done', JSON.stringify(retry));
  assert.ok(retry.sessionId);
  assert.notEqual(retry.sessionId, first.sessionId);
  assert.equal(retryOptions.providerOptions.opencode.skills.enabled, true);
  checkSkills('skill_report_retry', false, false);
  results.push({ name: 'skill_report_retry', status: retry.status, sessionId: retry.sessionId, configuredSkills: retryOptions.providerOptions.opencode.skills.enabled, executionPhase: retryOptions.executionPhase });
  const offResumeOptions = { sessionId: first.sessionId, skillsEnabled: false };
  const offResume = await call('skill_setting_off_resume', offResumeOptions);
  assert.equal(offResume.sessionId, first.sessionId);
  assert.equal(offResumeOptions.skillsEnabled, false);
  checkSkills('skill_setting_off_resume', false, undefined);
  for (const [name, restriction] of [
    ['skill_same_status', { executionPhase: 3 }],
    ['skill_same_strict', { internalAgentIsolation: 'strict-readonly' }],
  ]) {
    const response = await new OpenCodeProvider().setup({ name: 'probe' }).call(`PROBE_CASE:${name}`, {
      cwd: workspace, model: 'probe/probe', sessionId: first.sessionId, providerOptions: configured,
      allowedTools: ['Read'], abortSignal: AbortSignal.timeout(20_000), ...restriction,
    });
    assert.equal(response.status, 'done', JSON.stringify(response));
    assert.equal(response.sessionId, first.sessionId);
    assert.equal(configured.opencode.skills.enabled, true);
    checkSkills(name, false, undefined);
    results.push({ name, status: response.status, sessionId: response.sessionId, configuredSkills: configured.opencode.skills.enabled, ...restriction });
  }
  const resumed = await call('skill_resume', { sessionId: first.sessionId, skillsEnabled: true });
  assert.equal(resumed.sessionId, first.sessionId);
  checkSkills('skill_resume', true, true);
  const offFirst = await call('skill_off_first', { skillsEnabled: false });
  checkSkills('skill_off_first', false, false);
  const onAfterOff = await call('skill_on_after_off', { sessionId: offFirst.sessionId, skillsEnabled: true });
  assert.equal(onAfterOff.sessionId, offFirst.sessionId);
  checkSkills('skill_on_after_off', true, true);
  const offAfterOnOptions = { sessionId: offFirst.sessionId, skillsEnabled: false };
  const offAfterOn = await call('skill_off_after_on', offAfterOnOptions);
  assert.equal(offAfterOn.sessionId, offFirst.sessionId);
  assert.equal(offAfterOnOptions.skillsEnabled, false);
  checkSkills('skill_off_after_on', false, undefined);
  for (const name of ['skill_repo', 'skill_report', 'skill_setting_off_resume', 'skill_resume', 'skill_off_first', 'skill_on_after_off', 'skill_off_after_on']) {
    const captured = contexts.filter((request) => JSON.stringify(request.messages.at(-1)).includes(`PROBE_CASE:${name}`));
    assert.ok(captured.length > 0, `Missing context hook capture: ${name}`);
    assert.ok(captured.every((request) => JSON.stringify([request.system, request.messages]).includes('PROBE_ORDINARY_INSTRUCTION')), name);
    assert.ok(captured.every((request) => JSON.stringify([request.system, request.messages]).includes(quoted)), name);
  }
  const initial = contexts.find((request) => JSON.stringify(request.messages.at(-1)).includes('PROBE_CASE:skill_repo'));
  const guidancePart = initial.system.find((part) => part.text.includes('PROBE_REPO_SKILL_DESCRIPTION'));
  const guidance = guidancePart.text.slice(guidancePart.text.indexOf('Skills provide specialized instructions'));
  const agentsPath = join(workspace, 'AGENTS.md');
  const ordinary = readFileSync(agentsPath, 'utf8');
  writeFileSync(agentsPath, `${ordinary}\nPROBE_QUOTED_NATIVE_GUIDANCE\n${guidance}\n`);
  resetSharedServer();
  const collision = await call('skill_source_collision', { skillsEnabled: true });
  await call('skill_source_collision_report', { sessionId: collision.sessionId, skillsEnabled: true, disableSkills: true });
  for (const name of ['skill_source_collision', 'skill_source_collision_report']) {
    const request = contexts.find((entry) => JSON.stringify(entry.messages.at(-1)).includes(`PROBE_CASE:${name}`));
    assert.ok(request, `Missing context hook capture: ${name}`);
    const combined = request.system.find((part) => part.text.includes('PROBE_QUOTED_NATIVE_GUIDANCE'));
    assert.equal(combined.text.split(guidance).length - 1, 2, name);
    assert.deepEqual(Object.keys(combined).sort(), ['text', 'type']);
  }
  writeFileSync(agentsPath, ordinary);
  resetSharedServer();
  await client.compactSession({ cwd: workspace, model: 'probe/probe', sessionId: first.sessionId, skillsEnabled: true, abortSignal: AbortSignal.timeout(20_000) });
  resetSharedServer();
  await call('skill_restart', { sessionId: first.sessionId, skillsEnabled: true });
  checkSkills('skill_restart', true, true);
  const strict = await new OpenCodeProvider().setup({ name: 'probe' }).call('PROBE_CASE:skill_strict', {
    cwd: workspace, model: 'probe/probe', providerOptions: configured,
    internalAgentIsolation: 'strict-readonly', allowedTools: ['Read'], abortSignal: AbortSignal.timeout(20_000),
  });
  assert.equal(strict.status, 'done', JSON.stringify(strict));
  checkSkills('skill_strict', false, false);
  const judgment = await runStatusJudgmentPhase(step, {
    cwd: workspace, reportDir: workspace, workflowName: 'probe', lastResponse: 'PROBE_CASE:skill_status', iteration: 1,
    abortSignal: AbortSignal.timeout(20_000),
    resolveStepProviderModel: () => ({ provider: 'opencode', model: 'probe/probe', providerOptions: configured }),
    structuredCaller: new ProviderNeutralStructuredCaller(),
  });
  assert.equal(judgment.label, 'approved');
  checkSkills('skill_status', false, false);
  const parallel = await Promise.all([call('skill_parallel_on', { skillsEnabled: true }), call('skill_parallel_off', { skillsEnabled: false })]);
  assert.notEqual(parallel[0].sessionId, parallel[1].sessionId);
  checkSkills('skill_parallel_on', true, true);
  checkSkills('skill_parallel_off', false, false);
  assert.deepEqual(fixturePaths.map((path) => readFileSync(path, 'utf8')), contents);
  for (const effect of ['deny', 'ask']) {
    resetSharedServer();
    writeFileSync(userConfigPath, JSON.stringify({ ...config, permissions: [{ action: 'skill', resource: '*', effect }] }));
    const nativeConfig = readFileSync(userConfigPath, 'utf8');
    const permissions = [];
    const name = `skill_${effect}`;
    let asked = false;
    let skillAsked = false;
    await call(name, { skillsEnabled: true, onPermissionRequest: async (request) => {
      assert.equal(request.toolName, 'skill');
      asked = true;
      return { behavior: 'allow', updatedInput: request.input };
    }, onSkillPermissionRequest: async () => {
      skillAsked = true;
      return true;
    }, onStream: (event) => {
      if (event.type === 'permission_asked') permissions.push(event.data);
    } });
    checkSkills(name, effect === 'ask', effect === 'ask');
    const body = JSON.stringify(captures.filter((capture) => capture.name === name));
    assert.equal(body.includes('PROBE_REPO_SKILL_LOADED'), effect === 'ask', effect);
    assert.equal(asked, effect === 'ask');
    assert.equal(skillAsked, false);
    if (effect === 'ask') assert.ok(permissions.some((event) => event.permission === 'skill' && event.reply === 'once'), JSON.stringify(permissions));
    assert.equal(readFileSync(userConfigPath, 'utf8'), nativeConfig);
    results.push({ name: `native_skill_${effect}`, status: 'done', permissions });
  }
  for (const allowed of [true, false]) {
    const name = `skill_workflow_${allowed ? 'allow' : 'reject'}`;
    const permissions = [];
    let asked = false;
    const nativeConfig = readFileSync(userConfigPath, 'utf8');
    const response = await client.callCustom('probe', `PROBE_CASE:${name}`, `SYSTEM_${name.toUpperCase()}`, {
      ...defaults,
      abortSignal: AbortSignal.timeout(20_000),
      skillsEnabled: true,
      onSkillPermissionRequest: async (request, signal) => {
        assert.deepEqual(request.patterns, ['probe-repo']);
        assert.equal(signal.aborted, false);
        asked = true;
        return allowed;
      },
      onStream: (event) => {
        if (event.type === 'permission_asked') permissions.push(event.data);
      },
    });
    results.push({ name, status: response.status, sessionId: response.sessionId, content: response.content });
    assert.equal(response.status, allowed ? 'done' : 'error', JSON.stringify(response));
    assert.equal(response.content, allowed ? `OK:${name}` : 'Step interrupted');
    assert.equal(asked, true);
    const body = JSON.stringify(captures.filter((capture) => capture.name === name));
    assert.equal(body.includes('PROBE_REPO_SKILL_LOADED'), allowed);
    assert.ok(permissions.some((event) => event.permission === 'skill' && event.reply === (allowed ? 'once' : 'reject')), JSON.stringify(permissions));
    assert.equal(readFileSync(userConfigPath, 'utf8'), nativeConfig);
    results.push({ name: `native_${name}`, status: response.status, permissions });
  }
  writeFileSync(userConfigPath, contents.at(-1));
  results.push({ name: 'skill_contracts', contracts: ['OC-03', 'OC-04', 'OC-05', 'OC-06', 'OC-07', 'OC-09', 'OC-10', 'OC-12'], status: skillFailures.length === 0 ? 'done' : 'error' });
}
let success = false;
try {
  process.env.TAKT_OPENCODE_VERSION = 'v1';
  const mismatch = await client.callCustom('probe', 'PROBE_CASE:mismatch', 'SYSTEM_MISMATCH', defaults);
  assert.equal(mismatch.status, 'error');
  assert.ok(mismatch.content.includes('incompatible'));
  assert.equal(captures.length, 0);
  results.push({ name: 'generation_guard', status: 'rejected_before_prompt' });
  process.env.TAKT_OPENCODE_VERSION = 'v2';
  const read = await call('read');
  reportProbePhase('ready');
  assert.deepEqual(toolsFor('read'), ['read']);
  assert.equal(read.debugInfo.toolHealth.totalSuccesses, 1, JSON.stringify(read));
  const write = await call('write', { sessionId: read.sessionId, permissionMode: 'full', allowedTools: ['Write'] });
  assert.equal(write.sessionId, read.sessionId);
  assert.equal(readFileSync(target, 'utf8'), 'write');
  assert.ok(toolsFor('write').includes('write'));
  const denied = await call('denied', { sessionId: read.sessionId });
  assert.equal(denied.sessionId, read.sessionId);
  assert.ok(!toolsFor('denied').includes('write'));
  assert.equal(readFileSync(target, 'utf8'), 'write');
  assert.ok(denied.debugInfo.toolHealth.totalErrors > 0, 'Rejected tool must be observed');
  const judge = await call('judge', { sessionId: read.sessionId, allowedTools: [], outputSchema: {
    type: 'object', properties: { verdict: { type: 'string', enum: ['ok'] } }, required: ['verdict'], additionalProperties: false,
  } });
  assert.deepEqual(judge.structuredOutput, { verdict: 'ok' });
  assert.ok(JSON.stringify(captures.find((c) => c.name === 'judge').input.messages).includes('additionalProperties'));
  assert.deepEqual(toolsFor('judge'), []);
  await call('write_again', { sessionId: read.sessionId, permissionMode: 'full', allowedTools: ['Write'] });
  assert.equal(readFileSync(target, 'utf8'), 'write_again');
  const parallel = await Promise.all([call('parallel_a'), call('parallel_b')]);
  assert.notEqual(parallel[0].sessionId, parallel[1].sessionId);
  for (const name of ['parallel_a', 'parallel_b']) {
    const system = JSON.stringify(captures.find((c) => c.name === name).input.messages.filter((m) => m.role === 'system'));
    assert.ok(!system.includes(`SYSTEM_${(name === 'parallel_a' ? 'parallel_b' : 'parallel_a').toUpperCase()}`));
  }
  const controller = new AbortController();
  abortOnRequest = () => controller.abort();
  const aborted = await client.callCustom('probe', 'PROBE_CASE:abort', 'SYSTEM_ABORT', { ...defaults, sessionId: read.sessionId, abortSignal: controller.signal });
  assert.equal(aborted.status, 'error');
  assert.equal(aborted.failureCategory, 'external_abort');
  results.push({ name: 'abort', status: aborted.status, failureCategory: aborted.failureCategory });
  await call('resume', { sessionId: read.sessionId });
  await client.compactSession({ cwd: workspace, sessionId: read.sessionId, model: 'probe/probe', abortSignal: AbortSignal.timeout(20_000) });
  results.push({ name: 'compact', status: 'done', sessionId: read.sessionId });
  resetSharedServer();
  await call('restart', { sessionId: read.sessionId });
  let answered = false;
  await call('question', { allowedTools: ['question'], permissionMode: 'full', onAskUserQuestion: async () => {
    answered = true;
    return { 'Select one': 'A' };
  } });
  assert.ok(answered);
  const mcpScript = join(workspace, 'mcp.mjs');
  writeFileSync(mcpScript, `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;
 const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:
 q.method==='tools/list'?{tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:
 q.method==='tools/call'?{content:[{type:'text',text:q.params.arguments.text}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
});`);
  const mcp = await call('mcp', { allowedTools: [], allowedMcpTools: ['probe_echo'], preparedMcp: {
    serverConfig: { probe: { type: 'local', command: [process.execPath, mcpScript] } }, identity: 'v2-probe-mcp', dispose: async () => {},
  } });
  assert.deepEqual(toolsFor('mcp'), ['probe_echo']);
  assert.equal(mcp.debugInfo.toolHealth.totalSuccesses, 1);
  const automaticMcp = await call('mcp_auto', { allowedTools: undefined, permissionMode: 'full', preparedMcp: {
    serverConfig: { probe: { type: 'local', command: [process.execPath, mcpScript] } }, identity: 'v2-probe-mcp', dispose: async () => {},
  } });
  assert.ok(toolsFor('mcp_auto').includes('probe_echo'));
  assert.equal(automaticMcp.debugInfo.toolHealth.totalSuccesses, 1);
  await probeSkills();
  assert.deepEqual(skillFailures, [], JSON.stringify(skillFailures));
  success = true;
} finally {
  reportProbePhase(success ? 'cleanupStart' : 'failureCleanupStart');
  resetSharedServer();
  const captureIndex = process.argv.indexOf('--capture');
  if (captureIndex >= 0) writeFileSync(resolve(process.argv[captureIndex + 1]), JSON.stringify({ success, skillFailures, results, captures, contexts }, null, 2));
  await new Promise((done) => { provider.close(done); provider.closeAllConnections(); });
  rmSync(workspace, { recursive: true, force: true });
}
console.log(`PROBE_RESULT ${JSON.stringify({ generation: 'v2', scenarios: results, requests: captures.length })}`);
