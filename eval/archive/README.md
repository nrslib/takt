# 旧修正検証の評価資料

`agents/fix-verifier/` には、削除した `fix-verifier` と `verification-replan` に関する旧評価設定を保管しています。現行ビルトインから両ステップを削除したため、これらの設定を評価スイートの登録対象と準備対象から外しました。設定内の相対パスと参照ファセットは移動前の状態を示しており、この場所からは実行できません。

当時のケース、fixture、プロンプト、assertion は `eval/` 以下に残しています。旧 `remediation-evidence` 専用のプロンプトとassertionは `remediation-evidence/` に保管しました。過去の評価の意図や結果を調べる資料として利用してください。レビュー裁定のA1〜A4は現行の `review-adjudication-applicable-inputs` で評価します。
