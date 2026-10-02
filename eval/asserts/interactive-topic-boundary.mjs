import { hasContinuationTaskIdentity, hasExplicitCurrentTopic } from './interactive-topic-identity.mjs';

const previousTopic = /caccia|CodeRabbit|src\s*\/\s*features\s*\/\s*caccia|未解決スレッド|unresolved\s+(?:review\s+)?threads?|未解決.{0,5}レビュー\s*コメント|unresolved\s+review\s+comments?/iu;
const lineNumber = /行番号|\bline\s*(?:number|no\.?|\d+)|\bline\b/iu;
const errorCause = /原因|理由|\bcause\b|\breason\b/iu;
const previousFile = /src\s*\/\s*features\s*\/\s*caccia/iu;
const previousAcceptance = /(?:未解決|unresolved).{0,24}(?:スレッド|指摘|(?:review\s+)?threads?|レビュー\s*コメント|review\s+comments?).{0,24}(?:ゼロ|0\b|zero|none|存在しない|残さない|do\s+not\s+(?:exist|remain)|are\s+absent)|(?:ゼロ|0\b|zero|no).{0,18}(?:未解決|unresolved).{0,24}(?:スレッド|指摘|(?:review\s+)?threads?|レビュー\s*コメント|review\s+comments?)/iu;
const reversedAcceptance = /(?:not\s+(?:be\s+)?|non[-\s]?|非)\s*(?:zero|none|ゼロ)|(?:ゼロ|0\b|zero|none|存在しない|残さない).{0,10}(?:ではない|じゃない|わけではない|とは限らない|not)/iu;
const absenceWording = /存在しない|残さない|do\s+not\s+(?:exist|remain)|are\s+absent/iu;
const reviewCommentWording = /レビュー\s*コメント|review\s+comments?/iu;
const optionalWording = /not\s+required|does\s+not\s+need|need\s+not|no\s+requirement|optional|必須ではない|任意/iu;

function hasPreviousAcceptance(output) {
  return output.split(/[\n。.!?]/u).some((clause) =>
    previousAcceptance.test(clause)
    && !reversedAcceptance.test(clause)
    && !((absenceWording.test(clause) || reviewCommentWording.test(clause)) && optionalWording.test(clause)));
}

export function assertInteractiveTopicBoundary(output, context, assertion) {
  const { scenario, fixture } = context.vars;
  if (!['continuation', 'go', 'tell'].includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  if (!['separate', 'tell-separate', 'tell-prior-recipient', 'combined', 'research-unadopted', 'research-adopted'].includes(fixture)) {
    throw new Error(`Unknown fixture: ${fixture}`);
  }

  let pass;
  if (assertion === 'current-topic') {
    pass = fixture === 'tell-prior-recipient'
      ? previousTopic.test(output) && previousFile.test(output) && hasPreviousAcceptance(output)
      : scenario === 'continuation'
        ? hasContinuationTaskIdentity(output)
        : hasExplicitCurrentTopic(output) && lineNumber.test(output) && errorCause.test(output);
  } else if (assertion === 'previous-topic') {
    pass = fixture === 'tell-prior-recipient'
      ? !hasExplicitCurrentTopic(output)
      : fixture === 'combined'
      ? previousTopic.test(output) && previousFile.test(output) && hasPreviousAcceptance(output)
      : !previousTopic.test(output);
  } else {
    throw new Error(`Unknown assertion: ${assertion}`);
  }
  return {
    pass,
    score: pass ? 1 : 0,
    reason: `${assertion} ${pass ? 'satisfied' : 'failed'} for ${scenario}/${fixture}`,
  };
}
