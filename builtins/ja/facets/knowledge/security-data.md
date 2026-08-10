# データ・secretセキュリティ知識

## 適用条件

credential、token、個人情報、機密データ、log、error response、暗号化・署名を変更する場合に適用する。保護対象データを扱わないcontrol flowや表示だけの変更には適用しない。

## 機密情報の露出

- API keyやsecretのhardcode → 即REJECT
- password、token、API keyをlogへ出力する経路 → REJECT
- responseや例外が低信頼主体へstack trace、内部path、credentialを露出する経路 → REJECT
- 実値を含む`.env`やcredential fileのcommit → REJECT

値が「内部情報」と呼ばれるだけでは不十分で、攻撃者が取得できる出力経路と、露出による具体的影響を確認する。

## Logging・masking

password、token、API key、認証header、session ID、不要な個人情報はlog対象から除外する。object全体のserializationや`toString()`も実際の出力内容として確認する。

| 基準 | 判定 |
|------|------|
| logにpassword・token・API keyが含まれる | REJECT |
| error responseにstack traceや内部pathが含まれる | 到達主体と情報の機密性を確認する |
| object serializationが機密fieldを露出する | REJECT |
| debug logに個人情報があるがproductionで無効 | 警告。設定経路を確認する |

## 暗号

- 弱い暗号algorithmの新規利用 → REJECT
- 固定IV・nonceにより安全性が破られる利用 → REJECT
- 暗号keyのhardcode → 即REJECT
- transport暗号不足は、productionで機密データが平文送信される具体経路がある場合にREJECT

暗号primitiveの名前だけで判定せず、利用目的、mode、key管理、nonce要件を確認する。

## Error handling

- security eventを握りつぶし、認証・認可・監査境界が失敗を検知できない → REJECT
- 一般的なerrorの握りつぶしは、security boundaryへの影響がなければSecurity findingにしない
- 詳細error messageは、低信頼主体へ機密情報が返る経路がある場合に評価する
