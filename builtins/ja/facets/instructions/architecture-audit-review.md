前回のアーキテクチャ監査で不十分と判断された module や boundary を再監査してください。

**重要:** 次のレポートを参照してください:
- 計画レポート: {report:01-architecture-audit-plan.md}
- 監査レポート: {report:02-architecture-audit.md}

**やること:**
1. 監査レポートと計画レポートを突き合わせ、未監査の module や不足している boundary を特定する
2. 未監査・指摘対象の module、boundary、call chain を全文読む
3. 具体的なファイル根拠、明示的なスコープ充足状況、必要なら漏れ理由を付けて監査結果を記録する

**出力の原則:**
- 前回の監査レポートの既存 Findings・Audit Scope を保持し、新たな結果を統合した完全版を出力する
- 新たに監査したモジュールを Audit Scope テーブルに追加する
- 未監査モジュールが残る場合は Follow-up Notes にその理由を明記する

**厳禁:**
- production code を変更すること
- 境界や依存方向が妥当だと、ファイル根拠なしに断定すること
- 「よくある構成だから」で指摘対象 module を飛ばすこと
