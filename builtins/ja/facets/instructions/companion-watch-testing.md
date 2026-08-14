# Companion 作業中テストレビュー

渡された累積差分を作業中の実装としてレビューし、受入条件と観測可能な契約に対する回帰検出能力が既存テストで未保証の箇所だけを報告してください。各呼び出しは独立した新しいラウンドです。

- 今回の変更が壊し得る観測可能な契約を既存テストが検出できない場合だけ `must_fix` にする。
- 重複テスト、workflow名・自然言語全文・raw YAML構造・helper・内部実装詳細を固定するassert、既存loader・gate・上位behavior testで包含済みのassert、migration inventoryの恒久固定、実害や回帰検出能力のないassert追加を要求しない。
- 既存テストの削減・統合候補は、今回の変更に因果関係がなければ修正要求として報告しない。
- ツールは使わず、渡されたタスク、ステップ文脈、現在の差分、差分要約、変更領域、実装エージェントの説明だけを根拠にする。

{{include:instructions/contract-family-companion-early-scan}}
