# Instruction research handoff prompt evaluation

この評価は、会話の要約から実行指示書を作る責務と、その後段の plan・report・judge の責務を、同じ入力で比較するための固定回帰です。ケースは10件で、summary 5件、plan 3件、report 1件、judge 1件です。生成には本番の prompt builder と routing scorer を使い、semantic rubric の判定には `gpt-5.6-luna/max` を使います。生成側には role 付きの会話または task/report と隔離fixtureだけを渡し、rubric・期待結果・採点基準は judge 側へ分離しています。

対象モデルは既存 matrix と同じ次の4つです。

| Provider | Model / effort |
| --- | --- |
| Claude Opus | `claude-opus-5` |
| Codex Sol | `gpt-5.6-sol` / `high` |
| Codex Luna | `gpt-5.6-luna` / `max` |
| Kimi K3 | `moonshotai/kimi-k3` |

元の4-provider matrixでは、Kimi K3（OpenCode 経由 `moonshotai/kimi-k3`）の残高不足による provider failure が確認されたため、baseline と candidate の両方で `--skip-provider kimi-k3` を指定しました。matrixの行は削除せず、4モデル×10ケースの40行を生成し、Kimiの10行は `infrastructure_failure` として保存しています。代替モデルへの置換はしていません。Kimi Code CLI（`kimi-code/k3`）は別の認証経路による補足評価として扱います。

明示的にskipした行はmatrix上は未評価のinfra行として残りますが、修正後のCLI終了コードはactive行だけで判定します。active providerが完了していれば終了コード0で、active行のinfra／未実行は2、candidate由来のrescoreを含むcandidateのactive model failureは1です。baseline由来のrescoreはREDを記録するため、active行が完了していれば0です。修正後の終了コード0も4モデル完了を意味しません。最終比較artifactを作成した保存runの終了コードは旧仕様の2でしたが、保存したraw／rowsの内容は変更していません。全providerをskipする指定は受け付けません。

## 元のmatrixのBefore / after

Before はAの本番summary prompt変更前に保存したtarget rawを、最終fixture evidenceとrubricで再採点した `baseline-rescored` です。After はA変更後に生成したcandidate rawを、同じ最終rubricで再採点した `candidate-rescored` です。再採点ではtarget modelを再生成していません。

採点側で発生したJSON抽出エラーはmodel failureと混同せず、保存済み回答を同一条件で再採点して得た完全な最終runを比較に使っています。

| Model | Before summary | After summary | Before total | After total | B responsibilities |
| --- | ---: | ---: | ---: | ---: | --- |
| `claude-opus-5` | 5/5 | 5/5 | 10/10 | 10/10 | 5/5 → 5/5 |
| `gpt-5.6-sol/high` | 4/5 | 5/5 | 9/10 | 10/10 | 5/5 → 5/5 |
| `gpt-5.6-luna/max` | 5/5 | 5/5 | 10/10 | 10/10 | 5/5 → 5/5 |
| `moonshotai/kimi-k3` | 0/5（infra） | 0/5（infra） | 0/10（infra） | 0/10（infra） | 0/5（infra） |

元のmatrixでA変更前に確認されたmodel REDは `gpt-5.6-sol/high` の `summary-limited-approval` でした。Beforeは、assistantが出した `config/configOverrides` 案を確定方式へ昇格し、直前の「モック中心・実APIなし・手動確認手順を残す」だけへの短い `OK` を、profile方式や実装範囲までの了承として扱いました。Afterは、ユーザーの `--profile` と専用configファイル要求、限定了承、assistant案の未確定状態を分離して保持し、5/5になりました。positive controlではユーザーが明示採用した `configOverrides` を保持し、contradiction controlでは確認済みの互換性矛盾をユーザー判断待ちとして停止することを確認しています。

plan・report・judgeは、技術調査、後段の外部検証、ユーザー判断を分離するケースを含めて3モデル全件passでした。そのためBの本番promptは変更していません。Bのケースと採点基盤は、Aの共通評価基盤に含めて回帰対照として保持しています。Grill固有の権限変更はこの作業範囲に含めず、別変更で管理します。

## 追加prompt修正とKimi CLI補足

初回Kimi CLI補足は、保存済みbaseline/candidate promptとrubricでbaseline 10件・candidate 10件の初回実走回答20件を保存し（`.tmp/instruction-research-handoff-kimi-cli-initial`）、その保存rawを再採点したものです。採点時に回答は再生成していません。初回runのsession list回収はcwd表記差でinfraになったため、stdoutのsession IDと実体のstate/wireをrootが照合し、rawを変更せずprovenanceだけを `.tmp/instruction-research-handoff-kimi-cli-recovered-source` へ補完しました。`.tmp/instruction-research-handoff-kimi-cli-scored` では、baselineが9/10、candidateが9/10、infra failureは0件でした。baselineのREDは `summary-limited-approval`、candidateのREDは `summary-unconfirmed-method` です。candidateの回答は、assistantだけが提案した「採用しない方式」を必須制約へ昇格し、ユーザーの異議がないことを了承根拠として扱いました。これは候補の採用だけでなく禁止・除外もユーザー明示なしには確定しないこと、沈黙・異議なし・話題移動を了承根拠にしないこと、観察したAPIやテストを根拠なく変更禁止へ変換しないこと、委譲された調査や方式選択に新たな承認gateを足さないことを追加promptで明示する契機になりました。

