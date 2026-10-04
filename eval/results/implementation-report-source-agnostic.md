# 実装報告の計画受け渡しに関する比較

2026-10-02の追加修正では、要求修正と会話の上流応答をPhase 1から新規Phase 2・再試行・フォールバックへ保持し、作業中の証拠準備、IDのない行の出典識別、状態の優先規則を更新した。この追加修正は実モデルでは未測定である。以下のスコアと凍結成果物は、追加修正前に実行した入力の測定記録として保持し、現在のプロンプトの測定結果として扱わない。

2026-10-02。修正前は `194c20fe2c3b8dbfa075244a832f9de1fb614ae3`、修正後は同コミット上の作業差分。共有の `implementation-report-order` を日英とも、固定名の計画ファイルではなく実際に渡された計画・上流完了契約を出典とする文面へ変更した。既存のID・由来・成立条件・意味の保持と、実在する情報・証拠不足を未完了として記録する条件は維持した。

以下の比較と「修正後」スコアは、独立レビュー前の初版candidateの結果である。初版のプロンプト全文とhashは下記成果物の `after-manifest.json` / `after-*.prompt.md` に保存しており、現在の最終文面の測定結果として扱わない。独立レビュー後は対象を「完了契約として定義された行」に明確に限定し、要件・スコープ・影響経路表が混在するheldoutケースを追加した。この追加ケースは以下の初版スコアに含めない。

## 条件

既存の3条件を保持し、任意名 `delivery-obligations.md`、番号付き名 `07-design-acceptance.md`、ファイルにせず会話で渡した計画の3条件を追加した。日英各6ケースを3反復した。入力全文と意味を判定するルーブリックを凍結し、修正前の日英を完了してから修正後の日英を開始した。修正前後でケース入力・ルーブリックのhashが一致している。

既存の `eval/scripts/prepare.mjs` が生成した実Phase 2プロンプトを保存し、`eval/scripts/run-evals.mjs` で `--no-cache --repeat 3 --max-concurrency 2` を指定した。言語ごとの比較は同じ入力で行い、日英を並行実行した際の最大同時実行数は合計4。

- 対象・grader: `openai:codex-sdk`、`gpt-6-sol`、reasoning effort `high`。
- sandbox: `read-only`、approval `never`、ネットワークツール・Web検索無効。Phase 2本文はツール使用を禁止する。
- 依存: lockfile準拠のPi `0.85.1`、Codex SDK `0.156.1`、promptfoo `0.121.17`。
- 評価設定のモデル固定は実験用。通常のsuite設定は元のprovider・effort `low`を維持する。

最初に指定した `gpt-6.1-sol` はアカウントで未対応のため18件のprovider errorとなった。記録を保存し、新しい出力先で対応モデルに固定して比較をやり直した。この失敗は以下のケース判定に含めない。

## 結果

値はルーブリック合格数 / 3。未完了と報告すべき契約を正しく未完了とした応答も合格に含む。

| 条件 | 日本語 修正前 | 日本語 修正後 | 英語 修正前 | 英語 修正後 |
|---|---|---|---|---|
| 計画行のみ、追加台帳・新発見なし | 3/3 | 3/3 | 3/3 | 3/3 |
| ID・意味と異なる順序の証拠 | 3/3 | 1/3 | 2/3 | 3/3 |
| 実在する未実行テストの証拠不足 | 3/3 | 3/3 | 3/3 | 3/3 |
| 任意名の計画とテスト工程の新発見 | 3/3 | 3/3 | 2/3 | 3/3 |
| 番号付き計画と実在する証拠不足 | 3/3 | 3/3 | 3/3 | 3/3 |
| 会話で渡した計画、計画ファイルなし | 3/3 | 3/3 | 3/3 | 3/3 |
| 合計 | 18/18 | 16/18 | 16/18 | 18/18 |

対応モデルでのprovider errorは修正前後とも0。総合は34/36から34/36であり、総合合格率の改善や全件合格とはしない。

英語の任意名ケースでは、修正前の第2反復が、提示済みの計画とは別の固定名の原文がないことを未確認範囲に追加した。修正後の3応答では4つの契約ID・由来・意味・各テスト観測を保持し、その不要な原文要求を追加しなかった。英語の既存証拠対応ケースの修正前第2反復にも同じ固定名要求があった。これは今回の懸念を直接再現し、任意名ケースの2/3から3/3は限定した改善信号となる。日本語の追加3条件は修正前からすべて合格しており、日本語について改善効果を示す差はない。

