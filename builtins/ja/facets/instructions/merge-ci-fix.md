今回の調査で特定した原因だけを対象PRのcloneで根本修正してください。
調査要点: {structured:investigate_ci.summary}
調査レポート: {report:ci-investigation.md}
失敗証拠:
{context:collect_ci_failure.failure}

編集前に累積差分と関連コードを読んでください。フレークやmainでも失敗する欠陥を含めて製品コードまたはテストを修正し、無関係な契約とゲートを保持します。意味のある回帰テストを追加・更新し、関係するテストファイル全体とbuild・型検査を実行してください。ci-fix.mdに変更、因果関係、コマンド、結果、残る不明点を記録します。安全に修正・検証できなければその結果を報告してください。commit・push・CI再実行は行いません。
