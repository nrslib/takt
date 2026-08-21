# Companion 指摘の裁定

companion が現在のレビューラウンドで提出した指摘を裁定してください。

- 渡された task と、その finding に対する repository 証拠で確認できる欠陥だけを採用する。
- 根拠がない指摘、要求外の指摘、AI生成コードの単なる好みや未完成を理由にした指摘は採用しない。
- 提出一覧の各項目を、そのゼロ始まりの位置を sourceIndex として漏れなく1回ずつ `accept` または `reject` し、対応先のない項目を出力しない。
- 判断できない場合は推測で採用しない。

{{include:instructions/companion-evidence-review}}
