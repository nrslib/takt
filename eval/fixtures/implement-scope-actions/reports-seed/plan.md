# 実装計画

1. formatLabelで前後空白を除去し、大小文字・内部空白・非文字列のTypeErrorを維持する。
2. ビルドとアプリの対象テストを実行する。
3. 最終品質ゲートとして全体テストも正常終了させる。mock-server側のsetup失敗も残したままにしない。

mock-serverのfixture-runtime依存はpackage.jsonに未登録。ソースと同じ内容のローカルパッケージがvendor/fixture-runtimeにあり、mock-serverで npm install --offline --no-audit --no-fund ../vendor/fixture-runtime を実行すれば、外部取得なしで整備できる。依存整備は未試行。
