# 実装工程の可否と報告工程の禁止の独立評価

現行報告formatの「現行計画内で実行可能か（可能/不可）」は、不明を欠き、P2のツール/ソース変更禁止を
実装・再実装工程の不可根拠と解釈し得るため、条件付きの用語・対象工程の曖昧さを対象にした。
追加の真のsemantic REDは確認できず、production文言の追加修正は見送った。厳密矛盾は未確認である。
既存v3の保存結果・基準・72生応答は変更せず、別protocolと新規結果directoryを使う。

## 事前固定した範囲

[固定入力/基準](../../cases/report-feasibility.json)の1ケースをJA/EN各3反復、6報告ずつ測る。
同一報告の3義務に実装工程の可否を判定する情報を分けて提示する。

| 義務 | 現行実装/再実装計画の条件 | 期待する可否 |
|---|---|---|
| LOCAL-01: ローカルlabel周辺空白の正規化 | 計画は対象source/testの編集とlocal build/testを許可。認証・外部サービスなしで実build成功/test失敗を観測。修正自体は未実施 | 可能。P2禁止だけを不可の根拠にしない。可能は完了を意味しない |
| ENDPOINT-02: tenant endpointの実record読取 | 必須資格情報なしでprobeがrequest前に停止。取得・権限変更・別環境の手配は現行計画scope外。代替実証なし | 現行計画では不可。P2禁止とは別の具体根拠で判断 |
| TIMESTAMP-03: record読取時のtimestamp保持 | 対象実装・command・実行条件・環境・未実行原因が未提示 | 不明。local編集許可やP2禁止から可/不可を推測しない |

LOCALの編集許可・ENDPOINTのscope・TIMESTAMPの情報不足とP1要約は合成した計画データである。
local fixtureのbuild/test/probeは評価器が実行し、stdout/stderr/exitをfreezeへ保存する。
これは実モデルP1が作業したreceiptではない。probeは評価専用の資格情報がない制御条件でのlocal確認で、
外部tenantサービスへ接続せず、実tenantの認証・相互運用性を実証しない。
graderは実入力とreceiptを比較専用で受け取り、P2の記載欠落をreferenceで補完できない。

target/graderはgpt-6-sol/high、fresh/read-only/approval never、network/Web/skills継承なし、cache無効、
maxConcurrency 3。対象P2のtool使用は不合格、graderのtool使用はinfra。TODO進捗はtoolに数えずSDK errorはinfra。
実engine/AgentRunnerのwrapperを、CodexProvider setup/call境界だけstubしてcaptureする。
各反復は別neutral workspaceで、両revisionの対応sampleは同じ絶対cwdを使い、比較labelやrevisionは対象へ出さない。
fixture/engine資産を毎sampleリセットし、実モデル後もimmutable4file hashを照合する。
root lockfile/Node/npm/実依存treeとruntime package metadataは事前snapshotとcapture・model phase前後で照合する。

## 再現と順序

以下はquotaを使う追加モデル評価であり、unit/契約gateに含めない。
baselineのproductionは811f、評価harnessはその後のTODO/依存guard修正を含む現在の凍結hashである。
baselineを見てから入力/rubricを変えて失敗を作らない。意味上の失敗が0ならREDと呼ばずそのまま記録する。

```bash
npm run build
node --test eval/asserts/report-phase-handoff-v3.test.mjs eval/asserts/report-feasibility.test.mjs
node eval/scripts/report-feasibility.mjs freeze-baseline \
  811f3e4ec1d3a0f97782855f727197e72d90bf7c \
  eval/.results/report-feasibility-rerun /private/tmp/takt-report-feasibility-rerun
node eval/scripts/report-feasibility.mjs red eval/.results/report-feasibility-rerun
```

capture/input/rubric/conditions/harness/fixture/dependency hashesをモデル前に固定する。
rootはbaselineのsummary hash・infra0・6結果を確認し、`baseline-confirmed.json`へ
`baselineOutcome`を`semantic-failure-observed`または`all-targets-passed`で記録する。
真の失敗を確認した後にのみ「RED→修正」として扱う。全合格なら文言明確化が必要かを別途再判定し、
変更する場合もREDを確認した改善とは主張しない。どちらの状態でも候補captureにはrootの明示指示と
`candidateCaptureAuthorizedByRoot: true`が必要で、candidateの上書きは禁止する。
API・tool・dependency監査不備を意味上のREDへ数えない。
runnerのoperation/directory名`red`はbaseline実行の識別子であり、意味上の失敗を観測したという判定ではない。

今回のモデル前の準備先は`eval/.results/report-feasibility-controlled-20261003/`である。
全合格時の確認分岐を追加する前の未測定freezeも保存し、同じ入力・receipt・6captureをbyteそのまま継承して、
変更後の制御フローを含むharness hashを再固定した。変更前freezeのモデル呼び出しは0。
元の未測定manifest hashと事前変更の理由を`preModelRefreeze`へ記録した。

## 実測と別立ての原文監査

未修正のproduction `811f3e4ec1d3a0f97782855f727197e72d90bf7c` を6報告/12graderで実測した。
原[機械集計](baseline-summary.json)は**5/6合格、modelFailures 1、infra 0、exit 1**である。
execution-boundaryとunknown-feasibilityは6/6、implementation-stage-feasibilityは5/6。
この機械結果を変更・再採点していない。

