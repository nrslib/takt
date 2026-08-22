# Exec ループモニター指示

繰り返されている exec ループが生産的か判定する。

このループは {cycle_count} 回繰り返されています。

直近のレポートを時系列で確認し、次のいずれかの条件を選ぶ。

小ループ（execute ↔ review）:
- `Healthy (progress being made)` — 指摘が減っている、または意味のある進捗がある。
- `Unproductive (same rework repeating)` — 同じ修正が改善なく繰り返されている。

大ループ（replan → execute → review）:
- `Healthy (progress being made)` — 指摘が減っている、または意味のある進捗がある。
- `Unproductive (no convergence)` — Worker が blocked を続ける、または収束が見えない。
