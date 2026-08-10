# Webセキュリティ知識

## 適用条件

ブラウザで解釈されるHTML・JavaScript・URL、DOM操作、CORS、またはブラウザからのファイル送信を扱う変更に適用する。

## インジェクション攻撃

**XSS (Cross-Site Scripting)**

- HTML/JSへの未エスケープ出力 → REJECT
- `innerHTML`, `dangerouslySetInnerHTML` の不適切な使用 → REJECT
- URLパラメータの直接埋め込み → REJECT

## ファイル操作

**ファイルアップロード**

- ファイルタイプの未検証 → REJECT
- ファイルサイズ制限なしはリソース枯渇につながり得るため、具体的な経路を Security 専用 policy に従って確認する
- 実行可能ファイルのアップロード許可 → REJECT

## OWASP Top 10 チェックリスト

| カテゴリ | 確認事項 |
|---------|---------|
| A01 Broken Access Control | CORS設定 |
| A03 Injection | XSS |
