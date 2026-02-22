# セキュリティ知識

## AI生成コードのセキュリティ問題

AI生成コードには特有の脆弱性パターンがある。

| パターン | リスク | 例 |
|---------|--------|-----|
| もっともらしいが危険なデフォルト | 高 | `cors: { origin: '*' }` は問題なく見えるが危険 |
| 古いセキュリティプラクティス | 中 | 非推奨の暗号化、古い認証パターンの使用 |
| 不完全なバリデーション | 高 | 形式は検証するがビジネスルールを検証しない |
| 入力を過度に信頼 | 重大 | 内部APIは常に安全と仮定 |
| コピペによる脆弱性 | 高 | 同じ危険なパターンが複数ファイルで繰り返される |

特に厳しく審査が必要:
- 認証・認可ロジック（AIはエッジケースを見落としがち）
- 入力バリデーション（AIは構文を検証しても意味を見落とす可能性）
- エラーメッセージ（AIは内部詳細を露出する可能性）
- 設定ファイル（AIは学習データから危険なデフォルトを使う可能性）

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

**コマンドインジェクション**

- `exec()`, `spawn()` での未検証入力 → REJECT
- シェルコマンド構築時のエスケープ不足 → REJECT

```typescript
// NG
exec(`ls ${userInput}`)

// OK
execFile('ls', [sanitizedInput])
```

**XSS (Cross-Site Scripting)**

- HTML/JSへの未エスケープ出力 → REJECT
- `innerHTML`, `dangerouslySetInnerHTML` の不適切な使用 → REJECT
- URLパラメータの直接埋め込み → REJECT

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

**機密情報の露出**

- APIキー、シークレットのハードコーディング → 即REJECT
- ログへの機密情報出力 → REJECT
- エラーメッセージでの内部情報露出 → REJECT
- `.env` ファイルのコミット → REJECT

**データ検証**

- 入力値の未検証 → REJECT
- 型チェックの欠如 → REJECT
- サイズ制限の未設定 → REJECT

## 暗号化

- 弱い暗号アルゴリズムの使用 → REJECT
- 固定IV/Nonceの使用 → REJECT
- 暗号化キーのハードコーディング → 即REJECT
- HTTPSの未使用（本番環境） → REJECT

## ファイル操作

**パストラバーサル**

- ユーザー入力を含むファイルパス → REJECT
- `../` のサニタイズ不足 → REJECT

```typescript
// NG
const filePath = path.join(baseDir, userInput)
fs.readFile(filePath)

// OK
const safePath = path.resolve(baseDir, userInput)
if (!safePath.startsWith(path.resolve(baseDir))) {
  throw new Error('Invalid path')
}
```

**ファイルアップロード**

- ファイルタイプの未検証 → REJECT
- ファイルサイズ制限なし → REJECT
- 実行可能ファイルのアップロード許可 → REJECT

## 依存関係

- 既知の脆弱性を持つパッケージ → REJECT
- メンテナンスされていないパッケージ → 警告
- 不必要な依存関係 → 警告

## エラーハンドリング

- スタックトレースの本番露出 → REJECT
- 詳細なエラーメッセージの露出 → REJECT
- エラーの握りつぶし（セキュリティイベント） → REJECT

## レート制限・DoS対策

- レート制限の欠如（認証エンドポイント） → 警告
- リソース枯渇攻撃の可能性 → 警告
- 無限ループの可能性 → REJECT

## マルチテナントデータ分離

テナント境界を超えたデータアクセスを防ぐ。認可（誰が操作できるか）とスコーピング（どのテナントのデータか）は別の関心事。

| 基準 | 判定 |
|------|------|
| 読み取りはテナントスコープだが書き込みはスコープなし | REJECT |
| 書き込み操作でクライアント提供のテナントIDを使用 | REJECT |
| テナントリゾルバーを使うエンドポイントに認可制御がない | REJECT |
| ロール分岐の一部パスでテナント解決が未考慮 | REJECT |

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

## OWASP Top 10 チェックリスト

| カテゴリ | 確認事項 |
|---------|---------|
| A01 Broken Access Control | 認可チェック、CORS設定 |
| A02 Cryptographic Failures | 暗号化、機密データ保護 |
| A03 Injection | SQL, コマンド, XSS |
| A04 Insecure Design | セキュリティ設計パターン |
| A05 Security Misconfiguration | デフォルト設定、不要な機能 |
| A06 Vulnerable Components | 依存関係の脆弱性 |
| A07 Auth Failures | 認証メカニズム |
| A08 Software Integrity | コード署名、CI/CD |
| A09 Logging Failures | セキュリティログ |
| A10 SSRF | サーバーサイドリクエスト |
