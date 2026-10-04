import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureOwnedProbeEntrypoint } from './probe-entrypoint.mjs';
import { reportProbePhase } from './probe-process.mjs';
import { OpenCodeClient, resetSharedServer } from '../../dist/infra/opencode/client.js';

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
const counts = new Map();
let abortOnRequest;
const toolFor = (name) => {
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
    const lastUser = input.messages?.filter((message) => message.role === 'user').at(-1);
    const title = input.messages?.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('title generator'));
    const compact = body.includes('Do not include the <template> tags');
    const name = title || compact ? undefined : JSON.stringify(lastUser).match(/PROBE_CASE:([a-z_]+)/)?.[1];
    if (name) captures.push({ name, input });
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (name === 'abort') { abortOnRequest(); return; }
    const tool = count === 1 ? toolFor(name) : undefined;
    const content = compact ? '## Objective\nVerify the TAKT OpenCode integration.\n## Next Move\nContinue the probe.' : name === 'judge' ? '{"verdict":"ok"}' : `OK:${name ?? 'title'}`;
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
const config = { providers: { probe: {
  name: 'Probe', package: '@opencode/ai/providers/openai-compatible',
  settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'probe' },
  models: { probe: { name: 'Probe', limit: { context: 32768, output: 4096 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
} } };
mkdirSync(join(process.env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
writeFileSync(join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), JSON.stringify(config));
const client = new OpenCodeClient();
const defaults = { cwd: workspace, model: 'probe/probe', permissionMode: 'readonly', allowedTools: ['Read'] };
const results = [];
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
  assert.deepEqual(toolsFor('read').sort(), ['read', 'skill']);
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
  success = true;
} finally {
  reportProbePhase(success ? 'cleanupStart' : 'failureCleanupStart');
  resetSharedServer();
  await new Promise((done) => { provider.close(done); provider.closeAllConnections(); });
  rmSync(workspace, { recursive: true, force: true });
}
console.log(`PROBE_RESULT ${JSON.stringify({ generation: 'v2', scenarios: results, requests: captures.length })}`);
