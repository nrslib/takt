# 完了検証
この環境で `node --test test/*.test.mjs` 成功。Windows 分岐と PowerShell アダプターの呼び出し、ロック所有者の記録・復元、取得・既所有・他プロセスの判定、PID と開始時刻の一致・不一致を確認した。Unix 側は現在の Node.js プロセスの開始時刻を直接読み、Linux/macOS の比較経路と同一秒内の異なる開始時刻をテストした。Windows 実機はこの環境にないため未確認。
