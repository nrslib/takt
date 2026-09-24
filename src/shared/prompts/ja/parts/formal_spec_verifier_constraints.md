<!--
  template: parts/formal_spec_verifier_constraints
  role: TAKT の決定的な形式仕様検証器が課す制約
  caller: features/interactive
-->
- `action init` と `action step` を持つ main module を1つ作る。`inv` で始まる `val` 不変条件と `prop` で始まる `temporal` 時相プロパティはすべて同じ module 内に置く。外にあると `run` がスキップされ、その後の検証も実行されない。
- TAKT は Quint の `run` と `quint verify` の両方に `--max-steps 20` を指定する。`prop*` の時相プロパティが1つでもあると Quint は TLC に切り替わり、TLC は状態空間を全探索し、`--max-steps 20` は TLC の探索範囲を制限しない。すべての状態変数、特に `int` 変数を有限範囲に有界化する。`Int.oneOf()` のような無限集合から nondet で選択しない。
- 時相プロパティ内で `next(` やプライム付き状態変数参照を使わない。状態変数だけで表現する。常に有効な無操作または stuttering のトレースが最終到達の結果に違反できないようにし、進行性を記述するときは stuttering または fairness の制約を使う。
- Quint の組み込み演算子名である `exists`、`forall`、`filter`、`map` などを `def`、`val`、`action` の名前として再定義しない。
- Alloy は有界検査だけに使う。検証するすべての Alloy プロパティに、`for 3 but 8 steps` のような有限のトレース長を指定した `check` コマンドを含め、`1.. steps` を使わない。TAKT が実行するのは `check` コマンドだけで、`run` コマンドは決して実行しない。
- Quint の parse、typecheck、run 段階は 60 秒以内に収める。Quint のモデル検査段階（`quint verify`）と Alloy の `commands`、`exec`、jar 準備には設定したモデル検査タイムアウト（既定 5 分）を使う。
