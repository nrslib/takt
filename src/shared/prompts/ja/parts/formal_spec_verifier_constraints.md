<!--
  template: parts/formal_spec_verifier_constraints
  role: TAKT の決定的な形式仕様検証器が課す制約
  caller: features/interactive
-->
- `action init` と `action step` を持つ main module を1つ作る。`inv` で始まる `val` 不変条件、`prop` で始まる `temporal` 時相プロパティ、シナリオの `run` 宣言はすべて同じ module 内に置く。外にあると対象範囲エラーになり、`quint run` と後続の Quint 検証は実行されない。
- シナリオの `run` 宣言は任意。main module に書かれた場合は TAKT が `quint run` の通過後に `quint test` で実行し、`expect` が成り立たなければ不合格にする。対象全件の成功を確認できなければ合格にせず、`quint verify` に進まない。nondet を含むシナリオの試行回数には上限があり、網羅的検査ではない。
- 初期値を固定するシナリオでは、全状態変数へプライム付き代入を行うパラメータ付き `action initWith(...)` を定義する。`init` は nondet で選んだ値を渡し、`run` は具体値を渡す。`init.then(...)` は init の次の状態への遷移であり、初期値の上書きではない。

```quint
module scenarioExample {
  var mode: str
  var n: int
  action initWith(m0: str): bool = all {
    mode' = m0,
    n' = 0
  }
  action init = {
    nondet m0 = Set("a", "b").oneOf()
    initWith(m0)
  }
  action step = all { mode' = mode, n' = n }
  run runParam = initWith("b").then(step).expect(mode == "b" and n == 0)
}
```

- TAKT は `quint run` と `quint verify` の両方に `--max-steps 20` を指定する。`prop*` の時相プロパティが1つでもあると Quint は TLC に切り替わり、TLC は状態空間を全探索し、`--max-steps 20` は TLC の探索範囲を制限しない。すべての状態変数、特に `int` 変数を有限範囲に有界化する。`Int.oneOf()` のような無限集合から nondet で選択しない。
- 時相プロパティ内で `next(` やプライム付き状態変数参照を使わない。状態変数だけで表現する。常に有効な無操作または stuttering のトレースが最終到達の結果に違反できないようにし、進行性を記述するときは stuttering または fairness の制約を使う。
- Quint の組み込み演算子名である `exists`、`forall`、`filter`、`map` などを `def`、`val`、`action` の名前として再定義しない。
- Alloy は有界検査だけに使う。すべての `run` と `check` に `for 3 but 8 steps` のような有限スコープ・有限のトレース長を指定し、`1.. steps` を使わない。モデルの制約が矛盾していないことを検査する整合性確認の `run {}` を必ず含める。必要なシナリオや到達可能性は `run`、検証する不変条件やプロパティは `check` で表現する。TAKT はすべての `run` と `check` を実行する。`run` は成立例あり（SAT）が passed、指定スコープ内に成立例なし（UNSAT）が failed。`check` は反例なし（UNSAT）が passed、反例あり（SAT）が failed。`check` の成功だけではモデルの充足可能性を保証しない。Alloy の `expect` 注釈はこのSAT/UNSATによる判定を上書きしない。
- Quint の parse、typecheck、`quint run`、`quint test` 段階はそれぞれ 60 秒以内に収める。Quint のモデル検査段階（`quint verify`）と Alloy の `commands`、`exec`、jar 準備には設定したモデル検査タイムアウト（既定 15 分）を使う。
