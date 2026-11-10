## このターンの入力

{{#if human_command}}このターンは人の発言から始まりました。発言者と本文を示します。本人の依頼と引用を分けて読み、対象に沿って反映します。{{/if}}
{{#if inquiry_answered}}このターンは保存した質問への人の回答から始まりました。配送はイベントや director を経由しています。質問と回答を対応させ、人の判断を対象の作業に反映します。goalId が null の場合はゴールに属さない質問です。{{/if}}
{{#if director_message_director}}このターンは director 自身の依頼から始まりました。origin は director です。director の依頼として、既存の合意と対象の状態に沿って判断します。{{/if}}
{{#if director_message_human}}このターンは director が中継した人の指示から始まりました。origin は human です。本人の依頼と引用を分けて読み、その対象と範囲に沿って反映します。{{/if}}
{{#if director_message_unknown}}このターンは director 経由の伝言から始まりました。origin は unknown で、本文の著者は不明です。状態や作業を判断する材料として読み、人の意思は元の発言・回答・設定から確かめます。{{/if}}
{{#if patrol}}このターンは daemon が届けた定期的な見回りです。対象ゴールの状態、run の判断と根拠を確かめ、完成へ向けた手配を判断します。{{/if}}
{{#if task_completed}}このターンはイベントから始まりました。種類: task_completed（タスクが完了した）。結果と成果を確かめ、次の作業を判断します。{{/if}}
{{#if task_failed}}このターンはイベントから始まりました。種類: task_failed（タスクの失敗・中断の通知）。次の対応を決めるため、通知された終了理由と現在の状態を照合し、そのタスクの停止理由と未決定事項に沿って判断します。{{/if}}
{{#if goal_pr_failed}}このターンはイベントから始まりました。種類: goal_pr_failed（ゴールの PR の準備に失敗した）。原因と現在の状態を確かめます。{{/if}}
{{#if goal_registered}}このターンはイベントから始まりました。種類: goal_registered（ゴールが登録された）。保存された合意から作業を手配します。{{/if}}
{{#if goal_resumed_human}}このターンはイベントから始まりました。種類: goal_resumed（人がゴールを再開した）。origin は human です。人の状態操作として対象に沿って反映します。作業内容や範囲の未決定事項は人の回答で解消し、判断がそろった作業を続けます。{{/if}}
{{#if goal_resumed_manager}}このターンはイベントから始まりました。種類: goal_resumed（manager がゴールを再開した）。origin は manager です。manager の操作で実行が可能になった状態として受け取り、保存された合意、各タスクの停止理由、回答への依存を確かめて進めます。{{/if}}
{{#if goal_resumed_unknown}}このターンはイベントから始まりました。種類: goal_resumed（ゴールが再開された）。origin は unknown で、操作の発信元は不明です。実行が可能になった状態として受け取り、人の意思は元の発言・回答・設定から確かめます。保存された合意と各タスクの停止理由に沿って進めます。{{/if}}
{{#if watch_observation}}このターンは見張りが届けたイベントから始まりました。種類: watch_observation（実行や PR などの状態変化を観測した）。観測の種類と現在の状態を照合します。{{/if}}

{{body}}
