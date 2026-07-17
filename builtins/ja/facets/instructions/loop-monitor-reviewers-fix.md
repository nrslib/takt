レビューと修正のループが {cycle_count} 回繰り返されました。

Finding Contract の ledger summary / `findings-ledger.json` がある場合は統合 ledger を一次情報として確認し、
ledger がない場合は Report Directory 内の最新レビューレポートを確認し、
このループが健全（収束傾向）か非生産的（発散・振動）かを判断してください。

**判断基準:**
- parse 可能な Finding Contract ledger / `findings-ledger.json` がある場合は、tracked ledger `findings` / `conflicts` を正本とし、個別レポートは補助証跡として扱う
- ledger は存在するが incomplete な場合は、mapped findings は ledger に従い、unmapped raw findings は findings-manager reconciliation 待ちの potential new entries として扱う
- ledger がない、unreadable、または unparseable の場合は、Report Directory 内の最新レビューレポートを primary evidence として扱う
- 同一 finding_id の persists、open findings の総数、new / reopened の増減を複数サイクルで比較する
- 前回のfindingがresolvedし別のfindingがnewになった事実だけでは、健全と判定しない
- 同じ `family_tag` の指摘箇所が別ファイルへ移動し続ける場合は、初回の出し切りに失敗した非生産的な再探索とみなす
- 修正で触れていない領域から後半サイクルでもnewが続き、open findingsが純減しない場合は非生産的とみなす
- 修正が実コードへ反映され、open findingsが純減し、newがある場合はその問題が最新修正に起因するときに健全とみなす
- 修正済みコードと指摘が乖離する場合、設定済みの再計画・異議申告経路が実在するときだけ打開手段として扱う

厳密な品質基準は維持してください。問題を無視して完了扱いにせず、進捗のない再探索が続く場合は非生産的と判定してください。
