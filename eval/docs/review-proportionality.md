# 裁定における保証追加の判断

## 変更の狙い

レビュー指摘の技術的な成立と、今回必要な修正を別々に判断する。利用を認める肯定条件だけから、他の利用の禁止や値の出所を毎回証明する義務は導かない。提出された入力で働く防御と実際の経路を先に確かめ、別の保証案には独立した義務・違反・影響を求める。根拠のない追加保証は今回不採用として裁定を進める。明示された必須条件や重大な実欠陥は引き続き修正対象にする。

日本語と英語の `review-adjudication` policy はこの判断を冒頭に置き、`review-adjudication-check` instruction は元の指摘を確認した後に追加保証の必要性を判定する順序を明示する。

## 評価入力

`eval/agents/review-adjudication/review-proportionality.yaml` は次の４種類を日英で評価する。

| 入力 | 正しい判断 |
|---|---|
| ordinary | 現在発言へのパス文字列照合を必須化せず、既存の人の turn 制約を確認し、未認証の key 漏えいは修正する |
| reconsider | 実際に manager を追加する watcher 経路を修正し、人の turn 制約と絶対 Git パスの検証を保つ |
| open-normal | 人の事前不採用判断を推測せず、現在発言との照合や別の出所保証を根拠なしに今回必須化しない |
| explicit-current | 現在の認可発言にパスを含める明示条件への違反を修正する |

`reconsider` の fixture は `src/host.mjs` から watcher 観測を `addManager` に渡し、`src/director.mjs` が配列へ登録する。`probe-watch.mjs` を実行して保存した `probe-watch-result.json` は、登録数が０から１になり、登録対象が既存 Git リポジトリであることを示す。提出レビューはこれらの証拠を参照するが、採否の結論は含まない。

`node eval/fixtures/review-proportionality/reconsider/probe-watch.mjs` を再実行し、保存済みの５項目と同じ出力を確認した。

## 再現手順

```sh
npm run build
node eval/scripts/prepare.mjs review-proportionality-ordinary-ja review-proportionality-ordinary-en review-proportionality-reconsider-ja review-proportionality-reconsider-en review-proportionality-open-normal-ja review-proportionality-open-normal-en review-proportionality-explicit-current-ja review-proportionality-explicit-current-en
node eval/scripts/run-evals.mjs review-proportionality --no-cache --repeat 2 --filter-providers 'codex-sol-high|codex-luna-high' --output .tmp/review-proportionality-results.json
node eval/scripts/run-evals.mjs review-proportionality --no-cache --repeat 2 --filter-providers 'claude-opus-5' --output .tmp/review-proportionality-opus-results.json
```

先行評価では base commit `5d7581a8589b1a3be57bcd79369dfe60f0d9e866` の旧文面と候補 v5（`a771ffe94`）を比較した。１反復ごとに独立した workspace を作り、各 workspace で全８入力を Sol High と Luna High に渡した。候補 v5 の全32原応答について、採否、技術的事実、理由を要件と照合した。自動採点の見出しや特定欄の再掲要求が意味上正しい応答を落とした場合は、原文と理由を残して誤検知として裁定した。追加保証の無根拠な必須化、重大欠陥の免除、今回の不必要な保留、技術的事実の誤記は不合格とした。

旧文面を独立した作業場所で再測定する場合は、候補側で新設した評価定義と fixture だけを旧 commit の checkout へ渡し、旧 commit の builtin はそのまま使う。次のコマンドは候補の checkout から実行する。出力先は実行ごとに新しい名前を使う。

```sh
git worktree add --detach /private/tmp/takt-review-proportionality-base 5d7581a8589b1a3be57bcd79369dfe60f0d9e866
rsync -a --exclude=.work --exclude=.results --exclude=prompts eval/ /private/tmp/takt-review-proportionality-base/eval/
git diff --name-only 5d7581a8589b1a3be57bcd79369dfe60f0d9e866 HEAD -- builtins/ja builtins/en | while IFS= read -r path; do
  git show "5d7581a8589b1a3be57bcd79369dfe60f0d9e866:$path" | cmp - "/private/tmp/takt-review-proportionality-base/$path" || exit 1
done
cd /private/tmp/takt-review-proportionality-base
npm ci
npm run build
node eval/scripts/prepare.mjs review-proportionality-ordinary-ja review-proportionality-ordinary-en review-proportionality-reconsider-ja review-proportionality-reconsider-en review-proportionality-open-normal-ja review-proportionality-open-normal-en review-proportionality-explicit-current-ja review-proportionality-explicit-current-en
node eval/scripts/run-evals.mjs review-proportionality --no-cache --repeat 2 --filter-providers 'codex-sol-high|codex-luna-high' --output .tmp/review-proportionality-base-results.json
node - <<'NODE'
const results = require('./.tmp/review-proportionality-base-results.json').results.results;
for (const result of results) {
  console.log(result.provider.label, result.testCase.description, result.success);
  console.log(result.response?.output ?? result.error);
}
NODE
```

