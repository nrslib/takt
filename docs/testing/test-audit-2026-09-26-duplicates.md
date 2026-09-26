# 本文一致候補25組の個別判定

抽出時点は `faf193159` に対する追加監査開始後。本文一致は重複の証拠候補とし、setup・入口・`it.each` の入力も確認した。

| 組 | 比較したテスト | 判定理由 |
| --- | --- | --- |
| 1 | `runtime-mcp-legacy-mix.test.ts:84` / `runtime-mcp-legacy-mix.test.ts:111` | provider未指定も含め入力・前提が同一。1件に統合。 |
| 2 | `listNonInteractive.test.ts:84` / `listTasks.test.ts:121` | 同じlistTasksNonInteractive入口・空一時ディレクトリ・JSON出力。専用ファイルへ集約。 |
| 3 | `task-schema-exceeded.test.ts:100` / `task-schema.test.ts:103` | 同じschemaに空objectを渡す。基本schema側に集約。 |
| 4 | `task-schema-exceeded.test.ts:116` / `task-schema-exceeded.test.ts:122` | 同じexceeded_max_steps=60の解析と出力。1件に統合。 |
| 5 | `provider-resolution.test.ts:1334` / `provider-resolution.test.ts:1401` | local providerとglobal modelの同じ優先順位条件。1件に統合。 |
| 6 | `parallel-and-loader.test.ts:29` / `parallel-and-loader.test.ts:88` | 同じpersonaなし・instructionありのsub-step。1件に統合。 |
| 7 | `parallel-and-loader.test.ts:320` / `parallel-and-loader.test.ts:330` | 同じinstructionのみのstep。1件に統合。 |
| 8 | `saveTaskFile.test.ts:165` / `saveTaskFile.test.ts:174` | 同じworkflow=reviewの保存。1件に統合。 |
| 9 | `strip-ansi.test.ts:13` / `text.test.ts:97` | 同じstripAnsi実装。空文字以外も照合しtext側の7件を専用テストへ集約。 |
| 10 | `deepseek-harness-model-reference.test.ts:25` / `deepseek-harness-model-reference.test.ts:37` | it.eachの参照文字列が異なり、後者は空白保持。両方保持。 |
| 11 | `task-source-schema.test.ts:136` / `task-source-schema.test.ts:163` | どちらも空object。基本task-schemaの空設定検証へ集約し両方削除。 |
| 12 | `task-schema.test.ts:455` / `task-schema.test.ts:601` | 同じmakePendingRecordとschema。pending側に集約。 |
| 13 | `createIssueFromTask.test.ts:239` / `createIssueFromTask.test.ts:269` | 同じ引数省略のcreateIssueFromTask。cwd・labels未指定を1件で検証。 |
| 14 | `exec-configValidation.test.ts:39` / `exec-configValidation.test.ts:80` | 通常値と任意文字列で入力が異なる。ただし実装の能力判定から期待値を生成する3組は自己比較なので除去し、明示入力の検証を保持。 |
| 15 | `npmTestEntrypoint.test.ts:642` / `npmTestEntrypoint.test.ts:666` | 同じ分類対象ファイル。同じlight runner期待値。1件に統合。 |
| 16 | `taskRetryActions.test.ts:2110` / `taskRetryActions.test.ts:2401` | 共通beforeEach・同じmakeFailedTask・reuse拒否・選択cancel。後者へ集約。 |
| 17 | `gitlab-utils.test.ts:56` / `gitlab-utils.test.ts:86` | コメントだけが別ホスト未認証と述べ、mock入力は同一。重複を削除しhostname引数テストを保持。 |
| 18 | `structured-output-schema-validator.test.ts:83` / `structured-output-schema-validator.test.ts:303` | it.eachの不正schemaが異なる。両方保持。 |
| 19 | `structured-output-schema-validator.test.ts:203` / `structured-output-schema-validator.test.ts:216` | enumとconstで入力schemaが異なる。両方保持。 |
| 20 | `engine-persona-providers.test.ts:388` / `engine-agent-overrides.test.ts:51` | mock構成・setup・engine入力が同一。engine-agent-overridesへ集約。 |
| 21 | `provider-schema.test.ts:351` / `provider-schema.test.ts:361` | formal_specのscalarとobjectで入力形態が異なる。両方保持。 |
| 22 | `provider-schema.test.ts:454` / `provider-schema.test.ts:465` | model_profilesとguard境界値で検証対象が異なる。両方保持。 |
| 23 | `config.test.ts:956` / `config.test.ts:984` | overrideを称するがconfigを書いていない。同じ環境変数だけのテストなので1件削除。 |
| 24 | `escape.test.ts:402` / `escape.test.ts:491` | 同じstep-qualified effect参照とworkflow state。1件に統合。 |
| 25 | `cli-routing-issue-resolve.test.ts:983` / `cli-routing-issue-resolve.test.ts:1003` | 共通beforeEach、continue未指定の同じ入口・引数。default assistant側へ集約。 |

同名192組も追加抽出し、同じ入口の候補を重点確認した。provider別・schema別・UI入口別など、同名だけでは削除しない。

追加で削除した対象:

- `engine-persona-providers` のprovider未指定・childProcessEnvも `engine-agent-overrides` と同じ実行境界。
- `engine-blocked` のreport phaseでの入力cancel・再試行は `report-phase-blocked` に集約。
- `promotion-schema-normalizer` の空promotion拒否は `runtime-yaml-boundary-promotion-schema` に集約。
- `workflowLoader` のproject-local一覧はfixture名だけが違う重複を削除。
- `git-factory` / `github-provider` のメソッドがfunctionであることだけの検証は、公開型と実際の各メソッド呼出しテストで担保。
- `models` の文字列代入後の自己比較は削除。型の受理契約は `type-contracts/workflow-template-reference.ts` へ移動。
- `deploySkillWrappers` の静的内部設定コピーは削除。実ファイル配置・更新・確認キャンセルは `deploySkill` / `deploySkillCodex` で検証。
- `parallel-output-interleaving` の自分で追加したstderrの検証と部分一致の重複を除去。実stdoutチャンクの結合を維持。
