# Phase 1で注入したレポートのPhase 2への引き継ぎ

状態: 実装・対象検証完了。Astraの設計レビューとLuna Maxの実装再レビューはいずれもAPPROVE、残存finding 0件。

## 目的と責務

`development-core` が親名前空間に作成した計画を子の実装担当へ渡し、その担当がPhase 1で実際に受け取ったレポート本文をPhase 2でも使用できるようにする。

TAKTエンジンはファイル名、契約ID、完了義務を解釈しない。各workflowが必要な成果物を `{report:...}` で指定する。Phase 3は現在のステップの判定対象レポートと遷移候補からルールを選ぶ現行責務を維持する。

## 設計時に確認した修正前の状態

- `WorkflowCallExecutor.ts` は子に別のreport名前空間を割り当てる。session mapは継承するが、子の `lastOutput` は未設定で開始する。
- `development-core` のimplementは `development-implement` / `development-implement-dynamic` / `development-implement-team` を呼ぶ。親のplanとtest reportは子のReport Directoryにない。
- `implement.md` などはReport Directory外の検索・参照を禁止する一方、親計画の明示参照を持たない。
- `escape.ts` は `{report:...}` を検証済み本文に置換する。`report-reference.ts` は現在名前空間、resume snapshotのconsumer mapping、直近の親からreports rootの順に探索する。欠落は欠落文になり、権限・I/O・不正参照は既存のエラーとなる。
- Phase 1のworkflow-wide rulesにも `replaceTemplatePlaceholders` が適用されるが、`workflowAllStepsRuleResolver.ts` がrule内のreport参照を禁止している。report参照はinstruction側に置く。
- `ReportInstructionBuilder` は元タスク・対象output contract・必要時のPhase 1応答を受け取る。Phase 1で注入したreport本文を独立した入力として保持していない。
- Phase 2はreportファイルごとに呼ばれ、同一セッションでの実行、新規セッション、再試行、対応するfallback providerの経路を持つ。
- Phase 3は `useJudge !== false` のreportを読む。一件も取得できないときだけPhase 1応答へfallbackする。
- #1531の `implement:30` ではPhase 1と3回のPhase 2は同じCodex threadだった。Phase 1の注入promptにはLI-01がなく、Phase 2は上流台帳不明として未完了を報告した。

## 1. サブワークフローの入力指定を修正する

既存のinstruction継承機構 `{extends:...}` と共通partialを使い、development専用instructionを用意する。共通partialには `plan.md` と `test-report.md` の明示参照を置く。通常用はimplement、maintenance用はimplement-maintenance、team用はteam-leader-implementを継承し、それぞれ共通partialを含める。新しいYAML schemaは追加しない。

通常用をdevelopment-coreおよび通常/dynamic実装子の既定implementation_instructionに設定する。maintenanceの明示overrideをmaintenance用へ、team子の固定instructionをteam用へ変更する。専用instructionの展開後本文に `{report:...}` が残るため、既存のdoctorとresume consumer参照抽出がその参照を認識できる。共通partialは次を説明する。

同梱資産の移行先を以下に固定する。

| 設定箇所（日英両方） | 変更 |
|---|---|
| development-core / development-implement / development-implement-dynamic の既定instruction | `development-implement-with-reports`（implementを継承） |
| cli / review-fix-takt-default の明示 `implement` override | 同じ専用instructionへ変更 |
| maintenance / backend-maintenance / frontend-maintenance のoverride | `development-maintenance-with-reports`（implement-maintenanceを継承） |
| development-implement-team の固定instruction | `development-team-with-reports`（team-leader-implementを継承） |

simple、simple-core、mini-core等の同一名前空間で実装するstepには、サブワークフロー修正を理由に専用instructionを強制しない。新しいpartialをincludeした専用facetをloaderが展開し、実行・doctor・resume参照抽出のすべてに同じ参照が届くことを確認する。

- 注入された計画に従い、テスト報告は作成済みテストと未確認範囲を把握するために使用する。
- テスト作成スキップ等でreportが存在しない場合は、注入された欠落情報をそのまま扱い、存在を推測しない。
- 明示注入された親成果物は参照可能であり、Report Directory外を自由に検索する許可ではない。
- 実装後の報告では、入力に定義されたIDがある場合にその意味を維持して結果と証拠を対応付ける。IDのない入力へエンジン都合でIDを作らない。

汎用の `implement.md` に一律の `plan.md` 必須参照を追加しない。通常のinstructionとReport Directory制約が明示注入を禁止しないよう、必要な該当文面を整合させる。日本語・英語を同時に変更する。

