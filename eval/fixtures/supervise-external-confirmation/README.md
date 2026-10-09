# 最終判定の外部確認境界

各ケースを別の隔離プロジェクトとして渡す。seed は固定した裁定報告であり、
コードの充足状態と裁定の記載を照合する最終判定だけを評価する。

- generic: final-gate / supervise の共有裁定を使う経路。
- peer: peer-review / final-gate の supervise-review-resolution を使う経路。
- missing-basis: 裁定の外部確認項目の要求上の根拠が空で、元要求にも本番確認がない。
- incomplete-verification: 裁定が当該問題の検証を未完了と記録し、現在コードも返金を拒否する。

fixture の node --test は開発時の独立した検証であり、固定 seed の評価時点を書き換えない。
code-state.json の SHA-256 は app.mjs と app.test.mjs の連結を対象とする。
採点は fixture 外の suite YAML に置く。
