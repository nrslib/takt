# TAKT への貢献

[English](../CONTRIBUTING.md)

TAKT への貢献に興味を持っていただきありがとうございます。このプロジェクトでは TAKT のレビューピースを使って PR の品質を確認しています。

## 開発環境のセットアップ

```bash
git clone https://github.com/your-username/takt.git
cd takt
npm install
npm run build
npm test
npm run lint
```

## 貢献の流れ

1. **Issue を起票** して変更内容を議論する
2. **小さく焦点を絞った変更** にする — バグ修正、ドキュメント改善、typo 修正を歓迎します
3. 新しい振る舞いには **テストを含める**
4. PR 提出前に **レビューを実行する**（下記参照）

事前議論なしの大規模リファクタリングや機能追加はレビューが困難なため、お断りする場合があります。

## PR 提出前の必須事項

すべての PR は TAKT レビュープロセスを通過する必要があります。レビューサマリーが添付されていない PR、または REJECT 指摘が未解消の PR はマージされません。

### 1. CI チェックをパスする

```bash
npm run build
npm run lint
npm test
```

### 2. TAKT レビューを実行する

```bash
# PR を作成してからレビューを実行
takt -t "#<PR番号>" -w review
```

### 3. APPROVE を確認する

`.takt/runs/*/reports/review-summary.md` のレビューサマリーを確認してください。結果が **REJECT** の場合は、報告された問題を修正し、**APPROVE** になるまでレビューを再実行してください。

REJECT 指摘が解消不可能な場合（誤検知、意図的な設計判断など）は、その理由を PR のコメントに記載してください。

### 4. レビューサマリーを PR に含める

`review-summary.md` の内容を PR のコメントとして投稿してください。これは**必須**です。メンテナーがレビューの実行と通過を確認するために使用します。

## コードスタイル

- TypeScript strict mode
- ESLint によるリンティング
- 巧妙なコードより、シンプルで読みやすいコードを優先

## ライセンス

貢献いただいたコードは MIT ライセンスの下でライセンスされることに同意したものとみなされます。
