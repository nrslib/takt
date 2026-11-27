export function reviewPayload(output) {
  const objects = [];
  for (let start = 0; start < output.length; start++) {
    if (output[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index++) {
      const char = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        const text = output.slice(start, index + 1);
        try {
          const review = JSON.parse(text);
          if (Object.hasOwn(review, 'verdict') && Object.hasOwn(review, 'findings')) {
            objects.push({ review, text });
          }
        } catch {
          // Retry later opening braces independently of malformed prose.
        }
        break;
      }
    }
  }
  if (objects.length !== 1) throw new Error(`Expected exactly one review JSON object; found ${objects.length}`);
  const { review, text } = objects[0];
  if (!review || !['APPROVE', 'REJECT'].includes(review.verdict) || !Array.isArray(review.findings)) {
    throw new Error('Expected verdict APPROVE/REJECT and findings array');
  }
  for (const finding of review.findings) {
    if (!finding || typeof finding.blocking !== 'boolean'
      || typeof finding.file !== 'string' || !finding.file.trim()
      || typeof finding.reason !== 'string' || !finding.reason.trim()) {
      throw new Error('Each finding requires file, reason and boolean blocking');
    }
  }
  const blocking = review.findings.some(finding => finding.blocking);
  if ((review.verdict === 'APPROVE' && blocking) || (review.verdict === 'REJECT' && !blocking)) {
    throw new Error('Verdict contradicts blocking findings');
  }
  const trimmed = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const format = trimmed === text ? 'json' : fenced?.[1].trim() === text ? 'fenced' : 'prose';
  return { review, text, format };
}

export function parseReview(output) {
  return reviewPayload(output).review;
}

export async function gradeDesign(output, context) {
  let review;
  try {
    review = parseReview(output);
  } catch (error) {
    return { pass: false, score: 0, reason: error.message };
  }
  const { assertions, loadApiProvider } = await import('promptfoo');
  const options = { ...context.test.options };
  if (typeof options.provider?.id === 'string') {
    // CLI and library builds have separate config state; pass the YAML base path explicitly.
    const basePath = context.provider?.config?.basePath;
    if (typeof basePath !== 'string' || basePath.length === 0) {
      throw new Error('Review grading requires the loaded provider configuration basePath');
    }
    options.provider = await loadApiProvider(options.provider.id, { options: options.provider, basePath });
  }
  return assertions.matchesLlmRubric(context.config.rubric, JSON.stringify(review), options, context.vars);
}

export default function assertReview(output, context) {
  if (context?.config?.rubric !== undefined) return gradeDesign(output, context);
  try {
    const { format } = reviewPayload(output);
    return { pass: format === 'json', score: format === 'json' ? 1 : 0, reason: `Review format: ${format}` };
  } catch (error) {
    return { pass: false, score: 0, reason: error.message };
  }
}
