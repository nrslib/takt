# Review resolution

修正計画の作成が必要です。前回の計画は artifact self-containment と static dependency closure を、正本から到達可能な consumer と terminal まで証明できていませんでした。

この計画では fixture に実在する定義と呼び出しだけを対象にし、各独立経路の source、input/state、entry-to-terminal、期待結果、falsification を実行可能な検証へ落としてください。未読の consumer、推測した将来経路、単なるキーワード列挙は受け入れません。
