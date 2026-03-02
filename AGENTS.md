# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript の本体コード。CLI は `src/app/cli/`、コア実行ロジックは `src/core/`、共通機能は `src/shared/`、機能別実装は `src/features/` に配置。
- `src/__tests__/`: 単体・統合テスト（`*.test.ts`）。
- `e2e/`: E2E テストと補助ヘルパー。
- `builtins/`: 組み込みピース、テンプレート、スキーマ。
- `docs/`: 設計・CLI・運用ドキュメント。
- `dist/`: ビルド成果物（生成物のため手編集しない）。
- `bin/`: CLI エントリーポイント（`takt`, `takt-dev`）を提供。

## Build, Test, and Development Commands
- `npm install`: 依存関係をインストール。
- `npm run build`: TypeScript を `dist/` にビルドし、プロンプト・i18n・preset ファイルをコピー。
- `npm run watch`: `tsc --watch` で継続ビルド。
- `npm run lint`: `src/` を ESLint で検証。
- `npm test`: `vitest run` で通常テスト実行。
- `npm run test:e2e:mock`: モックプロバイダーで E2E 実行。
- `npm run test:e2e:all`: mock + provider E2E を連続実行。

## Coding Style & Naming Conventions
- 言語は TypeScript（ESM）。インデントは 2 スペース、既存スタイルを維持。
- ファイル名は機能を表す `kebab-case` または既存準拠（例: `taskHistory.ts`）。
- テスト名は対象機能が分かる具体名（例: `provider-model.test.ts`）。
- Lint ルール: `@typescript-eslint/no-explicit-any` と未使用変数を厳格に検出（未使用引数は `_` 接頭辞で許容）。

## Testing Guidelines
- フレームワークは Vitest。Node 環境で実行。
- 変更時は最低限 `npm test` を通し、実行経路に影響する変更は `npm run test:e2e:mock` まで確認。
- カバレッジ取得は Vitest の V8 レポーター（text/json/html）を使用。

## Commit & Pull Request Guidelines
- コミットは小さく、1コミット1目的。
- 形式は Conventional Commits 推奨（`feat:`, `fix:`, `refactor:`, `test:`）。必要に応じて Issue 番号を付与（例: `fix: ... (#388)` / `[#367] ...`）。
- PR では目的、変更点、テスト結果、影響範囲を明記。挙動変更がある場合は再現手順を添付。
- 大規模変更は先に Issue で合意し、関連ドキュメント（`README.md` / `docs/`）も更新する。

## Security & Configuration Tips
- 機密情報（API キー、トークン）はコミットしない。設定は `~/.takt/config.yaml` や環境変数を使用。
- Provider や実行モード変更時は `docs/configuration.md` と `docs/provider-sandbox.md` を先に確認する。
