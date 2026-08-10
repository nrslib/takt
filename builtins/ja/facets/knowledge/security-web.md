# Webセキュリティ知識

## 適用条件

ブラウザで解釈されるHTML・JavaScript・URL、DOM操作、cookie、CORS、またはブラウザからのファイル送信を変更する場合に適用する。CLI出力、サーバー内部の文字列処理、ローカルファイルだけを扱う変更には適用しない。

## XSS（Cross-Site Scripting）

- 低信頼値をHTMLまたはJavaScriptへ未エスケープで出力する経路 → REJECT
- 有効なsanitizeなしで、`innerHTML`、`dangerouslySetInnerHTML` へ低信頼値が到達する経路 → REJECT
- URLパラメータを実行可能なbrowser contextへ直接埋め込む経路 → REJECT

単にHTML生成APIを使っているだけではREJECTにしない。入力の制御者、出力context、escapeまたはsanitizeの有無を確認する。

## ブラウザ境界

| 確認対象 | 判定材料 |
|----------|----------|
| cookie・session | 属性、送信先、第三者originからの利用可能性 |
| CORS | 許可origin、credentialの有無、公開される操作・データ |
| redirect・URL | 低信頼入力が遷移先や実行可能schemeを制御できるか |
| browser storage | 保存する情報の機密性と、同一origin scriptからの到達性 |

設定が広いことだけでなく、その設定によって攻撃者が何を読み取り・実行できるかを確認する。

## ファイル送信

- 低信頼ファイルが公開・実行可能な場所へ検証なしで配置される経路 → REJECT
- 実行可能ファイルの許可が具体的なコード実行につながる経路 → REJECT
- ファイルサイズ制限がないことだけを根拠にREJECTしない。Security専用policyに従って現実の経路と影響を評価する

## Webアプリケーション確認項目

アクセス制御、暗号上の失敗、injection、不安全な設計、設定不備、脆弱なcomponent、認証失敗、software integrity、loggingのうち、変更したbrowser境界に関係する項目だけを確認する。
