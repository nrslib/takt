# 計画

開発実行の `source` mode でも worker を起動できるようにする。現在 `workerEntry('source')` は配布用 module を返し、開発環境で期待する source module に到達しない。`built` mode の配布用 module 選択は維持する。変更は起動先の選択だけで、親子 process の寿命、中断、キャンセル、一時資源の所有権は変更しない。実 process から両 mode の module 読み込み結果を区別できるテストを用意する。