旧文面16ファイルの確認対象は候補側で `git diff --name-only 5d7581a8589b1a3be57bcd79369dfe60f0d9e866 HEAD -- builtins/ja builtins/en` として列挙する。各ファイルについて旧 checkout の実ファイルと base の内容の SHA-256 を照合する。候補側も同じ一覧を使い、各独立 workspace の実ファイルと候補 commit の内容を照合する。原応答と採点は各 `--output` の JSON の `results.results[]` に残り、原応答本文は `response.output`、プロンプトは `prompt`、採点は `gradingResult` を参照する。欠落や実行エラーは成功件数へ含めない。

先行評価の対象として base から変更された builtin facet と workflow は日英あわせて16ファイルある。旧文面の３つの独立 workspace では全16ファイルが base の SHA-256 と一致した。候補 v5 の２つの独立 workspace では全16ファイルが `a771ffe94` の候補と一致し、８入力の日英 policy snapshot も同版の policy と一致した。これらはモデル出力の正しさとは別の入力固定確認である。後述する裁定引き継ぎ用の４ facet 追記後に先行評価の全32件と Opus の全16件を再測定したという意味ではない。

## 旧文面の測定と限界

新しい `reconsider` fixture の５資料（director、host、probe、probe結果、提出レビュー）は旧文面の独立 workspace と候補で SHA-256 が一致する。旧文面の `reconsider` 日英×両モデル×２反復は８件とも自動採点を通過し、原応答でも watcher の実欠陥と修正範囲を正しく扱った。他の６入力には同じ fixture の保存原応答を使い、候補と同じ意味基準で対称に再判定する。旧文面の全32件は、原文による意味判定で28件が合格する。

旧文面の自動採点25/32は、rubricを途中で校正した各測定の参考集計である。open-normalなどの旧採点時rubricと現在のrubricは SHA-256 が一致しないため、候補の自動採点率との厳密な同条件比較には使わない。主比較は旧文面と候補の保存原応答を同じ意味基準で読んだ結果とする。旧文面の原応答、入力hash、採点結果は保持する。

旧文面の `reconsider` ３応答は提出レビューにない重大度を付記した。うち１応答はレビュー由来と誤認されうる書き方である。これは出典精度の補助所見として残す。３応答とも watcher の採否と修正境界は正しく判断している。

候補 v5 の事前確認は Luna High の４入力（ordinary-en、reconsider-en、open-normal-ja、explicit-current-en）を１回ずつ実行した。自動採点は4/4で、４原応答の採否・技術的事実・理由も条件に合致した。v4の同じ４入力は初回3/4、同一文面の単発再測定は1/1だったため、v4の初回失敗を取り消していない。

v5を固定して独立 workspace ２つで全８入力を両モデルに１回ずつ渡した。自動採点は１回目14/16（終了コード１）、２回目16/16（終了コード０）で、合計30/32だった。32原応答を個別に確認した意味判定は32/32。１回目の open-normal-ja/en に対する Sol High の自動不合格２件は、原文に技術的な未照合、既存防御、要求、二発言利用への影響、今回修正しない理由が示されており、graderの説明再掲要求による誤検知と判断した。旧文面の意味判定28/32との比較は、この固定した入力に限る改善の観測である。

同じ候補文面で Opus 5 に全８入力を２反復ずつ渡した。16件の実行記録では初期イベントと応答イベントのモデル属性がともに `claude-opus-5` だった。自動採点は15/16、実行エラー０件、評価の終了コードは１。唯一の不合格は open-normal-en の１回目で、grader は呼び出し元の証拠がないことを違反なしの根拠にしたと判定した。原文は未照合という事実を認め、要求にある人の turn と絶対 Git パスの義務、`usage.md` の二発言利用への影響を根拠に今回の本文照合を不採用とした。「他の主体は確認できない」という記述を他の主体が存在しない証明にはしていないため、この自動不合格は誤検知と裁定した。全16原応答で採否・主要な技術的事実・理由を確認した意味判定は16/16。Opus 5 の旧文面は測定しておらず、同モデルでの前後比較は行っていない。

