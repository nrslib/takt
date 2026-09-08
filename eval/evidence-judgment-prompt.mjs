import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';

const builtinsRoot = join(dirname(fileURLToPath(import.meta.url)), '../builtins');
const roleFacets = {
  planner: ['personas/planner.md', 'policies/contract-change.md'],
  implementer: ['personas/coder.md', 'policies/contract-change.md', 'policies/coding.md'],
  adjudicator: ['personas/review-adjudicator.md', 'policies/contract-change.md', 'policies/review-adjudication.md'],
  companion: ['personas/coding-reviewer.md', 'policies/contract-change.md', 'policies/companion-review.md'],
};

// Reduced role-policy evaluation, not a full workflow or a tool-execution test.
export default function buildEvidenceJudgmentPrompt({ vars }) {
  const language = vars.language ?? 'ja';
  if (!['ja', 'en'].includes(language)) throw new Error(`Unknown facet language: ${language}`);
  const facetsRoot = join(builtinsRoot, language, 'facets');
  const paths = Object.hasOwn(roleFacets, vars.role) ? roleFacets[vars.role] : undefined;
  if (!paths) throw new Error(`Unknown judgment role: ${vars.role}`);
  const facets = paths.map(path => expandFacetIncludes({
    body: readFileSync(join(facetsRoot, path), 'utf8'),
    facetsRoots: [facetsRoot],
    repertoireDirs: [],
    allowedRoots: [facetsRoot],
  }).body);
  return [
    ...facets,
    '以下は役割別の机上評価です。提供された全コードと要件だけから、次に必要な対応を判断してください。ファイル編集やコマンド実行はしないでください。',
    vars.task,
    '最後に DECISION: retain / repair / verify / investigate のうち1つだけを1行で記載してください。retain は変更不要、repair は確認済み不足の修正、verify は明示された検証義務の実施、investigate は判断に必要な情報の調査です。その前に根拠と未確認範囲を短く説明してください。',
  ].join('\n\n');
}
