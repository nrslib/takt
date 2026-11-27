import { detectCandidateIndex } from '../../dist/shared/utils/ruleIndex.js';
import { loadPhase3JudgmentRules } from '../phase3-judgment-prompt.mjs';

const toolItemTypes = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

function finalJsonText(output) {
  if (typeof output !== 'string') return undefined;
  let depth = 0;
  let start;
  let quoted = false;
  let escaped = false;
  let last;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && depth > 0) quoted = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) last = output.slice(start, index + 1);
    }
  }
  return depth > 0 ? output.slice(start) : last;
}

export function scorePhase3Judgment(output, candidates, expectedLabel, { allowCliFormats = false, stepName } = {}) {
  const jsonText = finalJsonText(output);
  let result;
  let format = 'json';
  let error = 'invalid_json';
  let step;
  try {
    result = JSON.parse(jsonText);
  } catch {
    // CLI の最終 JSON が読めない場合も、明示された判定タグを採点対象にする。
    result = undefined;
  }
  if (result !== null && typeof result === 'object' && !Array.isArray(result)
    && (allowCliFormats || typeof result.reason === 'string')) {
    const key = allowCliFormats && !Object.hasOwn(result, 'step') ? 'rule' : 'step';
    format = allowCliFormats ? `json.${key}` : 'json';
    step = result[key];
    error = 'invalid_step';
  }
  if (allowCliFormats && (!Number.isInteger(step) || step < 1 || step > candidates.length)
    && typeof output === 'string') {
    const index = detectCandidateIndex(output, stepName);
    if (index >= 0) {
      step = index + 1;
      format = 'tag';
      error = 'invalid_step';
    } else if (jsonText === undefined) {
      error = 'invalid_tag';
      format = 'tag';
    }
  }
  if (!Number.isInteger(step) || step < 1 || step > candidates.length) {
    return { pass: false, score: 0, reason: `${error} (${format})`, label: null, format };
  }
  const label = candidates[step - 1].label;
  const pass = label === expectedLabel;
  return { pass, score: pass ? 1 : 0, reason: `${pass ? 'expected_rule' : 'wrong_rule'} (${format})`, label, format };
}

function scoreInputBoundary(raw) {
  let response;
  try {
    response = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { pass: false, reason: 'invalid_raw_items' };
  }
  if (!Array.isArray(response?.items) || response.items.some((item) => typeof item?.type !== 'string')) {
    return { pass: false, reason: 'invalid_raw_items' };
  }
  const tools = response.items.filter((item) => toolItemTypes.has(item.type));
  return tools.length === 0
    ? { pass: true, reason: 'no_external_read' }
    : { pass: false, reason: `tool_use (${tools.map((item) => item.type).join(', ')})` };
}

export default function assertPhase3Judgment(output, context) {
  const { name, candidates } = loadPhase3JudgmentRules(context.vars);
  if (!candidates.some(({ label }) => label === context.vars.expected_label)) {
    throw new Error('expected_label must name a selectable rule');
  }
  const providerId = typeof context.provider?.id === 'function' ? context.provider.id() : context.provider?.id;
  const isCodex = typeof providerId === 'string' && providerId.startsWith('openai:codex-sdk');
  const isClaude = context.provider?.config?.cli === 'claude';
  const rule = scorePhase3Judgment(output, candidates, context.vars.expected_label, {
    allowCliFormats: isClaude && !isCodex, stepName: name,
  });
  const namedScores = { 'phase3-follow-input/rule': rule.score };
  if (!isCodex) return { ...rule, namedScores };
  const boundary = scoreInputBoundary(context.providerResponse?.raw);
  namedScores['phase3-follow-input/no-external-read'] = boundary.pass ? 1 : 0;
  const pass = rule.pass && boundary.pass;
  return {
    ...rule, pass, score: pass ? 1 : 0,
    reason: `rule: ${rule.reason}; input_boundary: ${boundary.reason}`,
    namedScores,
  };
}
