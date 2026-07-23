const ENGLISH_NEGATION = /\b(?:not|never|does not|doesn't|is not|isn't|cannot|can't|fails? to|failed to)\b/i;
const JAPANESE_NEGATION = /(?:ではない|じゃない|されない|しない|できない|ない|なく|ません|ず(?:に|$)|ぬ|未解放|範囲外|欠落|失われ|返せず|伝播せず|保存せず|解放せず|保持されず)/;
const ENGLISH_REFUTATION = /\b(?:claim|finding|defect|issue|assertion)\b[^.;。|]*(?:false|incorrect|unfounded|refuted)\b/i;
const JAPANESE_REFUTATION = /(?:指摘|主張|欠陥|問題)[^.;。|]*(?:誤り|不正確|事実ではない|反証|修正不要)/;
const ENGLISH_LIMITED_PATH = /\b(?:only\s+(?:if|when|on\s+the\s+(?:success|happy|normal)\s+path)|unless|except(?:\s+(?:when|on|for))?|(?:success|happy|normal)\s+path\s+only)\b/i;
const JAPANESE_LIMITED_PATH = /(?:(?:成功|正常)(?:時|経路)?(?:に)?のみ|(?:成功|正常)(?:した)?場合に限り|(?:場合|時)を除き|ない限り)/;
const ENGLISH_MISSING_EVIDENCE = /\bwithout\s+(?:(?:the|any)\s+)?(?:previews?|cleanup|release(?:previews)?|isolat(?:ion|ed|ing)|catch(?:ing)?|warning|body|primary result)\b/i;
const JAPANESE_OPERATION_FAILURE = /(?:保存|伝播|保持|解放|隔離|捕捉|継続|返却?)[^.;。|]{0,12}(?:に失敗|できず)/;

function testPattern(pattern, text) {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return new RegExp(pattern.source, flags).test(text);
}

export function hasAffirmativeEvidenceLine(output, {
  citation,
  required,
}) {
  return output.split(/\r?\n/).some((line) => (
    testPattern(citation, line)
    && required.every((pattern) => testPattern(pattern, line))
    && !ENGLISH_NEGATION.test(line)
    && !JAPANESE_NEGATION.test(line)
    && !ENGLISH_REFUTATION.test(line)
    && !JAPANESE_REFUTATION.test(line)
    && !ENGLISH_LIMITED_PATH.test(line)
    && !JAPANESE_LIMITED_PATH.test(line)
    && !ENGLISH_MISSING_EVIDENCE.test(line)
    && !JAPANESE_OPERATION_FAILURE.test(line)
  ));
}
