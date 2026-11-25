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

本評価では base commit `5d7581a8589b1a3be57bcd79369dfe60f0d9e866` の旧文面と候補文面を比較する。１反復ごとに独立した workspace を作り、各 workspace で全８入力を Sol High と Luna High に渡す。候補の全32原応答について、採否、技術的事実、理由を要件と照合する。自動採点の見出しや特定欄の再掲要求が意味上正しい応答を落とした場合は、原文と理由を残して誤検知として裁定する。追加保証の無根拠な必須化、重大欠陥の免除、今回の不必要な保留、技術的事実の誤記は不合格とする。

base から変更された builtin facet と workflow は日英あわせて16ファイルある。旧文面の３つの独立 workspace では全16ファイルが base の SHA-256 と一致した。候補の２つの独立 workspace では全16ファイルが現在の候補と一致し、８入力の日英 policy snapshot も候補の policy と一致した。これらはモデル出力の正しさとは別の入力固定確認である。

## 旧文面の測定と限界

新しい `reconsider` fixture の５資料（director、host、probe、probe結果、提出レビュー）は旧文面の独立 workspace と候補で SHA-256 が一致する。旧文面の `reconsider` 日英×両モデル×２反復は８件とも自動採点を通過し、原応答でも watcher の実欠陥と修正範囲を正しく扱った。他の６入力には同じ fixture の保存原応答を使い、候補と同じ意味基準で対称に再判定する。旧文面の全32件は、原文による意味判定で28件が合格する。

旧文面の自動採点25/32は、rubricを途中で校正した各測定の参考集計である。open-normalなどの旧採点時rubricと現在のrubricは SHA-256 が一致しないため、候補の自動採点率との厳密な同条件比較には使わない。主比較は旧文面と候補の保存原応答を同じ意味基準で読んだ結果とする。旧文面の原応答、入力hash、採点結果は保持する。

旧文面の `reconsider` ３応答は提出レビューにない重大度を付記した。うち１応答はレビュー由来と誤認されうる書き方である。これは出典精度の補助所見として残す。３応答とも watcher の採否と修正境界は正しく判断している。

候補 v5 の事前確認は Luna High の４入力（ordinary-en、reconsider-en、open-normal-ja、explicit-current-en）を１回ずつ実行した。自動採点は4/4で、４原応答の採否・技術的事実・理由も条件に合致した。v4の同じ４入力は初回3/4、同一文面の単発再測定は1/1だったため、v4の初回失敗を取り消していない。

v5を固定して独立 workspace ２つで全８入力を両モデルに１回ずつ渡した。自動採点は１回目14/16（終了コード１）、２回目16/16（終了コード０）で、合計30/32だった。32原応答を個別に確認した意味判定は32/32。１回目の open-normal-ja/en に対する Sol High の自動不合格２件は、原文に技術的な未照合、既存防御、要求、二発言利用への影響、今回修正しない理由が示されており、graderの説明再掲要求による誤検知と判断した。旧文面の意味判定28/32との比較は、この固定した入力に限る改善の観測である。

同じ候補文面で Opus 5 に全８入力を２反復ずつ渡した。16件の実行記録では初期イベントと応答イベントのモデル属性がともに `claude-opus-5` だった。自動採点は15/16、実行エラー０件、評価の終了コードは１。唯一の不合格は open-normal-en の１回目で、grader は呼び出し元の証拠がないことを違反なしの根拠にしたと判定した。原文は未照合という事実を認め、要求にある人の turn と絶対 Git パスの義務、`usage.md` の二発言利用への影響を根拠に今回の本文照合を不採用とした。「他の主体は確認できない」という記述を他の主体が存在しない証明にはしていないため、この自動不合格は誤検知と裁定した。全16原応答で採否・主要な技術的事実・理由を確認した意味判定は16/16。Opus 5 の旧文面は測定しておらず、同モデルでの前後比較は行っていない。

一部の原応答には提出レビューにない重大度の付記や壊れた参照リンクが残る。Opus 5 の open-normal 応答にも入力から確定できないパス引数の決定主体を付記した箇所がある。採否の根拠・受入条件を変えない付随する出力精度の問題として記録し、一般的な出力品質まで合格したとは扱わない。

モデル評価は Phase 1 の裁定８入力と各２反復に限られる。複数周の workflow の収束率や Phase 2 の報告整形は測定していない。自動採点の通過率を一般的な正答率とみなさず、同一文面の少数の再実行で失敗を消さない。
