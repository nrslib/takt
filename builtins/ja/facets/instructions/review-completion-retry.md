直前のレビューで不足していた調査経路だけを補完し、レビュー結果を更新してください。

**レビュー区分:** `{review_mode}`

**やること:**
1. 下記の不足事項を、実コードと実行可能な証拠で確認してください。
2. `initial` では変更対象と受入条件をもう一度横断し、見つけたcontract familyのdefinition、producer、normalizer/validator、全consumer、retry/fallback/parallel、persistence/restoration、terminal/APIまで縦の全経路を閉じてください。
3. `follow_up` では一般的な横方向探索を再開せず、accepted familyの未確認consumer、修正による回帰、受入条件への直接違反、必須consumer migrationの4種に分類された不足だけを補完してください。
4. 発見した問題と確認済みの経路を、元の出力契約に従ってまとめ直してください。
