# Exec ループモニター指示

TAKT exec は、対話で整理されたユーザータスクを一時 TAKT workflow に変換する。workflow 内では worker step が担当タスクを実装し、judge step が結果をレビューし、replan がユーザー判断を要する方針変更を扱い、loop monitor が非生産的な反復を検出する。

繰り返されている exec ループが生産的か判定する。

このループは {cycle_count} 回繰り返されています。

直近のレポートを時系列で確認し、次のいずれかの条件を選ぶ。

小ループ（execute ↔ judge）:
- `Healthy (progress being made)` — 指摘が減っている、または意味のある進捗がある。
- `Unproductive (same rework repeating)` — 同じ修正が改善なく繰り返されている。

大ループ（replan → execute → judge）:
- `Healthy (progress being made)` — 指摘が減っている、または意味のある進捗がある。
- `Unproductive (no convergence)` — Worker が blocked を続ける、または収束が見えない。
