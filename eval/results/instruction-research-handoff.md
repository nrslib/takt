# Instruction research handoff prompt evaluation

この評価は、会話の要約から実行指示書を作る責務と、その後段の plan・report・judge の責務を、同じ入力で比較するための固定回帰です。ケースは10件で、summary 5件、plan 3件、report 1件、judge 1件です。生成には本番の prompt builder と routing scorer を使い、semantic rubric の判定には `gpt-5.6-luna/max` を使います。生成側には role 付きの会話または task/report と隔離fixtureだけを渡し、rubric・期待結果・採点基準は judge 側へ分離しています。

対象モデルは既存 matrix と同じ次の4つです。

| Provider | Model / effort |
| --- | --- |
| Claude Opus | `claude-opus-5` |
| Codex Sol | `gpt-5.6-sol` / `high` |
| Codex Luna | `gpt-5.6-luna` / `max` |
| Kimi K3 | `moonshotai/kimi-k3` |

Kimi K3 は残高不足による provider failure が確認されたため、今回の実行では `--skip-provider kimi-k3` を baseline と candidate の両方へ指定しました。matrix の行は削除せず、4モデル×10ケースの40行を生成し、Kimiの10行は `infrastructure_failure` として保存しています。代替モデルへの置換はしていません。

## Before / after

Before はAの本番summary prompt変更前に保存したtarget rawを、最終fixture evidenceとrubricで再採点した `baseline-rescored` です。After はA変更後に生成したcandidate rawを、同じ最終rubricで再採点した `candidate-rescored` です。再採点ではtarget modelを再生成していません。

採点側で発生したJSON抽出エラーはmodel failureと混同せず、保存済み回答を同一条件で再採点して得た完全な最終runを比較に使っています。

| Model | Before summary | After summary | Before total | After total | B responsibilities |
| --- | ---: | ---: | ---: | ---: | --- |
| `claude-opus-5` | 5/5 | 5/5 | 10/10 | 10/10 | 5/5 → 5/5 |
| `gpt-5.6-sol/high` | 4/5 | 5/5 | 9/10 | 10/10 | 5/5 → 5/5 |
| `gpt-5.6-luna/max` | 5/5 | 5/5 | 10/10 | 10/10 | 5/5 → 5/5 |
| `moonshotai/kimi-k3` | 0/5（infra） | 0/5（infra） | 0/10（infra） | 0/10（infra） | 0/5（infra） |

唯一の実REDは `gpt-5.6-sol/high` の `summary-limited-approval` でした。Beforeは、assistantが出した `config/configOverrides` 案を確定方式へ昇格し、直前の「モック中心・実APIなし・手動確認手順を残す」だけへの短い `OK` を、profile方式や実装範囲までの了承として扱いました。Afterは、ユーザーの `--profile` と専用configファイル要求、限定了承、assistant案の未確定状態を分離して保持し、5/5になりました。positive controlではユーザーが明示採用した `configOverrides` を保持し、contradiction controlでは確認済みの互換性矛盾をユーザー判断待ちとして停止することを確認しています。

plan・report・judgeは、技術調査、後段の外部検証、ユーザー判断を分離するケースを含めて3モデル全件passでした。そのためBの本番promptは変更していません。Bのケースと採点基盤は、Aの共通評価基盤に含めて回帰対照として保持しています。Grill固有の権限変更はこの作業範囲に含めず、別変更で管理します。

## 再現

リポジトリの作業treeで、Kimiをskipする場合は同じflagをbaselineとcandidateへ渡します。

```sh
node eval/scripts/instruction-research-handoff-eval.mjs baseline \
  .tmp/instruction-research-handoff-baseline \
  --skip-provider kimi-k3
node eval/scripts/instruction-research-handoff-eval.mjs candidate \
  .tmp/instruction-research-handoff-baseline \
  .tmp/instruction-research-handoff-candidate \
  --skip-provider kimi-k3
```

採点基準やjudge-onlyのfixture evidenceだけを更新する場合は、保存済みsource promptとraw responseを再利用できます。

```sh
node eval/scripts/instruction-research-handoff-eval.mjs rescore \
  .tmp/instruction-research-handoff-baseline \
  .tmp/instruction-research-handoff-rescored
```

rescoreはcasesHash、fixture各ファイルのSHA-256、inputHash、保存promptHashを検証し、差分があれば停止します。manifestのcanonical JSONに対するSHA-256を `manifestHash` とし、再採点元manifestのファイルbytesに対するSHA-256を `rescoredFromManifestFileSha256` として記録します。candidate由来の再採点は `sourceRevision: candidate`、`revision: candidate-rescored` として保存し、baseline由来と混同しないようにしています。

最終比較に使ったローカルartifactは次の通りです。

```text
.tmp/instruction-research-handoff-baseline-rescored-final-v2
.tmp/instruction-research-handoff-candidate-rescored-final
```

両方ともケース数40行、fixture aggregate hash
`783fcbbe39db33d835708460cb9bc784db55eba7a1d400ad951057309cc82b84`、同じ casesHash
`05c2632c4d096837a897f9f7569b6865cf390f290151a980fef729c37bbe0e45` を保持しています。summaryのrubricHash配列と全inputHashは一致し、summary prompt 5件だけpromptHashが異なります。raw response、judge理由、promptfooの全evaluation resultも各artifactに保存しています。

## 判定方法と限界

- semantic項目は固定語の出現ではなく、source context、役割、了承の範囲、出力中の根拠引用をsemantic judgeで判定します。
- fixtureの相対path・内容・SHA-256と、評価側で実行した `npm test`（3 tests、3 pass、0 fail）をjudge-only evidenceとして渡します。一時workspaceの絶対pathはfixture内の相対pathへ正規化します。
- Phase 3のjudge caseだけは本番の遷移 scorerで `[PLAN:1]` をpass、`[PLAN:3]` とタグなしをfailとする決定的チェックです。
- これは固定fixtureに対するprompt回帰であり、実製品の機能動作や外部SDKの互換性を証明するE2Eではありません。モデル出力とsemantic judgeには確率性があります。
- Kimi K3は残高不足で未評価です。利用可能になった時点で同じcases、fixture、matrix設定で再実行してください。
- リポジトリのOpenCode probeは10/11でした。唯一のprompt-capture timeoutは変更前のclean baseでも再現したため、今回のprompt/eval差分による失敗とは扱っていません。

通常ゲートの記録は、build、lint、unit 6203/6203、light IT 2605/2605、E2E smoke 19 pass・1 skipです。eval契約テストは10/10、fixtureテストは3/3 passでした。
