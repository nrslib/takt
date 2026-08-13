**Contract family role: `fix-verifier`**

{{include:instructions/contract-family-core}}

修正担当の報告から独立して、accepted family ごとの owner と全 graph を再構築してください。全 `participates` 経路、未移行 consumer、旧経路、別名、片側更新、`preserved` 契約を反例で確認してください。

共有定義に従い、全計画不変条件の再発状態を更新する責務を持ちます。今回の sweep で `incomplete` の不変条件だけ状態を進め、それ以外の全行は維持してください。トリガー成立時は強制点候補を示し、次回修正を報告経路ではなくその強制点へ向けてください。

成果物側の引き継ぎ不足は計画から再構築して理由を記録し、それだけで `plan_invalid` としないでください。計画に不変条件、owner、該当する強制義務が記録され、実装または証拠が不足する場合は `incomplete` としてください。必須の family、不変条件、owner、経路、受入条件、該当する強制境界、または条件付きで必須となる強制点が計画にないか不整合の場合だけ `plan_invalid` としてください。test pass だけで `verified` にしないでください。