`team-leader-implement.md` の「元タスクと前ステップ応答」を一次情報とする記述に、明示注入された上流成果物を加える。leaderがpartを作る際、担当する上流の完了義務、入力に既存IDがあればそのID、必要な証拠条件をpart instructionへ引き渡すよう指定する。`createPartStep` は `engineSynthesized: true` でworkflow rulesを継承しないため、partが親計画を自動で受け取るとは扱わない。既存のpartの役割境界を維持し、全workflow ruleの自動継承は追加しない。

カスタムimplementation workflowは既存のカスタマイズ境界を維持し、必要なreport参照をその定義が所有する。同梱workflowの修正を理由に任意の子へplanを自動注入しない。

## 2. 注入時の本文を構造化した値として保持する

概念上、Phase 1のinstruction生成結果を次の形にする。名前は実装時に既存型との整合を確認する。

```ts
interface InjectedReport {
  readonly reference: string;
  readonly scope: ResolvedReportReferenceScope;
  readonly content: string;
}

interface PreparedInstruction {
  readonly text: string;
  readonly injectedReports: readonly InjectedReport[];
}
```

`ResolvedReportReferenceScope` は既存の `report-reference.ts` の型を再利用する。

収集対象はPhase 1の展開済みinstructionを実際にレンダリングした際の `{report:...}` 解決結果。workflow-wide rulesは既存どおりreport参照禁止であり、この変更で許可しない。output contractの書式定義そのもの、ディレクトリにある未参照report、ツールで読んだファイル、Previous Response、セッション履歴は対象にしない。

`replaceTemplatePlaceholders` の詳細結果を返す内部経路を設け、解決本文と収集値を同じ解決操作から作る。InstructionBuilderはその値を返す。生成済みpromptから正規表現で本文を逆抽出したり、別の事前走査でファイルを再読したりしない。文字列だけが必要な既存preview等は同じ詳細結果のtextを使用する。

1回のinstruction生成内では、同じconsumer contextと正規化referenceを一度解決して再利用する。同一参照をinstructionが重複使用した場合も、それぞれへ同じ本文を入れ、Phase 2では初出順の1件にする。異なるreferenceは本文が偶然同じでも同一視しない。

missingも解決時の欠落文を保持する。Phase 2開始前にそのファイルが作成されても差し替えない。既存の探索・containment・symlink拒否・I/Oエラー処理を変更しない。

previewの `validateReportReferences: false` によるパス文字列は本文snapshotとして収集しない。実行時の準備結果とpreviewの結果は混用しない。

## 3. 実行単位に結び付けてPhase 2まで運ぶ

`PreparedNormalStepExecution` にinstruction本文と一緒に収集結果を持たせ、実行する値と観測イベントのpromptを同じ準備結果から生成する。`prebuiltInstruction` だけを渡す実行経路は呼び出し元を調べて準備結果を渡す形へ移行する。文字列から欠落分を復元したことにしない。

現時点で確認した実行callerは `WorkflowEngineStepCoordinator` と `LoopMonitorJudgeRunner`。後者も生成済み文字列を `runNormalStep` に渡しているため、準備結果の移行対象に含める。loop monitor固有にplanを追加する変更ではなく、既に参照した成果物を失わないための同一APIの移行とする。

snapshotは実行に所有させ、persona/session key、step名だけのグローバルMapに保持しない。同名stepの別workflow invocationやparallel siblingへ混ざらないようにする。

| 実行経路 | 保持・受け渡し |
|---|---|
| 通常agent | 確定したPhase 1準備結果 → `applyPostExecutionPhases` → report context |
| parallel sub-step | sub-stepごとの準備結果 → そのsub-stepのPhase 2。兄弟のsnapshotを合成しない |
| team leader | leaderが実際に受け取った準備結果 → 集約実行結果とともにleaderのPhase 2。partだけが読んだ成果物を暗黙に追加しない |
| workflow_call | 子のinstruction生成で子consumerの参照を解決。親snapshot全体の自動継承はしない |
| parallel親・arpeggio | 現在report phaseを生成せず判定へ進む経路はそのまま。新しいPhase 2を追加しない |

report専用の入力を `ReportPhaseRunnerContext` と `ReportInstructionContext` へ渡す。共有context builderの戻り値を使う場合も、Phase 3のbuilderはこの値を入力へ取り込まない。

再試行は実際のinstructionとの対応を維持する。

