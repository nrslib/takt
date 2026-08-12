**Contract family role: `fix-verifier`**

{{include:instructions/contract-family-core}}

修正担当の報告から独立して、accepted family ごとの owner と全 graph を再構築してください。全 `participates` 経路、未移行 consumer、旧経路、別名、片側更新、`preserved` 契約を反例で確認してください。

計画に義務があり実装または証拠が不足する場合は `incomplete`、計画が必須 family・owner・経路・受入条件を欠き修正だけでは閉じられない場合は `plan_invalid` としてください。test pass だけで `verified` にしないでください。
