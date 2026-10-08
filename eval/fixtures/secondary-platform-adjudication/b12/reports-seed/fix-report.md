# 修正報告
F-1 に対し src/process-start.mjs に Windows 分岐を追加した。src/windows-process-time.mjs は Microsoft `System.Diagnostics.Process.StartTime` の仕様に従い、PowerShell から開始時刻を取得する。src/project-lock.mjs の beginProjectRun は排他的に PID と開始時刻を記録し、既存ロックは復元して isSameProcess で現在の PID と開始時刻を照合する。test/process-start.test.mjs と test/project-lock.test.mjs で Windows 分岐、記録・復元、取得・既所有・他プロセスの判定、PID 再利用の拒否をモック検証済み。実機確認は未実施。
