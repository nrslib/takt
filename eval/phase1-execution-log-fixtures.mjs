// Grading values stay outside the task, work result, and LLM rubric.
export const middleObservationParts = ['OBS-7c39b2', 'current.ts:42', '17'];
export const middleObservation = 'OBS-7c39b2: current.ts:42 returned 17 active records';

export function expandLargeRecord(log) {
  const padding = 'unrelated historical trace entry '.repeat(40_000);
  log.push({ kind: 'provider_event', event: { type: 'tool_result', data: {
    id: 'obsolete', isError: false, content: 'Superseded observation: current.ts:42 returned 9 active records',
  } } });
  log.push({ kind: 'provider_event', event: { type: 'tool_use', data: {
    id: 'middle-observation', tool: 'Read', input: { file_path: 'current.ts' },
  } } });
  log.push({ kind: 'provider_event', event: { type: 'tool_result', data: {
    id: 'middle-observation', isError: false,
    content: `${padding}\nLatest observation: ${middleObservation}\n${padding}`,
  } } });
  log.push({ kind: 'attempt_result', status: 'done', content: 'Observation recorded; no judgment made.' });
}
