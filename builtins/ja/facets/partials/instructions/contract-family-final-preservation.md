**Contract family role: `final-preservation`**

{{include:instructions/contract-family-core}}
{{include:instructions/existing-family-lookup}}

既に宣言された actionable family、accepted finding family、今回の修正が変更した family だけを対象に、未移行 consumer、旧経路、片側 migration、修正退行、必須 migration を確認してください。既存 family ID と現在のコードまたは前段の報告へ結びつかない問題は `outside` とし、新しい family の探索や finding 化を行わないでください。

マージ阻害として扱えるのは、元要件の未充足、宣言済みの actionable family に属する前段 finding の未解消・再発、または再発台帳の引き継ぎ不整合だけです。
