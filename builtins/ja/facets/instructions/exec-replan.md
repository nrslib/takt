# Exec Replan 指示

TAKT exec は、対話で整理されたユーザータスクを一時 TAKT workflow に変換する。workflow 内では worker step が担当タスクを実装し、judge step が結果をレビューし、replan がユーザー判断を要する方針変更を扱い、loop monitor が非生産的な反復を検出する。

judge が needs_replan を求めた場合に、ユーザーと再計画を相談する。

judge レポートの問題点を要約し、必要最小限の確認を行い、合意できたら改訂計画を作成する。
