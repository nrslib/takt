function resultText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function parsePhaseEvents(raw, cli, hasSchema) {
  if (!raw.trim()) throw new Error('CLI returned no events');
  const events = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const tools = new Map();
  const toolOutputs = [];
  const responses = [];
  let sessionId;
  let completed = false;
  let answer;
  let structuredOutput;
  let structuredCount = 0;
  for (const event of events) {
    if (typeof event.type !== 'string') throw new Error('Event without type');
    if (cli === 'codex') {
      if (!['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', 'item.started', 'item.updated', 'item.completed'].includes(event.type)) throw new Error(`Unknown Codex event: ${event.type}`);
      if (event.type === 'thread.started') sessionId = event.thread_id;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error(`Codex event failure: ${resultText(event)}`);
      if (!event.type.startsWith('item.')) continue;
      const item = event.item;
      if (!item || typeof item.id !== 'string') throw new Error('Codex item without ID');
      if (item.type === 'agent_message') {
        responses.push(item.text);
        if (event.type === 'item.completed') answer = item.text;
      } else if (item.type === 'reasoning') {
        responses.push(resultText(item));
      } else if (!['reasoning', 'plan', 'todo_list'].includes(item.type)) {
        const known = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'tool_call', 'collab_tool_call'];
        if (!known.includes(item.type)) throw new Error(`Unknown Codex tool item: ${item.type}`);
        const output = resultText(item.aggregated_output ?? item.result ?? item.output ?? '');
        toolOutputs.push(...[item.aggregated_output, item.result, item.output]
          .filter((value) => value !== undefined).map(resultText));
        const tool = {
          id: item.id, name: item.type, input: item.command ?? item.arguments ?? item,
          output, status: item.status,
        };
        tools.set(item.id, tool);
      }
    } else if (cli === 'claude') {
      if (!['system', 'assistant', 'user', 'result', 'stream_event', 'tool_progress', 'tool_use_summary', 'rate_limit_event', 'auth_status', 'prompt_suggestion'].includes(event.type)) throw new Error(`Unknown Claude event: ${event.type}`);
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'result') {
        if (event.is_error || event.subtype !== 'success') throw new Error(`Claude result failure: ${resultText(event)}`);
        completed = true;
        answer = event.result;
        structuredOutput = event.structured_output;
        responses.push(resultText(event.result));
        if (event.structured_output !== undefined) responses.push(resultText(event.structured_output));
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') {
            if (!block.id || !block.name) throw new Error('Claude tool without identity');
            if (hasSchema && block.name === 'StructuredOutput') {
              structuredCount += 1;
            } else {
              const tool = { id: block.id, name: block.name, input: block.input, output: '' };
              tools.set(block.id, tool);
            }
          } else if (['text', 'thinking'].includes(block.type)) {
            responses.push(resultText(block));
          }
        }
      }
      if (event.type === 'user') {
        for (const block of event.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          toolOutputs.push(resultText(block.content));
          const tool = tools.get(block.tool_use_id);
          if (tool) tool.output = resultText(block.content);
        }
      }
    } else throw new Error(`Unsupported CLI: ${cli}`);
  }
  if (!completed || typeof sessionId !== 'string' || !sessionId) throw new Error('Missing completion or session ID');
  if (structuredOutput !== undefined) answer = JSON.stringify(structuredOutput);
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('Missing final answer');
  if (hasSchema && structuredOutput === undefined) {
    // Invalid JSON is left to the production structured caller, which owns fallback.
    try { structuredOutput = JSON.parse(answer); } catch { /* Recorded as an invalid structured response. */ }
  }
  return { sessionId, answer, structuredOutput, tools: [...tools.values()], toolOutputs, responses, structuredCount };
}

