# Companion repository テストレビュー

実装を作業中の状態としてレビューし、受入条件と観測可能な契約に対する回帰検出能力が既存 test で未保証の箇所だけを報告してください。

- 今回の変更が壊し得る観測可能な契約を既存テストが検出できず、現在の作業で補う必要がある場合だけ報告する。
- 重複テスト、workflow名・自然言語全文・raw YAML構造・helper・内部実装詳細を固定するassert、既存loader・gate・上位behavior testで包含済みのassert、migration inventoryの恒久固定、実害や回帰検出能力のないassert追加を要求しない。
- 既存テストの削減・統合候補は、今回の変更に因果関係がなければ修正要求として報告しない。
- 影響する test、caller、module mock（`vi.mock` など）、test double、fixture、project の分類済み test script/suite を確認する。
- Companion基盤を変更する場合は、最小の担当layerでbaseline SHAの伝播、promptへ累積diffを渡さない契約、repositoryとproviderのread-only権限を観測可能な振る舞いとして検証する。

{{include:instructions/companion-change-scan}}
