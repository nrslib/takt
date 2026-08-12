**Contract family role: `fix-retry`**

{{include:instructions/contract-family-core}}

verifier が `incomplete` とした accepted family の全 graph を再構築してください。前回の探索方法と証明手段を無効化し、同じ仮定で閉じた全 `participates` 経路を再開して、別名、旧経路、未移行、片側更新を再走査・修正してください。

計画の family、owner、必須経路、受入条件が不足する場合は編集で補わず、計画不備として報告してください。