唯一の機械不合格は[JA r1](baseline/ja-implementation-feasibility-r1.output.md)の33行目のENDPOINT-02だった。
graderは、認証情報取得等が不可という記載に留まり、読み取り検証自体の不可を直接明記していないと判定した。
本文は必須認証情報の不在と要求前停止を記録し、完了には計画の前提または範囲を変えてアクセスを用意する
必要があるとしている。rootとwriterは全6生応答を別々に読み、この組合せが現計画での不可の意味を伝えると判断した。
LOCALの実装工程での可、TIMESTAMPの不明は6報告で保持され、P2禁止による不可断定も未検出だった。

[writer原文監査](writer-semantic-audit.json)と[root独立原文監査](root-semantic-audit.json)は、
対象の意味上の違反を0/6、semantic RED未確認と判定した別記録であり、新しい機械スコアではない。
rubricのexplicitを直接の文法ラベルと厳格に読むなら元の不合格を説明できるという留保も残す。
機械5/6を手動6/6へ書き換えたり、採点器を再実行したりしていない。

全18traceは実gpt-6-sol/high/read-only/approval never/fresh/network false/Web disabled、
対象6とgrader12のtool使用0、prompt/output/context/reference/rubric hashesをrootが照合した。
writerも6targetと12graderの保存trace・参照・hashを照合した。
fixture、入力、基準、依存snapshot、capture、測定時harnessの不変を確認している。

候補capture・候補評価・production修正・candidate許可recordの作成は行わなかった。
global orderが不足情報の推測を禁止し、今回6報告は不明を表現できたため、二択placeholderを閉じたenumの
厳密矛盾や実証した挙動不具合と断定しない。対象工程・表示方法の補足余地として残し、今回追加修正は不要とした。
この追加測定でsource改善や「新規RED→修正→GREEN」を証明したとは主張しない。

原summary SHA-256: `0aec2bab5ba7551c7f8cedbfd12980db7780ae97979edc7bb990d9635e9ba4bb`。
測定manifest SHA-256: `db819cdbc452750c65839b2ab78407188e79256fa8b142d3fe8ec36ee0599451`。
[protocol metadata](protocol-metadata.json)は元artifactのhashを付けた派生したcompact記録で、
元manifestと同じbyte/hashのファイルではない。全6生応答をbyteそのままコピーし、実条件、各source prompt・
trace・grader context・input/rubric/fixture/harness/依存hashと実評価器receiptを公開した。
手動監査2ファイルも原byteを保持し、そのsource hashをmetadataへ記録した。
private-turn、推論、内部session ID、認証情報は公開していない。全JSON/prompt/traceはローカル結果directoryに保持する。

モデルを使わない検証は既存v3契約13件＋追加5件の18件、build/lintが成功した。
ログは`/private/tmp/report-feasibility-{contract,build,lint}-20261003.log`に保持した。
既存v3の0/18→17/18→18/18と72応答・原集計のhashは不変で、追加の可否指標を後付けしていない。

## 測定時のharnessと後続修正

このfollow-upで固定したharness7本の本文はcheckpoint
`622d627cfdd6312f419cbcf046087645dbbe7447`に保存した。
metadataの全harness hashesは`git show 622d627cf:eval/<path>`の本文で照合できる
（`<path>`はmetadataに記録したeval配下の相対path）。
元v3測定のharnessは別のrevision `811f3e4ec1d3a0f97782855f727197e72d90bf7c`にあり、
現行runnerと同じ本文だとは主張しない。

測定当時は合成`workResult`がgrader参照で`actualPhase1FinalResponse`という項目名になっていた。
ただしfollow-upの本文自身は「評価者作成の要約であり実際のモデルP1応答ではない」と明記している。
実評価器のfixtureコマンドreceiptと合成の計画・要約、実モデルP1応答を区別する必要がある。
独立レビュー後の現行harnessは合成要約を由来付き`syntheticPhase1Handoff`へ分け、
`actualPhase1FinalResponse`は実モデルP1応答があるケースだけに使う。
P1/P2/graderのfresh条件違反も意味上の失敗ではなくinfraへ分類するよう修正した。

この2つの後続修正は本follow-upの測定には使っておらず、モデルでの効果は未実測である。
保存した全18実traceはfreshであり、この修正を理由に元の機械5/6や別立ての原文監査を変更しない。
入力・基準・production・原summary・生応答・元grader参照とhashは不変、追加モデル呼び出しと再採点は0である。
新規測定には現行harnessを新しいdirectoryでfreezeする必要があり、保存済みのmanifestを再生成しない。
モデルを呼ばない契約20件では実promptfoo経路へSDK stubを通し、P1/P2/grader各fresh違反の
exit 2・infra 1・modelFailures 0と、grader promptでの合成/実P1の由来区別を確認した。
build/lint/`test:types`と`git diff --check`も成功した。ログは
`/private/tmp/report-handoff-r4-{contract,build,lint,types}-20261003.log`に保持した。

後続レビューでも可否欄の「不明」の省略は厳密な矛盾ではなく、表示方法の曖昧さと分類された。
今回6報告はTIMESTAMPの不明を保持し、独立原文監査では真のREDが未確認のため、
REDを確認してから修正する方針に従いproductionの追加変更は行わない。候補GREENも未測定である。
別途、読取監査の複合出力の偽装をローカルの実シェルreceiptで再現・修正した。
修正後の契約検証と保存済み読取の照合は[v3監査記録](../report-phase-handoff-v3/README.md#測定後のharness監査修正)に記載した。

## 限界

1つの合成P1情報隔離ケース、1モデル、日英各3反復に限る。編集許可の合成計画はproductionの
実write能力の測定ではなく、local失敗の修正成功も未測定。全provider・workflow・status judge・
他環境への一般化や、既存v3測定で今回の可否規則まで実証したことは示さない。
