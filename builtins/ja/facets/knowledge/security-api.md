# API・サーバーセキュリティ知識

## 適用条件

API、server endpoint、認証・認可、database query、tenant境界を扱う変更に適用する。

## インジェクション攻撃

**SQLインジェクション**

- 文字列連結によるSQL構築 → REJECT
- パラメータ化クエリの不使用 → REJECT
- ORMの raw query での未サニタイズ入力 → REJECT

```typescript
// NG
db.query(`SELECT * FROM users WHERE id = ${userId}`)

// OK
db.query('SELECT * FROM users WHERE id = ?', [userId])
```

## 認証・認可

**認証の問題**

- ハードコードされたクレデンシャル → 即REJECT
- 平文パスワードの保存 → 即REJECT
- 弱いハッシュアルゴリズム (MD5, SHA1) → REJECT
- セッショントークンの不適切な管理 → REJECT

**認可の問題**

- 権限チェックの欠如 → REJECT
- IDOR (Insecure Direct Object Reference) → REJECT
- 権限昇格の可能性 → REJECT

```typescript
// NG - 権限チェックなし
app.get('/user/:id', (req, res) => {
  return db.getUser(req.params.id)
})

// OK
app.get('/user/:id', authorize('read:user'), (req, res) => {
  if (req.user.id !== req.params.id && !req.user.isAdmin) {
    return res.status(403).send('Forbidden')
  }
  return db.getUser(req.params.id)
})
```

## データ保護

**データ検証**

- 入力値の未検証（サイズ制限の未設定だけの場合を除く）→ REJECT
- 型チェックの欠如 → REJECT
- サイズ制限の未設定はリソース枯渇につながり得るため、具体的な経路を Security 専用 policy に従って確認する

## レート制限・DoS対策

- レート制限の欠如（認証エンドポイント） → 警告
- リソース枯渇攻撃の可能性 → 警告
- 無限ループのパターンはサービス拒否につながり得るため、確認できた経路と影響を Security 専用 policy に従って評価する

## マルチテナントデータ分離

テナント境界を超えたデータアクセスを防ぐ。認可（誰が操作できるか）とスコーピング（どのテナントのデータか）は別の関心事。

| 基準 | 判定 |
|------|------|
| 読み取りはテナントスコープだが書き込みはスコープなし | REJECT |
| 書き込み操作でクライアント提供のテナントIDを使用 | REJECT |
| テナントリゾルバーを使うエンドポイントに認可制御がない | REJECT |
| ロール分岐の一部パスでテナント解決が未考慮 | REJECT |
| エンドポイントの想定呼び出し者（ロール・トークン種別）に認証機構の適用範囲が及んでいない | REJECT |

### 読み書きの一貫性

テナントスコーピングは読み取りと書き込みの両方に適用する。片方だけでは、参照できないが変更できる状態が生まれる。

読み取りにテナントフィルタを追加したら、対応する書き込みも必ずテナント検証する。

### 書き込みのテナント検証

書き込み操作では、リクエストボディのテナントIDではなく認証済みユーザーから解決したテナントIDを使う。

```kotlin
// NG - クライアント提供のテナントIDを信頼
fun create(request: CreateRequest) {
    service.create(request.tenantId, request.data)
}

// OK - 認証情報からテナントを解決
fun create(request: CreateRequest) {
    val tenantId = tenantResolver.resolve()
    service.create(tenantId, request.data)
}
```

### 認可とリゾルバーの整合性

テナントリゾルバーが特定ロール（例: スタッフ）を前提とする場合、エンドポイントに対応する認可制御が必要。認可なしだと、前提外のロールがアクセスしてリゾルバーが失敗する。

```kotlin
// NG - リゾルバーが STAFF を前提とするが認可制御なし
fun getSettings(): SettingsResponse {
    val tenantId = tenantResolver.resolve()  // STAFF 以外で失敗
    return settingsService.getByTenant(tenantId)
}

// OK - 認可制御でロールを保証
@Authorized(roles = ["STAFF"])
fun getSettings(): SettingsResponse {
    val tenantId = tenantResolver.resolve()
    return settingsService.getByTenant(tenantId)
}
```

ロール分岐があるエンドポイントでは、全パスでテナント解決が成功するか検証する。

逆パターンにも注意する。特定ロール専用のエンドポイントを追加する場合、そのロールを認証する機構（フィルタ等）の適用範囲拡張と、ロール必須の認可制御を同じ変更で行う。認証機構の適用範囲外だと想定呼び出し者がそもそも認証されず、認可がないと想定外ロールが通ってしまう。

## OWASP Top 10 チェックリスト

| カテゴリ | 確認事項 |
|---------|---------|
| A01 Broken Access Control | 認可チェック |
| A03 Injection | SQL |
| A07 Auth Failures | 認証メカニズム |
| A10 SSRF | サーバーサイドリクエスト |