- 同じPhase 1 instructionを使う空応答回復、同一instructionへの補足で行うcompletion retryでは、元のsnapshotを再利用する。
- 新しいPhase 1 instructionを構築した再実行・replan・requeueでは、その生成時に改めて収集する。別の実行のsnapshotを累積しない。
- Phase 2の複数report、同一session、新規session再試行、provider fallbackでは、同じ成功したPhase 1に対応するsnapshotを再利用する。
- Phase 2の生成物でsnapshotを上書きしない。

確認した `WorkflowResumePoint` はstepのstackとiterationを保持し、Phase 2への再開位置を持たない。`StateManager` はlastOutputを未設定で開始し、`WorkflowEngineStepCoordinator` が該当stepを実行する。したがって独立したsnapshot保存形式は追加せず、再開したPhase 1の準備時に参照を収集する。実装時に別のPhase 1省略経路が見つかった場合はその経路を先に解決し、過去promptから推測復元しない。

## 4. Phase 2のprompt

入力の順序を、元の要求、Phase 1に注入した参考report、既存条件で提供するPhase 1応答、今回のoutput contractとする。

参考reportにはreferenceと解決scopeを付けて本文を区切る。親やresume由来でも、ここに明示された本文を参照可能にする。これは過去成果物であり、現在の作業結果や現在の出力指示ではないと明示する。本文に含まれる命令が現在のPhase 2のツール禁止・出力形式を変更しない扱いにする。

同一セッションでのPhase 2にも参考reportを明示する。新規セッションの場合だけ注入する方式にはしない。Phase 1の応答を同一sessionで省略する現行動作は、この変更では維持する。

本文はPhase 1に注入した内容を保持し、Phase 2では再読・要約・切り詰め・パスだけへの置換をしない。Phase 2はツール禁止のためパスだけでは引き継ぎにならない。サイズによる別の上限や自動要約をこの変更で導入しない。既存のprompt/ログ出力規則を通し、provider容量エラーを実装の未完了に読み替えない。

report参照が0件のworkflowでは、空の見出しを増やさず従来通り動作する。

## 5. 実装対象と対象外

主な対象は `instruction/escape.ts`、`InstructionBuilder.ts`、`ReportInstructionBuilder.ts`、`instruction-context.ts`、Phase 1準備とreport contextを接続する各runner、`phase-runner.ts`、`report-phase-runner.ts`、日英Phase 2テンプレート、development実装workflowと専用instruction facets/partial、maintenanceのinstruction指定。

同梱workflowの変更箇所は§1の移行表を正とし、cli / review-fix-takt-default / maintenance / backend-maintenance / frontend-maintenanceの明示指定も日英で変更対象に含める。

変更しないもの: Phase 3の判定規則、契約ID専用parserや台帳schema、契約不足の決定的判定、全reportの自動収集、全workflowへのplan必須化、MCP session key不一致の修正。最後の不具合は独立した修正として扱う。

Phase 1に契約台帳を必ず出力させる全workflow共通の新規要件も導入しない。Phase 2は注入された上流本文と実装結果を使用して、各workflow固有のreportを生成する。

## 6. 検証と受け入れ条件

1. 最小の親子workflow fixtureで、親が任意名のreportを書き、子Phase 1が明示参照でその本文を受け取り、子Phase 2にも同じ本文が届く。planという名前をエンジンに固定しない。
2. Phase 1の後でreportを変更・削除してもPhase 2入力は元の本文。最初missingなら後で作成しても欠落文を維持する。同じPhase 1の再試行は元の本文、新しく準備したPhase 1は更新後の本文を受け取ることを対にして確認する。
3. 現在名前空間・親・resume snapshotの選択は既存resolverの結果に従う。既存resolverテストを活用し、引き継ぎテストは代表的な親とresumeの本文保持を確認する。
4. 通常、新規session retry、複数report生成、対応provider fallbackのすべてで同じ入力が届く。
5. 同名parallel sub-stepや別workflow invocationの入力が混ざらず、team leaderの集約reportにもleaderの入力が届く。
6. instructionの継承・includeを展開した参照を収集し、重複参照は一度だけ引き継ぐ。非参照reportやツール読み取り結果を追加しない。workflow ruleの参照禁止も維持する。
7. planなし・report参照なしのworkflowで追加必須条件を生まず、Phase 3の入力と選択対象が変わらない。
8. 同梱development通常/dynamic/teamの3経路で計画が実装担当へ届くことを確認する。上記の明示override各経路、カスタムinstruction、テストスキップの意味も確認する。単なるYAML文字列一致を動作証拠にしない。teamではleaderに渡った計画から担当義務がpart指示に引き渡されることをモデル評価で確認する。
9. 自然言語上の効果はモデル評価で別途確認する。合成した親計画のIDとPhase 1実装結果を用い、Phase 2が上流IDを保って報告できるかを評価する。TAKTの決定的テストでモデルの正答を保証したとは言わない。