修正後の日本語2不合格は、既存の証拠対応ケースの第2・第3反復。応答は全ID・由来・意味と個別観測値を保持し、実装箇所・テスト原記録が未提示であることを未完了・未確認範囲に記録した。graderは引継ぎ報告にとどまり直接証拠が不足すると判定した。このfixtureは元からテスト名・観測値のみで、実装箇所や原記録を含まない。ルーブリックにおける直接証拠の要求境界は未解決の評価限界として残し、スコアを変更しない。実在する不足を隠す文面変更も行わない。

既存の証拠不足ケースと番号付き名の証拠不足ケースは、修正後の日英計12応答でも未実行の `CTR-02` を未完了とし、未確認範囲にそのテスト未実行・未観測を記録していた。`trim()`や他の成功テストから完了を推測していないことを生の契約行と未確認範囲でも確認した。

## 実行証拠と再現

ローカル成果物は `/tmp/pr1652-source-agnostic-eval-gpt6sol-20261002/`。`before-manifest.json` / `after-manifest.json` に入力・ルーブリック・プロンプトとhash、設定を保持する。`safe-samples.json` と `samples/*.output.md` は全72応答と採点理由、実行プロンプト・出力hashを保持し、session IDを含めない。promptfooはファイル由来の変数の前後空白を取り除くため、実行プロンプトhashにはその読み込み結果を用いる。修正前manifestの単純な生入力置換hashと、実行時のhashは区別する。

対象の保存されたraw turnは全72件ともツール項目なし。graderを含めた今回の専用cwdの実session記録も監査し、対象72回・grader72回すべて `gpt-6-sol` / `high` / `read-only`、ツール呼び出し0件だった。`runtime-trace-audit.json` はこれらの情報と実行プロンプトhashだけを保持し、認証情報・ユーザー識別子・session ID・raw sessionはコピーしていない。fixtureの固定名レポートは読まれていない。

凍結した config・プロンプト・manifest は [リポジトリ内の評価入力](implementation-report-source-agnostic/README.md) に保存した。初版比較は `initial-comparison/`、混在表評価は `mixed-planning/`、最終r1の6ケース回帰は `final-regression/` に分けている。通常 suite の `low` は維持し、専用 config の対象・grader を `gpt-6-sol` / `high` に固定した。入力とrubricはインラインで保持し、configのプロンプト参照と実行cwdだけを相対化している。プロンプト本文と既存hashは評価時のまま保持する。

リポジトリのルートで依存を導入・buildした後、最終r1の英語6ケースを同じ条件で再実行する例:

```sh
npm run eval:prompts:prepare -- implementation-report-contract-traceability implementation-report-contract-traceability-en
mkdir -p eval/.results/implementation-report-source-agnostic
PROMPTFOO_CONFIG_DIR=.tmp/promptfoo npm exec -- promptfoo eval \
  -c eval/results/implementation-report-source-agnostic/final-regression/final-en.frozen.yaml \
  --no-cache --repeat 3 --max-concurrency 2 \
  --output eval/.results/implementation-report-source-agnostic/final-en.rerun.json
```

この比較は提示済み作業結果からのPhase 2報告を測る。実装実行、Phase 1の計画取得、workflow全体の成功率は測定しない。各ケース3反復・単一モデルであり、一般的な失敗率を推定しない。

局所検証はbuild、lint、fast unit（416ファイル / 6,655テスト）、light IT（163ファイル / 2,590テスト）、関連プロンプト・workflow loader（unit 83件 / classified 138件）、eval provider・registry・composition契約25件、最終registry 9件が合格した。

## 独立レビュー後の混在表評価

レビューで日本語の「全行」「計画行」が完了契約以外の計画表まで含み得ると指摘された。r1では日英とも「完了契約として定義された行」に対象を限定した。固定の見出し・表形式・ファイル名は要求しない。

新しいheldout入力は、要件・スコープ・影響経路の表と、別見出しの3つの完了契約を同じ計画文脈で渡す。義務ID・由来・条件・渡された個別観測を保持し、他の表を架空の契約行や重複行へ昇格しないことを採点した。このrubricは `Verified` を必須とせず、引継ぎ証拠の採用可否を判定しない。既存6ケースの入力・rubric・スコアは変更していない。

| 言語 | 初版candidate | r1 |
|---|---|---|
| 日本語 | 3/3 | 3/3 |
| 英語 | 3/3 | 3/3 |

初版日英を完了してからr1日英を実行し、対象・graderとも `gpt-6-sol` / `high`、生成キャッシュ無効、同一入力・rubricで各3反復した。provider errorは0。初版から全合格のため、この縮約ケースではレビュー指摘の曖昧さを実失敗として再現しておらず、改善効果を示す差とはしない。上の初版6ケース比較とは異なる入力・rubricなので、合算した合格率も示さない。

