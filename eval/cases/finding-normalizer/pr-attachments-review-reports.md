# Finding normalizer intake reports

## Candidate reports

### Candidate report 1

この実装は、GitHub PRの画像アタッチメント機能を適切に統合しており、設計上の大きな問題は見当たりません。

### 評価
- **責務の分離**: 画像の抽出・ダウンロード・一時保存を `src/infra/github/prAttachments.ts` に、タスクファイルへの永続化を `src/features/tasks/attachments.ts` と `src/features/tasks/add/index.ts` に適切に分離できています。
- **安全性**: `isAllowedGitHubAttachmentUrl` によるURL制限、`MAX_IMAGE_ATTACHMENT_BYTES` によるサイズ制限、Magic bytes検証、および一時ディレクトリの権限設定（`0o700`）が実装されており、セキュリティ要件を満たしています。
- **一貫性**: 既存の `TaskAttachment` 型を再利用し、`saveTaskFile` 経由で `.takt/tasks/<slug>/attachments/` への配置と `order.md` への追記を既存の仕組み（`promoteTaskAttachments` 等）に乗せて実現しています。
- **認証**: `gh auth token` を利用してプライベートリポジトリの画像取得に対応しています。

### 構造的確認
- `src/infra/github/pr.ts` $\rightarrow$ `attachPrReviewImages()` $\rightarrow$ `src/infra/github/prAttachments.ts` (抽出・DL)
- `src/features/tasks/add/index.ts` $\rightarrow$ `saveTaskFile()` $\rightarrow$ `src/features/tasks/attachments.ts` $\rightarrow$ `promoteTaskAttachments()` (永続化)

依存方向は `Infra` $\rightarrow$ `Feature` ではなく、CLI/Feature層が Infra層の機能を利用する形となっており、レイヤー設計に準拠しています。

**APPROVE**

---

### Candidate report 2

この実装は、PRコメント内の画像を抽出してローカルに保存し、タスク定義に紐付けるという要件を概ね満たしています。特に、`gh auth token` を使用してプライベートリポジトリの画像に対応し、マジックバイトによるContent-Type検証やサイズ制限を設けるなど、安全性への配慮が見られます。

しかし、AI生成コードに特有の「不完全な型定義」と「リソース管理の漏れ」に起因する潜在的な問題が検出されました。

### 検出された問題

#### 1. `SoredImageAttachment` と `TaskAttachment` の型不整合によるランタイムリスク
- **箇所**: `src/infra/github/prAttachments.ts:178` および `src/features/tasks/add/index.ts:219`
- **根拠**: 
    - `src/infra/github/prAttachments.ts` では `StoredImageAttachment` 型として `placeholder`, `tempPath`, `fileName` を定義しています。
    - しかし、`src/features/tasks/add/index.ts` の `saveTaskFile` が期待する `TaskAttachment` 型（`src/features/tasks/attachments.ts` で定義されているはずの型）と、この `StoredImageAttachment` が同一であるか、または互換性があるかが曖昧なままキャストまたは直接渡されています。
    - 特に `StoredImageAttachment` には `content` や `mimeType` といった、実際にファイルを保存する際に必要なメタデータが含まれておらず、`tempPath` という「一時的なパス」に依存しています。
- **影響**: `prepareTaskSpecDirectory` 内部で `tempPath` が正しく処理されない場合、画像が保存されないか、パス解決に失敗してランタイムエラーが発生します。
- **修正方針**: `StoredImageAttachment` から `TaskAttachment` への明示的な変換ロジックを導入し、一時パスではなくファイルの内容（Buffer）を渡す構造にするか、`TaskAttachment` 型の定義に合わせて `StoredImageAttachment` を修正してください。

#### 2. 非同期処理における `cleanupAttachments` の呼び出し漏れリスク
- **箇所**: `src/features/tasks/add/index.ts:223`
- **根拠**: `prReview.cleanupAttachments?.()` が `finally` ブロックで呼ばれていますが、これは `attachPrReviewImages` が `Promise` を返す（`AttachedPrReviewData | Promise<AttachedPrReviewData>`）ため、`prReview` が Promise の状態で `finally` に入ると、`cleanupAttachments` プロパティにアクセスできず、一時ディレクトリがディスクに残ります。
- **影響**: `takt add --pr` を繰り返すと `/tmp/takt/pr-attachments/` 配下に大量のゴミディレクトリが蓄積されます。
- **修正方針**: `prReview` を完全に `await` してから `finally` ブロックでクリーンアップを呼び出すように修正してください。

#### 3. `SoredImageAttachment` のタイポ（軽微）
- **箇所**: `src/infra/github/prAttachments.ts:7`
- **根拠**: `StoredImageAttachment` という名称であるべきところが、一部の文脈や型定義で `Sored...` となっている可能性があります（提供されたコード内では `Stored` ですが、要確認）。

### 判定
**REJECT**

型安全性の不足（一時パスへの依存）と、リソースリークの可能性（Promise未解決状態でのクリーンアップ呼び出し）があるため、修正が必要です。

---

### Candidate report 3

The implementation of PR image attachment downloading has been reviewed.

### Findings