一部の原応答には提出レビューにない重大度の付記や壊れた参照リンクが残る。Opus 5 の open-normal 応答にも入力から確定できないパス引数の決定主体を付記した箇所がある。採否の根拠・受入条件を変えない付随する出力精度の問題として記録し、一般的な出力品質まで合格したとは扱わない。

この先行評価は Phase 1 の裁定８入力と各２反復に限られる。複数周の workflow の収束率や Phase 2 の報告整形は測定していない。自動採点の通過率を一般的な正答率とみなさず、同一文面の少数の再実行で失敗を消さない。

## 前回裁定にある不採用保証の引き継ぎ

先行評価の後、日英の `adjudicate-review-findings` と `review-decision` の計４ facet に、供給された前回裁定の「採らない保証」を最新レビューで再提出されなくても引き継ぐ指示を追加した。更新する場合は元の出典・理由・適用範囲と今回変更する内容を記録する。未供給の履歴を探して判断を作る指示は加えていない。

`review-carry-forward` は２種類の合成入力を日英で評価する。`carry` は前回裁定自身が不採用とした D-42 を最新レビューが再提出せず、別の重大欠陥 F-KEY を提出する。期待する判断は D-42 の出典・二発言確認が有効という理由・人の turn と絶対 Git パスの適用範囲を保持し、F-KEY の未認証キー漏えいを修正対象にすることである。`update` は前回裁定に記録された人の判断 H-42 と現行の同一発言要件を与え、F-PROVENANCE の採否と従前の判断の更新を問う。いずれも提案された正規表現などの特定方式を必須にはしない。

最終版の評価を再実行する手順は次のとおり。モデルの認証情報が必要で、結果は保存済みの測定と別の実行として扱う。

```sh
npm run build
node eval/scripts/prepare.mjs review-adjudication-carry-forward-carry-ja review-adjudication-carry-forward-carry-en review-adjudication-carry-forward-update-ja review-adjudication-carry-forward-update-en
node eval/scripts/run-evals.mjs review-carry-forward --no-cache --filter-providers 'codex-sol-high|codex-luna-high' --output .tmp/review-carry-forward-sol-luna-results.json
node eval/scripts/run-evals.mjs review-carry-forward --no-cache --filter-providers 'claude-opus-5' --output .tmp/review-carry-forward-opus-results.json
```

追加の４ facet より前の `a771ffe94` でも `carry` の日英×Sol・Luna４連鎖を測定した。自動採点は３/４、両フェーズの原文による意味判定は４/４だった。Luna の日本語１件は二発言利用と独立した一致義務の欠如を記しているのに、採点が理由の再掲を不足としたため誤検知と裁定した。この旧版でも対象の判断を保持できたので、最初の継承追記自体による改善効果は実証されていない。追記は曖昧さを除き、後続の回帰を確かめる対象として評価した。旧版の原応答と採点は旧 checkout の `eval/.results/review-carry-forward/base/run3-results.json` と `run3-raw/` に保存した。

初回の `update/requirements.md` は同一発言要件を記載していたが、H-42 後に人が要件を変更したという時系列と判断主体を明示していなかった。初回候補の Sol・Luna 全８連鎖は自動採点７/８、実行エラー０件だった。唯一の不合格である Sol の `update-en` は、現在の実装が要件に反することを確認しつつ、H-42 と現行要件の優先関係を再計画へ返した。入力から要件変更の時点と権限を確定できないため、この留保をモデルの誤判定や採点の誤検知とは扱わない。初回結果、両フェーズの原応答、入力 manifest は `eval/.results/review-carry-forward/candidate/` に保存した。

入力不足を直すため、`update/requirements.md` に H-42 の記録後、人が要件を明示的に変更し、二発言による確認を同一発言条件に置き換えた事実を日英で追加した。採否の結論と再計画の禁止は書いていない。要求ファイルの SHA-256 は初回 `f88b2734a6479b29aaa97c3d80d9397f06a61031616b434d70056d7c62b40764` から `f8d27e4b6137286cc6a1bb462f064732ab0402036d0b49d2fb2ddd5b252dd447` に変わった。`carry` の５資料と `update` の他の３資料、４ facet、評価 rubric は変更していない。初回の保存結果と実行時コピーは上書きしていない。

