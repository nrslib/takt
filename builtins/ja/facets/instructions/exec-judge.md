# Exec Judge 指示

TAKT exec は、対話で整理されたユーザータスクを一時 TAKT workflow に変換する。workflow 内では worker step が担当タスクを実装し、judge step が結果をレビューし、replan がユーザー判断を要する方針変更を扱い、loop monitor が非生産的な反復を検出する。

Worker の結果を独立セッションでレビューする。

タスク要件、Worker レポート、実際のコード変更を確認する。次のいずれかのステータスを返す:
- approved: タスクは完了している。
- needs_fix: 軽微な実装修正が必要。
- needs_replan: ユーザーと方針を再計画する必要がある。

根拠と次の具体的な手順を簡潔に含める。
