const explicitCurrentTopic = /Quint|formalSpecPrompts\.ts/iu;
const validationOrSyntax = /検証|構文|\bvalidation\b|\bverification\b|\bsyntax\b/iu;
const error = /エラー|\berrors?\b/iu;
const lineNumber = /行番号|\bline\s*(?:number|no\.?|\d+)/iu;
const errorCause = /原因|理由|\bcause\b|\breason\b/iu;

export function hasExplicitCurrentTopic(output) {
  return explicitCurrentTopic.test(output);
}

export function hasContinuationTaskIdentity(output) {
  return hasExplicitCurrentTopic(output)
    || (validationOrSyntax.test(output)
      && error.test(output)
      && lineNumber.test(output)
      && errorCause.test(output));
}
