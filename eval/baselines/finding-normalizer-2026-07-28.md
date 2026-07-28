# Finding normalizer baseline — 2026-07-28

## 現行: Finding Contract JSON直接組立（実測済み）

主スイートは既存`RawFindingsOutputJsonSchema`をモデル出力schemaとして直接使う。
中間`claimSections`、`verdictExcerpt`、独自分類、JSON外説明は一切出力させない。

fixtureは今回の測定対象をJSON組立能力に限定するため、次をすべて明示する。

- engine-bound: `rawFindingId/relation/targetFindingId/snapshotId`
- engine検証済みcode evidence:
  `location/evidenceKind/verbatimExcerpt`
- reviewer supplied:
  `familyTag/severity/title/description/suggestion`

モデルは値をコピーして12必須fieldを組み立てるだけで、推論、分類、要約、既定値補完を
行わない。schema適合、全field完全一致、extra key 0、完了状態、時間を測る。
欠落情報、provisional、locationless、multi-evidenceの設計評価は別caseとし、
この比較へ混ぜない。

対象はSol、Luna、Terra、Opus、Haiku、Sonnet、Gemma4の7モデル。

### 結果

| 測定 | Sol/Luna/Terra/Opus/Haiku/Sonnet | Gemma4 |
|---|---:|---:|
| 初回3case | 各3/3 | 2/3 |
| hard multiline case、prompt調整前累計 | 各4/4 | 1/4 |
| escape規則追加後のhard case | 未再実行 | 0/5 |

Gemma4の不合格はすべて、multiline `verbatimExcerpt`のnewlineをliteral `\n`へ
変えたことによる。escape sequenceを一度decodeし、一度だけserializeする規則を
明示しても0/5で、改善しなかった。一方、schema適合、extra key 0、finding件数は
全試行で守られ、12項目中11項目は完全一致した。

したがって、必要値が全て揃ったdirect FC JSON assemblyは6モデルで安定している。
Gemma4は構造を守れるが、multiline逐語コピーが不安定で、この用途の採用候補には
しない。

この結果はfree-form reviewからの意味抽出・分類能力を測っていない。また、
欠落情報、provisional、locationless、複数evidenceを扱う新しいFinding Contract
設計の妥当性も測っていない。

結果artifact:

- `eval/.work/finding-normalizer/results/direct-codex/summary.json`
- `eval/.work/finding-normalizer/results/direct-claude/summary.json`
- `eval/.work/finding-normalizer/results/direct-gemma4/summary.json`
- `eval/.work/finding-normalizer/results/repeat-codex/summary.json`
- `eval/.work/finding-normalizer/results/repeat-claude/summary.json`
- `eval/.work/finding-normalizer/results/repeat-gemma4/summary.json`
- `eval/.work/finding-normalizer/results/tuned-gemma4/summary.json`

## 履歴: one-report extract contract 実測

| model | claim recall | complete section | dangerous asserted escalation | empty reports | execution | max duration |
|---|---:|---:|---:|---:|---:|---:|
| Terra | 7/7 | 7/7 | 0 | 3/3 | 6/6 | 約30秒 |
| Luna | 7/7 | 7/7 | 0 | 3/3 | 6/6 | 約54秒 |
| Haiku（turn capなし） | 7/7 | 7/7 | 0 | 3/3 | 6/6 | 約229秒 |
| Sonnet | 7/7 | 7/7 | 1 | 3/3 | 6/6 | 約57秒 |
| Gemma4 | 7/7* | 7/7* | 1 | 3/3* | 分割完了 | 約521秒 |

\* Gemma4の初回matrixはreport 4到達時に中断し、report 4〜6を別実行した集計。
report 4の別実行は約8秒で、約521秒の応答との分散が大きい。

Terraを第一候補、Lunaを第二候補とする。ただし各1回だけなので暫定順位であり、
採用前に同条件で1 repeatだけ確認する。Haikuはreport 2のsummaryで、原文にない
「type resolution failure / compiler error」を加えたため、抽出後の自由生成を
契約から削除する根拠になった。SonnetとGemma4はmixedをassertedへ強めたため、
certaintyを裁定に使わない。

### 終了・再試行契約

- Claudeには内部`maxTurns`を設定しない。
- 全providerへ10分の外部wall-clock timeoutを適用する。
- Codexは子プロセスを終了、ClaudeはAbortSignal、OpenCodeはAbortSignalと
  shared server cleanupで、孤児処理を残さず中断する。
- timeout/errorは当該実行の失敗結果として保存し、後続matrixを継続する。
- `executionCompleted`は`status === "done"`かつerrorなしの場合だけtrue。
- runnerは自動retryもprovider fallbackもしない。
- fresh retryを将来使う場合、attemptごとに別結果を保存する。同じ結果へ上書きせず、
  規定回数でfail-loudにする。
