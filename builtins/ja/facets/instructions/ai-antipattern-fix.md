Report Directory 内のレポートを一次情報として参照してください。不足情報の補完が必要な場合に限り、Previous Response や会話履歴を補助的に参照して構いません（Previous Response は提供されない場合があります）。情報が競合する場合は、Report Directory 内のレポートと実際のファイル内容を優先してください。

**必須アクション:**
1. 指摘された全ファイルを Read tool で開く
2. 問題箇所を grep で検索して実在を確認する
3. 確認した問題を Edit tool で修正する
4. テストを実行して検証する
5. 「何を確認して、何を修正したか」を具体的に報告する

{{include:instructions/fix-root-cause-analysis}}

{{include:instructions/repair-path-check}}

{{include:instructions/post-edit-self-scan}}

各対象ファイルの確認結果を示せないまま、変更不要と結論付けないでください。生成物や仕様同期に関する問題は、生成元または仕様を確認してから判断し、確認できない場合は確認できなかった内容と理由を説明してください。

確認したファイル、検索、変更、テスト、その他の検証を指定された形式で記録してください。