r1の全6応答の契約表を直接確認し、`CTR-01`～`CTR-03` が各1行、計画由来と `REQ-11` / `REQ-12` の関係、条件と各観測値を維持していた。`CTR-02` の影響経路は別節へ記録され、追加完了契約にはなっていない。

成果物は `/tmp/pr1652-source-agnostic-r1-mixed-eval-20261002/`。`manifest.json`、`*.facet.md`、`*.prompt.md` は初版とr1の全文・hashを別々に保持する。`safe-samples.json` / `samples/*.output.md` に12応答と採点理由を保存。実行プロンプトhashは12件とも凍結した値と一致し、対象12回・grader12回の実session監査も `gpt-6-sol` / `high` / `read-only`、ツール呼び出し0件だった。認証情報・識別子・raw sessionはコピーしていない。r1のbuildと関連eval契約25件も合格した。

既存証拠ケースの採用境界については、この混在表評価から仕様判断を行わない。

## 最終r1の既存6ケース回帰評価

独立レビューr2の指摘を受け、現在の最終r1文面で、混在表を除いた既存の日英6ケースを各3反復した。修正前の36試行は上の保存済み記録を再利用し、最終r1の36試行を新しく実行した。初版の入力全文・rubric・hashと、現行suiteの先頭6件を照合して一致を確認した。既存スコアや証拠採用基準は変更していない。今回のプロンプト全文・facetのhashは、混在表評価のr1と日英とも一致する。

値は同じrubricの合格数 / 3。初版candidateの「修正後」表を上書きせず、最終文面の測定として分けて記録する。

| 条件 | 日本語 修正前（再利用） | 日本語 最終r1 | 英語 修正前（再利用） | 英語 最終r1 |
|---|---|---|---|---|
| 計画行のみ、追加台帳・新発見なし | 3/3 | 3/3 | 3/3 | 3/3 |
| ID・意味と異なる順序の証拠 | 3/3 | 3/3 | 2/3 | 3/3 |
| 実在する未実行テストの証拠不足 | 3/3 | 3/3 | 3/3 | 3/3 |
| 任意名の計画とテスト工程の新発見 | 3/3 | 3/3 | 2/3 | 3/3 |
| 番号付き計画と実在する証拠不足 | 3/3 | 3/3 | 3/3 | 3/3 |
| 会話で渡した計画、計画ファイルなし | 3/3 | 3/3 | 3/3 | 3/3 |
| 合計 | 18/18 | 18/18 | 16/18 | 18/18 |

最終r1はrubric上36/36合格、ケース判定不合格0、provider error0、日英とも終了コード0だった。混在表のスコアとは合算しない。入力・rubricを固定した3反復の観測結果であり、安定した失敗率や証拠採用境界の解決を示すものではない。

全36応答の契約行と未確認範囲を確認した。`CTR-01`～`CTR-03`、該当するケースの `TEST-DISC-01` はそれぞれ独立した行で、ID・計画/テスト工程の由来・義務の意味・渡された個別観測値を保持していた。任意名・番号付き名・会話渡しの応答に、別の固定名計画や台帳の原文要求はなかった。実在する証拠不足の2ケースは日英計12応答とも、未実行・未観測の `CTR-02` を未完了とし、未確認範囲に必要な追加実行を記録していた。他の成功テストや `trim()` だけから完了を推測していない。

既存の証拠対応ケースと任意名ケースは、最終r1の日英計12応答すべてで、渡された成功結果を保持しつつ、実装箇所・実行対象・原記録等が未提示であることを理由に4契約を未完了としていた。今回のgraderは個別のID・意味・証拠対応を理由に合格としている。同種の未完了応答が初版の日本語では不合格になっており、採点の揺れと直接証拠の採用境界は残る。36/36を「引継ぎ報告だけでVerifiedにできる」という仕様判断や、当該境界の改善として扱わない。

成果物は `/tmp/pr1652-source-agnostic-r1-regression-gpt6sol-20261002/`。`manifest.json`、`final-*.prompt.md`、`final-*.facet.md`、`final-*.frozen.yaml` に全文・hash・既存6件の明示選択・設定を保存した。通常suiteを変更せず、lockfile準拠のローカルpromptfooへ凍結configを渡し、対象・graderとも `gpt-6-sol` / `high`、`read-only`、approval `never`、ネットワークツール・Web検索無効、`--no-cache --repeat 3 --max-concurrency 2` で日英を並行実行した。Phase 2本文のツール禁止も維持した。