明確化した `update` だけを Sol High と Luna High で再測定した。日英４連鎖の Phase 1 と同じ応答を渡した Phase 2 は自動採点４/４、実行エラー０件、終了コード０だった。４件の両フェーズ原文でも F-PROVENANCE を修正対象とし、H-42 の出典・理由・元の適用範囲と要件変更後の扱いを記録した。特定の照合方式は必須化していない。初回と入力が同じ `carry` ４件は自動採点４/４で、両フェーズ原文も期待する採否と D-42 の引き継ぎに合致した。最終入力版のこの８連鎖は別々の実行結果を組み合わせたものであり、同時に８件を再実行した結果ではない。明確化した `update` の結果は `eval/.results/review-carry-forward/update-clarified/` に保存した。

同じ最終４入力を Opus 5 でも各１回実行した。４連鎖の Phase 1 と Phase 2 の初期イベントと応答イベントはすべて `claude-opus-5` で、両フェーズの CLI 終了コードも全件０だった。自動採点は３/４、実行エラー０件、評価の終了コードは１。`carry-ja` は D-42 の理由・範囲を保持し F-KEY も修正対象にしたが、両フェーズの末尾で D-42 を「人が採らないと決めた保証」と記した。供給された D-42 の出典は前回裁定であり、人の判断とは記録されていない。この出典誤認は rubric に反する実際の誤りとして残す。他の３件の両フェーズ原文は対象の採否と引き継ぎ・更新に合致した。結果は `eval/.results/review-carry-forward/opus-final/` に保存した。

この実誤りを受けて４ facet に、記録された判断主体を区別し、前回裁定に載っているだけで人の判断とみなさない一般規則を日英で追加した。`carry` と明確化後の `update` の全４入力を、新しい４ facet と同じ rubric で Sol・Luna に１回ずつ渡した。８連鎖の Phase 1 と Phase 2 は自動採点８/８、原文の核心契約も８/８、実行エラー０件、終了コード０だった。`carry` ４件は D-42 を前回裁定の判断と区別し、F-KEY を修正対象にした。`update` ４件は H-42 を人の判断として保持し、従前の理由・範囲と後の正式な要件変更を記して F-PROVENANCE を修正対象にした。Luna の `update-ja` １件は、以前の不採用指摘 F-SOURCE を採用済み問題として「再開」と記した。前回裁定に採用済み問題はないため、この問題IDと状態の整理は不正確である。今回の指摘を採用する根拠と修正条件は現在の要求とコードから独立に成立しており、出典・採否・引き継ぐ理由と範囲は保たれたため、対象契約の判定とは分けた出力精度の所見として残す。結果は `eval/.results/review-carry-forward/source-fixed-sol-luna/` に保存した。

同じ新４ facet と最終４入力で Opus 5 を再測定した。４連鎖の Phase 1 と Phase 2 は自動採点４/４、原文の核心契約も４/４、実行エラー０件、終了コード０だった。全８プロセスの終了コードは０で、初期イベントと応答イベントのモデル属性はすべて `claude-opus-5` だった。以前失敗した `carry-ja` の両フェーズは D-42 を前回裁定の判断と記し、人の判断という誤出典はない。`update-ja/en` は記録に明示された人の判断 H-42 と、その後の人による要件変更を区別して保持した。修正前の Opus ３/４は取り消さず、別の版の実測結果として残す。修正後の結果は `eval/.results/review-carry-forward/source-fixed-opus/` に保存した。

`input-manifest.json` は初回版、明確化後の `update` 版、出典主体の規則を加える前の Opus 版を別々に保存している。初回版では合成入力９ファイルと準備した４コピーが一致した。明確化後は `update` の４資料と４つの実 trial コピー、規則追加前の Opus では最終入力９資料と４つの実 trial コピーが SHA-256 で一致した。４ facet は各実行で対応する候補版と一致した。準備時の prompt と日英 policy snapshot の保存も確認した。この確認は入力固定の証拠であり、モデルの判断が正しいことの証明ではない。

出典主体の規則を加えた版では、修正前後の４ facet の SHA-256 を `source-fixed-sol-luna/input-manifest.json` に記録した。修正版の Sol・Luna 全８実 trial コピーと Opus 全４実 trial コピーは、それぞれ最終入力の９資料の該当ファイルと一致した。Opus の実プロセスのモデル属性も原記録から照合した。先行評価の16ファイル全件と32件・16件のモデル応答は、この最終版で再測定していない。

追加評価は２つの合成事例を各モデル・言語で１回ずつ実行しただけで、複数周の収束や実案件の多様な入力は測定していない。Phase 2 まで評価したのはこの追加評価であり、先行評価の Phase 1 に関する結果へ遡って適用しない。問題 ID や状態の一般的な整理精度、英語 prompt に混在する日本語の影響、Phase 2 の一般的な報告整形品質も未実証である。