追加prompt修正後の3モデルcandidate評価は `.tmp/instruction-research-handoff-candidate-silence-v2` に保存され、Claude Opus、Codex Sol、Codex Lunaの各10/10（合計30/30）がpass、infra failureは0件でした。Kimi CLIの同条件candidate-only評価は `.tmp/instruction-research-handoff-kimi-cli-candidate-silence-v2` に保存され、10/10、infra failure 0件、unexecuted 0件、exit 0でした。これはcandidate 10件だけを実行したartifactであり、初回20行artifactの結果を追加prompt修正後の最終candidateへ代用していません。元のsource artifact、初回Kimi CLI artifact、保存済みrawとrowsは不変です。

追加prompt修正前後の4モデル結果は次の通りです。Opus/Sol/LunaのBeforeは元matrixのbaseline、Afterはcandidateです。Kimi CLIのBeforeは初回CLI補足のbaseline、Afterは追加prompt修正後のcandidate-onlyです。

| Model / route | Before summary | After summary | Before total | After total | B responsibilities |
| --- | ---: | ---: | ---: | ---: | --- |
| `claude-opus-5` | 5/5 | 5/5 | 10/10 | 10/10 | 5/5 → 5/5 |
| `gpt-5.6-sol/high` | 4/5 | 5/5 | 9/10 | 10/10 | 5/5 → 5/5 |
| `gpt-5.6-luna/max` | 5/5 | 5/5 | 10/10 | 10/10 | 5/5 → 5/5 |
| `KimiCodeCLI K3/high補足` (`kimi-code/k3`) | 4/5 | 5/5 | 9/10 | 10/10 | 5/5 → 5/5 |

Kimi CLIの実行証跡は、各10行のprovenanceでCLI `0.43.1`、要求alias `kimi-code/k3`、wire上の実model `k3`、全 `llm.request` の `thinkingEffort: high`、stdoutのsession IDとsession listの実ID一致、`completed`、raw/state/wireのSHA-256を確認しています。`agentsMdPaths=[]` かつsubagentなしという点はrunnerの自動保証ではなく、評価担当が実sessionのprofile.bind・agents directory・raw/wire/state SHAを直接監査した結果です。この直接監査のprivate記録は `.tmp/instruction-research-handoff-kimi-cli-candidate-silence-v2-audit.json`（SHA-256 `d7fb0cc147a7320c6c4a8eab42f4adedb03692ba7cd3a5db2ee7652d753d20bf`）です。managed endpointは指定したprivate route probeの証跡で確認し、未指定時はunknownとして記録します。元matrixのOpenCode Kimiは残高不足のままinfraとして保持し、CLI経路で置換していません。

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

元matrixの再採点に使ったローカルartifactは次の通りです。

```text
.tmp/instruction-research-handoff-baseline-rescored-final-v2
.tmp/instruction-research-handoff-candidate-rescored-final
```

追加prompt修正後の4モデル比較には、次のcandidate artifactも使いました。

```text
.tmp/instruction-research-handoff-candidate-silence-v2
.tmp/instruction-research-handoff-kimi-cli-candidate-silence-v2
```

元matrixの上記2 artifactはそれぞれ40行、fixture aggregate hash
`783fcbbe39db33d835708460cb9bc784db55eba7a1d400ad951057309cc82b84`、同じ casesHash
`05c2632c4d096837a897f9f7569b6865cf390f290151a980fef729c37bbe0e45` を保持しています。summaryのrubricHash配列と全inputHashは一致し、summary prompt 5件だけpromptHashが異なります。raw response、judge理由、promptfooの全evaluation resultも各artifactに保存しています。
追加prompt修正後の3モデル実行対象は30行で、旧Kimiのskip記録10行を含むartifact全体は40行です。Kimi CLI candidate-only artifactの実行対象は10行です。

## 判定方法と限界

- semantic項目は固定語の出現ではなく、source context、役割、了承の範囲、出力中の根拠引用をsemantic judgeで判定します。
- fixtureの相対path・内容・SHA-256と、評価側で実行した `npm test`（3 tests、3 pass、0 fail）をjudge-only evidenceとして渡します。一時workspaceの絶対pathはfixture内の相対pathへ正規化します。
- Phase 3のjudge caseだけは本番の遷移 scorerで `[PLAN:1]` をpass、`[PLAN:3]` とタグなしをfailとする決定的チェックです。
- これは固定fixtureに対するprompt回帰であり、実製品の機能動作や外部SDKの互換性を証明するE2Eではありません。モデル出力とsemantic judgeには確率性があります。
- 元のmatrixのKimi K3（OpenCode）は残高不足によるinfra行です。別経路のKimi Code CLI補足は初回20回答を保存してrawを再採点し、追加prompt修正後はcandidate-only 10/10を保存済みです。
- リポジトリのOpenCode probeは10/11でした。唯一のprompt-capture timeoutは変更前のclean baseでも再現したため、今回のprompt/eval差分による失敗とは扱っていません。

通常ゲートの記録は、build、lint、root実行のunit 6203/6203、E2E smoke 19 pass・1 skipです。light ITは最新runと変更前a9c9fを同じworkers 2条件で比較し、いずれも2605/2605 tests、exit 0、Vitest RPC `onTaskUpdate Timeout` のUnhandled Error 1件でした。変更前にも再現した基盤現象として扱い、CIのstrict gateで確認します。f3時点のlight ITはclean pass済みです。対象34件として記録したコマンドは `node --test eval/asserts/instruction-research-handoff-kimi-cli.test.mjs eval/asserts/development-loop-eval.test.mjs` で、追加4契約とroute/wire証跡のcamel/snake境界を含む今回の再実行は42/42 pass、fixture testsは3/3 passでした。