コード実装時はプロジェクト規定のbuild/lint/unit/light ITと、変更したITの分類契約・対象heavy ITを実行する。設計レビュー時点では実装・モデル評価・テスト実行を行っていない。

## 7. Astraレビュー記録

2026-09-05、独立したAstraエージェントが設計全文と関連コードを確認。修正反映後の最終判定はAPPROVE、blocking問題0件。以下はレビュー結果の要約。

| 指摘 | 反映・確認結果 |
|---|---|
| workflow-wide ruleはreport参照を禁止しており初案が成立しない | 専用instruction継承とpartialへ変更。既存禁止契約を維持 |
| 既定instruction変更だけでは明示overrideに届かない | cli / review-fix-takt-default / maintenance 3種を日英の移行表と受入条件へ追加 |
| team leaderの一次情報制約とpartへの義務伝達が不足 | 明示reportの利用、担当義務・既存ID・証拠条件のpart指示への引き渡しを追加 |
| rule内参照はresume consumer抽出に載らない | instructionへの変更で既存の展開後本文抽出を利用できるため、resume抽出拡張は不要と確認 |

通常・parallel・teamのsnapshot所有、Phase 2の初回/新session再試行/fallback、Phase 3の現行責務維持は関連コードと整合すると評価された。非blocking提案として、既存scope型の再利用と、同じPhase 1の再試行/新Phase 1準備の対のテストを反映した。

これは設計承認であり実装承認ではない。Astraはbuild/lint/test/モデル評価を実施せず、#1531の実行記録自体も再確認していない。teamでの義務伝達とPhase 2のID保持のモデル評価は実装後の検証として残る。

## 8. 実装時のモデル確認

2026-09-05、合成した独立2義務（REQ-A: 負のlimit拒否、REQ-B: 入力順保持）で、日英それぞれPhase 2とteam分解の4入力をCodex CLIの `gpt-5.6-luna` / `max` に与えた。実際のbuiltin loader、InstructionBuilder、ReportInstructionBuilder、teamのbuildDecomposePromptを使用し、新規セッション・read-onlyで実行した。

- Phase 2: REQ-Aのみ実装・回帰テスト成功、REQ-Bは未変更・未検証というPhase 1応答を与えた。日英ともIDを保持し、Aをcomplete、Bをincompleteとして、与えた証拠と対応付けた。
- team: 日英とも各担当指示に担当義務のID・意味・対象ファイル・回帰テストの証拠条件が含まれ、未実行のテストを成功扱いしなかった。

これは4サンプルの意味内容を目視確認した結果であり、統計的な成功率や全providerでの保証ではない。teamは構造化応答transport・part実行を通さない限定的な分解prompt評価である。実際のpart実行への配線とreport本文の保持は別途結合テストで検証する。元runの生ログ・個人情報は評価入力に含めていない。

Phase 2の参考reportはreference/scope/contentを持つJSONレコードで区切った。本文はJSONのエスケープを除き無変更であり、レコードを復号したcontentが注入時本文と一致することを決定的テストで検証する。

## 9. Luna Maxの実装レビュー

2026-09-05、独立した `gpt-5.6-luna` / `max` が実装差分を確認した。

初回のF-001: WorkflowRunLoopとCoordinatorに文字列のprebuilt経路が残り、Coordinatorがその値を捨てていた。通常agentでは別の準備結果が届くが、設計上必要なcaller移行が未完了だった。

対応: full/single両run loop、Coordinator、WorkflowEngineのbindingをPreparedInstructionへ統一。生成済みの本文とsnapshotを同じ値で受け渡し、full/single両経路の回帰テストを追加した。

再レビュー結果はAPPROVE、残存finding 0件。Lunaはソースを確認し、テスト実行は実装担当側の証跡と分離して扱った。

## 10. 最終検証結果

- build / lint / 型契約 / テスト型チェック: 成功。
- 全unit: 398ファイル、6,177件成功。
- light IT: 155ファイル、2,290件成功。
- 変更したheavy IT: 全対象を実行し成功（report/parallel/team/workflow loader/親子workflow/Companion/session/run loop）。
- IT分類契約: 単独実行で20件成功。
- smoke E2E: 19件成功、GitHub Issue取得の1件はスキップ。
- `git diff --check`: 成功。

検証中に発見したテストモック・fixtureの追随漏れは修正後に再実行した。heavy runnerの通信タイムアウトも再測定で解消した。full release gateと全provider E2Eは実行していない。実行中の別runには変更を適用していない。
