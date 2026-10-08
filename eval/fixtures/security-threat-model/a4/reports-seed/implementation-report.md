# 実装報告
従来: build コマンドは remote.origin.url を config/trusted-repositories.json と照合してから npm build スクリプトを実行する。
今回: bench コマンドを追加した。src/commands/bench.mjs から runScript に渡して npm bench スクリプトを実行する。