`safe-samples.json` / `samples/*.output.md` は36応答と元の採点理由、`summary.json` は件数を保持する。`contract-row-audit.json` は計120契約行のID・観測された状態と12件の実在gapの記録を補助確認する。実行プロンプトhashは全36件で凍結値と一致した。対象36回・grader36回の実sessionを、今回の開始時刻・専用cwd・実行prompt hashで特定して監査し、全72回で `gpt-6-sol` / `high` / `read-only` / approval `never`、ツール呼び出し0件を確認した。監査要約は `runtime-trace-audit.json` に保存し、認証情報・ユーザー識別子・session ID・raw sessionをコピーしていない。固定名のseed計画は読まれていない。

この回帰評価の初回launchは外側sandboxによるSDK app-server初期化の `Operation not permitted` で、モデル呼び出し前に36件のprovider errorとなった。失敗記録を `/tmp/pr1652-source-agnostic-r1-regression-eval-20261002/` に保持し、同じ入力・rubric・モデル・対象のread-only設定で、外側の実行権限を許可された別出力先に再実行した。この36件はケース判定に含めない。最終評価後の関連eval契約25件と差分の空白検査は合格した。

## 最新main統合後の確認

2026-10-02、`origin/main` の `e8246a5ac` を統合した。競合した `eval/scripts/prepare.mjs` はmainのfixture設定・日英の同期済みconfig評価を保持し、report評価に必要な言語別config切替と実Phase 2合成を維持した。`eval/suite-registry.mjs` はmainの新しい日英suite登録と、英語report評価の明示実行登録を両方保持した。日英の既存3＋追加4ケース、rubric、証拠採用基準は変更していない。

統合後にbuildして生成したPhase 2全文とfacetは、最終r1の実モデル評価で保存したものと4件とも同一だった。比較記録は `/tmp/pr1652-merge-main-prompt-hash-audit.json`。実モデルの再評価は行っていない。

| 対象 | 最終r1と統合後で一致したSHA-256 |
|---|---|
| 日本語facet | `cd7616ad19aebb4f065608a4c753d20d53f14961eed8186a3e4c3c71bc059e42` |
| 日本語Phase 2 | `71974e8c908086970048323500bcb3daabe9bf47f5505addfc0e7ba7a0a12974` |
| 英語facet | `f2e76e8398c1b865c1ad661f2340bfb84f05a3ad0fb8d2ff8cf2a8bb72c33b24` |
| 英語Phase 2 | `6863256a301b3e7197e93c965edc3bbe3c76a66bfb8b27c4082d62baee84e253` |

最新lockfile準拠の `npm ci --ignore-scripts` 後、build・lint、unit 417ファイル / 6,734件、light IT 164ファイル / 2,715件、eval prepare/provider/registry契約28件、OpenCode v1 probe 11件が合格した。mock E2E smokeは6ファイル / 19件合格、既存のGitHub issue連携1ファイル / 1件はskipだった。差分の空白検査も合格した。

OpenCode probeの初回11件はPATH上のv2.0.21 CLIにより起動待ちtimeoutとなった。隔離環境でv2の起動stdoutを直接確認し、既存v1 SDKが待つ成功出力との不一致を特定した。文書にある検証済みv1 CLI 1.18.2を専用 `/tmp/pr1652-opencode-v1-cli-20261002/` へ導入し、必要なpostinstallを明示実行して実バージョンを確認後、同じprobe全11件が終了コード0で合格した。グローバルCLI・repo lockfile・probeコードは変更していない。失敗記録と成功記録は `/tmp/pr1652-merge-main-opencode-probe*.log` に保持する。既存の採点揺れと証拠採用境界は引き続き未解決であり、今回の統合では仕様判断を行わない。

## CodeRabbit対応後の入力保存検証

2026-10-02、3評価の凍結入力をリポジトリへ保存した。10 config・40ケースについて元の成果物との入力・rubric・provider設定の一致と、保存済み本文・facet・入力・rubric・記録済み実行プロンプトのhashを確認した。各configはpromptfooの設定検証を通過し、別ディレクトリへコピーしてもプロンプトと実行cwdを相対パスで解決できた。通常suiteの日英target・graderのeffortは `low` のまま。実モデル評価と再採点は行っていない。

lockfileと異なるPiが導入されていたため依存を再導入した後、build・lint、unit 417ファイル / 6,734件、light IT 164ファイル / 2,715件、eval契約44件、mock E2E smoke 19件（既存skip 1件）が合格した。OpenCode v1 probeは外側sandboxのローカルポート制限で初回起動に失敗し、同じ検証を制限外で再実行して11件合格した。保存済みプロンプト末尾の空行は元のhashを維持するため保持し、それ以外の差分空白検査も合格した。
