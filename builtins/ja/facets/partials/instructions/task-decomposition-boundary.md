{{include:instructions/contract-path-analysis}}

tool を使わず、提示情報から同じ不変条件を保証する担当箇所と相互依存する経路を同一 part に保ってください。独立実行できない経路を同一 batch の別 part へ分断せず、必要なら担当箇所、利用側の移行、検証を依存順の後続 batch にしてください。

未提示の repository 事実を補完せず、探索、編集、検証完了を主張しないでください。
