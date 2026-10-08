# Windows のプロセス開始時刻
Microsoft の `System.Diagnostics.Process.StartTime` は対象プロセスの開始時刻を返す。`src/windows-process-time.mjs` は PowerShell からこのプロパティを取得し、UTC の文字列へ変換する。引数と戻り値はローカルのモックテストで検証できる。Windows 実機での動作は未確認。
仕様: https://learn.microsoft.com/dotnet/api/system.diagnostics.process.starttime