- 既存の一部Codex artifactは厳格なstatus記録の導入前に生成されたため、再採点では
  `executionCompleted=false`になる。成功を推測して補完しない。

## 直前 intake contract の実験結果

直前実験は、レビュー本文を1件ずつ渡して忠実に構造化した。モデルにはリポジトリ、
元タスク、report ID、claim IDを渡さず、provenanceはrunnerが付与する。

機械判定はschema、tool不使用、候補件数、原文excerpt、source binding、
全locationを個別に測る。title、summary、suggestionの意味忠実性は機械合格だけでは
証明しない。certainty、disposition、severityなどの分類も診断値に留める。

### five-models-r1

- Gemma4、Luna、Terra、Sonnetは全7候補を抽出し、余計な候補はなかった。
- 完了した全モデル応答で、指摘なしのreport 1、5、6は候補0件だった。
- `rawExcerpt`の完全一致はGemma4 7/7、Luna 7/7、Terra 7/7、Sonnet 4/7。
- Haikuはreport 2と3で`maxTurns`に達し、合計5候補が欠落した。完了した
  指摘なしレポートは0件を維持したが、全体比較の候補にはしない。

この1回では、高価格モデルであっても逐語コピーが保証されないことが確認できた。
一方、Gemma4は候補抽出と逐語コピーをこのfixtureで両立した。

### Gemma4 repeat 3

Gemma4を同一fixtureで3回実行した。

- 各runで候補7/7、余計な候補0、指摘なしreport 3/3を維持した。
- claim単位の`rawExcerpt`完全一致は19/21。
- report単位では17/18が全claim完全一致だった。
- 不一致はrepeat 3のreport 4に集中し、文字列中へliteral `\n`を入れたことと、
  LaTeXのバックスラッシュを二重escapeしたことによる。どちらも入力本文との
  完全部分文字列照合で機械検出できる。

certainty、disposition、severityの出力は反復間では安定していたが、goldとは
一貫してずれた。これらを自動制御やモデル採用判断には使わない。

### 当時の暫定判断

- Terra/Sonnet級モデルは、1レポート単位の抽出・要約には不要。
- Gemma4をintake normalizer候補としていた。
- `rawExcerpt`が入力レビューの完全な部分文字列でなければ、同じ入力をfresh
  sessionで再試行する。規定回数失敗した場合は補完せずfail-loudにする。
- この判断は直前契約に対するものであり、最終契約には引き継がない。

## 旧 semantic verifier 実験（rejected exploration）

以下は、PR画像添付タスクのimplement直後を対象に、Gemma4が生成した6件の
自由記述レビューをリポジトリ調査付きで検証した旧実験の比較証跡である。
これはモデル自身にリポジトリ調査と真偽検証を行わせており、normalizerの責務境界に
反する。探索実験として却下済みであり、現行設計、モデル順位、採用判断には使わない。

### 結果

| Normalizer | 6件一括 | 3件ずつ2回 | 裁定 |
|------------|----------|-------------|------|
| `gpt-5.6-luna` | TP 1 / FP 0 / FN 0 | TP 1 / FP 0 / FN 0 | 次段階候補 |
| Claude Haiku | TP 0 / FP 1 / FN 1 | TP 0 / FP 0 / FN 1 | 棄却 |
| `gemma4:31b` | TP 0 / FP 2 / FN 1 | TP 0 / FP 4 / FN 1 | 棄却 |

Lunaの6件一括は137.7秒、3件ずつは合計153.9秒だった。Lunaでは一括の方が
非キャッシュ入力と出力も少なかった。プロバイダー間ではusageの計測定義が異なるため、
トークン値を直接比較しない。

### 意味裁定

Solの敵対レビューにより、唯一のgold findingは
`src/infra/workflow/system/system-git-context.ts` がPR取得結果から
`attachments` と `cleanupAttachments` を落とす一時ディレクトリリークと確定した。
これは候補report 4のcleanup主張を具体的な呼び出し経路で検証したもので、
normalizerによる新規レビューではない。

テスト不存在、`addTask`の未await、型不整合、タイポはfalse positive。
O(N×M)の置換処理は事実だが、実害が立証されていないnon-blocking suggestionであり、
Finding Contractへ昇格させない。

### 当時の判断

- 当時の次反復対象はLuna・6件一括としていたが、現行intake設計には引き継がない。
- この1回だけでは本番採用しない。
- 同一fixtureを最低5反復し、異なるfixtureとscope sentinelも追加する。
- schema適合と逐語引用一致だけでなく、TP=1 / FP=0 / FN=0とclaim lineageを合格条件にする。
