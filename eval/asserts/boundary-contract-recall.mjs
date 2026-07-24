import { hasFindingLine } from './boundary-finding-line.mjs';

const PREVIEW_VALUE = /(?:\bpreviews?\b|プレビュー)/i;
const PROPAGATION_LOSS = /(?:\b(?:drop(?:s|ped)?|los(?:e|es|t)|empty|omit(?:s|ted)?|missing)\b|\bnot\s+(?:forwarded|passed|persisted|propagated|saved)\b|\bnever\s+reach(?:es|ed)?\b|空配列|欠落|失われ|保存されない|伝播しない|引き渡されない|渡されない|到達しない)/i;
const BROKEN_PREVIEW_CONTRACT = /(?:\b(?:previews?|store(?:\.save)?|stored task|persisted (?:task|document)|consumer)\b[^.;。|]*(?:drop(?:s|ped)?|los(?:e|es|t)|empty|none|missing|incomplete|omit(?:s|ted)?|preserv(?:e|ation))|\b(?:drop(?:s|ped)?|los(?:e|es|t)|empty|none|missing|incomplete|omit(?:s|ted)?)\b[^.;。|]*\bpreviews?\b|プレビュー[^。|]*(?:保持|保存|空|欠落|失われ|伝播しない|到達しない)|(?:保存先|永続化先|利用先)[^。|]*(?:空|欠落|失われ|受け取れない))/i;
const ACTIONABLE_FIX = /(?:\b(?:pass|forward|propagate|persist|save|hand\s+off)\b|previews\s*:\s*document\.previews|引き渡|渡す|保存|伝播)/i;

const REFUTED_CLAIM = /\b(?:claim|finding|defect|issue|assertion)\b[^.;。|]*(?:false|incorrect)\b/i;
const CORRECT_WIRING = /\b(?:behavior|wiring|persistence|preview propagation)\b[^.;。|]*\bcorrect\b/i;
const PRESERVED_PREVIEWS = /\bpreviews?\b[^.;。|]*(?:preserved|retained)\b/i;
const NO_PROPAGATION_FAILURE = /\bdoes not fail\b/i;
const JAPANESE_PRESERVATION = /プレビュー[^。|]*(?:保持される|保存される|欠落していない|失われない)/;

export default function assertBoundaryContractRecall(output) {
  return hasFindingLine(output, {
    familyTag: 'contract-wiring',
    citation: /src\/system-enqueue\.ts:12\b/,
    required: {
      defect: [
        PREVIEW_VALUE,
        PROPAGATION_LOSS,
      ],
      impact: [
        BROKEN_PREVIEW_CONTRACT,
      ],
      fix: [
        ACTIONABLE_FIX,
      ],
    },
    excluded: {
      defect: [
        REFUTED_CLAIM,
        CORRECT_WIRING,
        PRESERVED_PREVIEWS,
        NO_PROPAGATION_FAILURE,
        JAPANESE_PRESERVATION,
      ],
      impact: [
        REFUTED_CLAIM,
        CORRECT_WIRING,
        PRESERVED_PREVIEWS,
        JAPANESE_PRESERVATION,
      ],
    },
  });
}
