# 今回の変更
変更前の `openWorkspace` は `src/workspace.mjs` のまま残っている。Windows を含め `sessionEndpoint` が返す接続先を使う既存の入口である。今回追加した `openWorkspaceWithSecret` だけが `src/secret-file.mjs` で秘密情報を保存する。従来の Windows 接続経路はこの保存処理を通らない。
