# Windows のプロセス開始時刻
Microsoft の GetProcessTimes 仕様では、プロセスハンドルから lpCreationTime を取得できる。値は 1601-01-01 UTC を起点とする 100ns 単位の FILETIME。実装は Windows アダプターを注入可能にして、この仕様に沿う値と失敗をモックで検証できる。
仕様: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
