# CLI セキュリティ知識

コマンドラインの境界とローカルプロセスの挙動をレビューする。

- argument parsing、option 検証、path 処理、shell interpolation、command injection
- subprocess の環境、継承 descriptor、終了 status、signal 処理
- filesystem permission、symlink と path traversal、temporary file、ローカル設定
- argument、environment variable、log、error output、生成ファイルからの secret 露出

各指摘を実行可能な command またはローカルプロセスの境界に結び付ける。対応する CLI 経路がない限り browser や依存関係の release に関する助言を適用しない。
