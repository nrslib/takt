**Contract family role: `fix-retry`**

{{include:instructions/contract-family-core}}

verifier が `incomplete` とした accepted family の全 graph を再構築してください。前回の探索方法と証明手段を無効化し、同じ仮定で閉じた全 `participates` 経路を再開して、別名、旧経路、未移行、片側更新を再走査・修正してください。

verifier の再発記録は、fix-retry が occurrence、回数、トリガーを再計算せず、計画の構造的な強制を実施する権限を与えます。成果物不足の記録は、報告経路だけの局所修正ではなく、保守的な強制点方向の修正を行う権限を与えます。

再発履歴は変更せずに引き継いでください。計画の family、不変条件、owner、必須経路、受入条件、該当する強制境界、または条件付きで必須となる強制点が不足する場合だけ、計画不備として扱ってください。
