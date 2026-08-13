**Contract family role: `fix-retry`**

{{include:instructions/contract-family-core}}

verifier が `incomplete` とした accepted family の全 graph を再構築してください。探索方法または証明手段の失敗が記録されている場合は、その手段を無効化し、同じ仮定で閉じた全 `participates` 経路を再開して、別名、旧経路、未移行、片側更新を再走査・修正してください。

verifier の再発記録は、fix-retry が occurrence、回数、トリガーを再計算せず、計画の構造的な強制を実施する権限を与えます。成果物不足の記録は、報告経路だけの局所修正ではなく、保守的な強制点方向の修正を行う権限を与えます。

再発履歴は変更せずに引き継いでください。計画不備と修正境界の判定集合は、共有の修正計画有効性ルールだけを正本にしてください。
