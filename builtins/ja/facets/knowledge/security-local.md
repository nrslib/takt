# CLI・ローカル実行セキュリティ知識

## 適用条件

CLI、shell/process起動、ファイルシステム、ローカル設定を扱う変更に適用する。

## インジェクション攻撃

**コマンドインジェクション**

- `exec()`, `spawn()` での未検証入力 → REJECT
- シェルコマンド構築時のエスケープ不足 → REJECT

```typescript
// NG
exec(`ls ${userInput}`)

// OK
execFile('ls', [sanitizedInput])
```

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

## OWASP Top 10 チェックリスト

| カテゴリ | 確認事項 |
|---------|---------|
| A03 Injection | コマンド |
