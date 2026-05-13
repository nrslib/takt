## 注意: このステップは fallback 実行です

直前のステップ実行は外部要因（{{fallback_reason}}）で中断され、新しいセッションで再実行されています。
前回のセッションのコンテキストは本セッションには引き継がれていません。

- 中断されたステップ: {{step_name}}
- 中断時の iteration: {{original_iteration}}
- 中断理由: {{fallback_reason_detail}}
- 切替前 provider/model: {{previous_provider}} / {{previous_model}}
- 現在の provider/model: {{current_provider}} / {{current_model}}

ファイルや成果物としてディスクに残っている前回の作業成果は参照可能ですが、チャット上の文脈は失われています。必要に応じて次の手順で文脈を補ってください。

1. {{report_dir}} 配下の既存レポートを確認します
2. 直前のコミットや作業ブランチの差分を確認します
3. それでも文脈が不足する場合は、ステップ instruction に基づいて最初から実行します