**1. Missing Unit/Integration Tests for `prAttachments.ts`**
The file `src/infra/github/prAttachments.ts` contains critical logic for URL extraction, validation, and downloading (including security checks for MIME types and size limits). However, there are no corresponding tests in `src/__tests__/` for this specific file. `src/__tests__/imageAttachments.test.ts` tests the interactive session's attachment store, not the GitHub PR attachment logic.
- **Location:** `src/infra/github/prAttachments.ts`
- **Impact:** Regressions in URL parsing, security bypasses in MIME type validation, or failures in the `gh auth token` flow may go undetected.
- **Correction:** Add comprehensive tests for `extractImageUrls`, `isAllowedGitHubAttachmentUrl`, and `downloadAndAttachPrReviewImages` (using mocks for `fetch` and `execFileSync`).

**2. Potential Performance Issue: Redundant Regex Execution**
In `downloadAndAttachPrReviewImages` (`src/infra/github/prAttachments.ts:238-252`), `replaceUrlsInText` iterates over all discovered attachments and runs `MARKDOWN_IMAGE_PATTERN` and `HTML_IMG_PATTERN` globally for every single attachment.
- **Location:** `src/infra/github/prAttachments.ts:241, 246`
- **Impact:** $O(N_{attachments} \times \text{text\_length})$ complexity. For PRs with many images or long bodies, this will be inefficient.
- **Correction:** Use a single pass with a replacement function that looks up the matched URL in the `urlToAttachment` map.

### Summary
The core logic is implemented and follows the safety constraints (private modes, size limits, GitHub-only URLs). However, the **total lack of tests for the new infrastructure logic** is a blocking issue.

**Verdict: REJECT**

---

### Candidate report 4

The implementation of PR image attachments in `src/infra/github/prAttachments.ts` has been reviewed.

### Findings

#### 1. Inefficient Text Replacement Complexity (O(N*M))
- **Location**: `src/infra/github/prAttachments.ts:238-252`
- **Issue**: The `replaceUrlsInText` function iterates over all discovered attachments for every piece of text, and for each attachment, it performs two full-text regex replacements. If a PR has many images and long comments, this becomes $O(\text{attachments} \times \text{text length})$.
- **Impact**: Potential performance degradation on large PRs with many images.
- **Correction**: Perform a single pass over the text using a regex and a lookup table (Map) to replace URLs with their corresponding placeholders.

#### 2. Potential Leak of Temporary Directory on Success
- **Location**: `src/infra/github/prAttachments.ts:266`
- **Issue**: While `cleanupAttachments` is provided in the return object, the responsibility for calling it is passed to the caller. If the caller fails to invoke this cleanup after moving the files to the final task directory, the `os.tmpdir()` will accumulate garbage.
- **Impact**: Disk space leakage in the system temporary directory.
- **Correction**: Ensure the higher-level orchestration (where `attachPrReviewImages` is called) has a guaranteed `try-finally` block to call `cleanupAttachments()`. (Note: This is a structural concern; verify the caller's implementation).

### Summary
The code is logically sound regarding data structures (correct use of `Map` for URL tracking) and security (private directory modes and content-type verification). The performance of the replacement loop is the primary semantic concern.

**Status: REJECT** (due to the $O(N \times M)$ replacement logic which can be optimized to $O(N)$).

---

### Candidate report 5



---

### Candidate report 6

### 堅牢性レビュー結果

実装された `src/infra/github/prAttachments.ts` をレビューしました。

#### 1. 原子性と後始末（Cleanup）
- **正常系**: `downloadAndAttachPrReviewImages` 内で `cleanupAttachments` 関数が返され、呼び出し側に後始末の責任が委譲されています。
- **失敗系**: 268-271行目で `try...catch` により、画像ダウンロード等の処理中に例外が発生した場合は、即座に `cleanupTempDirectory(tempRoot)` が呼ばれ、一時ディレクトリが削除されます。これにより、失敗時のリソース漏れが防止されています。

#### 2. リソース保護（DoS 対策）
- **入力制限**: `readImageBody` (90-112行目) において、ストリーミング読み込み中に `MAX_IMAGE_ATTACHMENT_BYTES` を超えた時点で `reader.cancel()` を呼び出し、即座にエラーをスローしています。全量をメモリに読み込む前にチェックが行われており、メモリ消費に対する保護が適切に実装されています。
- **タイムアウト**: `downloadImage` (118-119行目) で `AbortController` を使用し、30秒のタイムアウトが設定されており、外部サーバーの応答遅延によるプロセス停止を防いでいます。

#### 3. セキュリティと検証
- **URL 制限**: `isAllowedGitHubAttachmentUrl` (41-58行目) により、`https://github.com` かつ特定のパス（`user-attachments/assets` 等）を持つ URL のみに限定されており、SSRF リスクが低減されています。
- **コンテンツ検証**: `downloadImage` 内で `Content-Type` の検証 (139-142行目) および、`assertImageContentTypeMatchesMagic` によるマジックバイトの検証 (156行目) が行われており、偽装ファイルの保存を防止しています。
- **権限管理**: 一時ディレクトリおよびファイル作成時に `0o700` / `0o600` モードが指定されており、他ユーザーからのアクセスが制限されています。

#### 4. 冪等性と一貫性
- **URL 処理**: `urlToIndex` マップを用いて同一 URL には同一のインデックスを割り当てており、重複ダウンロードを回避し、`order.md` 等への追記時の一貫性が保たれています。

#### 結論
要件にある「サイズ上限」「Content-Type/magic bytes検証」「認証経由の取得」「外部URL制限」がすべて堅牢に実装されており、失敗時のリソース解放経路も確保されています。

**APPROVE**
