# API・サーバーセキュリティ知識

## 適用条件

外部または低信頼クライアントから呼ばれるAPI・server endpoint、認証・認可、database query、tenant境界を変更する場合に適用する。ローカルCLI、build script、browser UIだけの変更には適用しない。

## SQL injection

- 低信頼値を文字列連結してSQLを構築する実行経路 → REJECT
- ORMのraw queryへ未検証値が到達する実行経路 → REJECT
- parameterized queryまたは同等のbindingが全到達経路で使われる → OK

```typescript
// NG
db.query(`SELECT * FROM users WHERE id = ${userId}`)

// OK
db.query('SELECT * FROM users WHERE id = ?', [userId])
```

## 認証・認可

### 認証

- 平文passwordの保存 → 即REJECT
- 弱いpassword hashの新規利用 → REJECT
- session tokenの扱いにより、第三者がsessionを取得・固定・再利用できる経路 → REJECT

### 認可

- 保護対象操作へ権限checkなしで到達できる経路 → REJECT
- IDORにより他利用者・他tenantの資産へ到達できる経路 → REJECT
- 低権限主体が高権限操作を実行できる経路 → REJECT

## API入力検証

- 低信頼入力がtrust boundaryを越える前に必要な意味検証を受けない経路 → REJECT
- runtimeで型保証されない入力を型検証なしで利用する経路 → REJECT
- input size上限がないことだけを根拠にREJECTしない。具体的な経路と影響をSecurity専用policyに従って評価する

## Server-side request

- 低信頼入力が接続先のhost、scheme、port、pathを制御し、内部serviceやmetadata endpointへ到達できる経路 → REJECT
- serverが外向きrequestを行うこと自体は問題としない。攻撃者が制御できる部分と到達可能な資産を確認する

## Rate limit・DoS

- 認証endpointのrate limit不足 → 警告
- リソース枯渇の可能性だけを根拠にREJECTしない
- 無限loopや無制限処理は、到達可能な入力、停止不能な経路、具体的な影響が確認できる場合だけblocking候補とする

## マルチテナントデータ分離

tenant境界を越えたデータアクセスを防ぐ。認可とtenant scopingは別の関心事であり、読み取りと書き込みの両方を確認する。

| 基準 | 判定 |
|------|------|
| 読み取りはtenant scopeだが書き込みはscopeなし | REJECT |
| 書き込みでclient提供のtenant IDを信頼する | REJECT |
| tenant resolverを使うendpointに必要な認可がない | REJECT |
| role分岐の一部だけtenant解決を通らない | REJECT |
| 想定呼び出しroleを認証する仕組みの適用範囲外にendpointがある | REJECT |

### 読み書きの一貫性

読み取りにtenant filterを追加した場合、対応する書き込みも認証済み主体から解決したtenant IDで検証する。

### 認可とresolverの整合性

resolverが特定roleを前提とする場合、その前提をendpointの認可で保証する。role分岐がある場合は全経路で認証・認可・tenant解決の対応を確認する。
