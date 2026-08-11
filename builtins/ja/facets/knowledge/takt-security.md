# TAKT固有のセキュリティ知識

## 適用範囲

workflow・facetの解決、provider呼び出し、session・resume状態、step権限、selector、worktree実行のいずれかに変更が到達する場合に適用する。ファイル名や設定キーがTAKT固有というだけでは適用根拠にならない。

| 変更経路 | 適用 |
|----------|------|
| workflow入力から実行時stepまでの設定解決 | 対象 |
| provider・selector・sessionの識別と引き継ぎ | 対象 |
| step権限、tool、worktree、subprocessの実行境界 | 対象 |
| 実行経路を変えない文書・表示のみの変更 | 対象外 |
| 依存更新だけの変更 | supply-chain knowledgeを使用 |

## 設定と実行の一致

schema、loader、normalizer、preview、doctor、runtimeは同じ設定契約を解釈する。補助経路だけが異なる値や優先順位を採用すると、検証済みの表示と実行時の権限・providerが乖離する。

| 基準 | 判定 |
|------|------|
| previewまたはdoctorが受理した設定とruntimeの解決結果が異なる | REJECT |
| workflow・project・global間の優先順位が経路ごとに異なる | REJECT |
| 未知参照や不正なselector結果を黙って既定値へ置換する | REJECT |
| 境界で一度解決した値を、実行・表示・保存で共有する | OK |

## 識別情報と状態の分離

provider、model、selector、session、resume、occurrenceの識別情報は、workflow呼び出し・parallel子・retryを跨いでも所有者が一意である必要がある。

| 基準 | 判定 |
|------|------|
| 別providerまたは別parallel子のsessionを再利用できる | REJECT |
| resume snapshotが別stepまたは別parent occurrenceへ適用される | REJECT |
| retry後の新sessionが古いsession識別子を暗黙に継続する | REJECT |
| 所有者を含む識別キーと保存境界が一致する | OK |

## 実行権限と副作用

stepが宣言したcapability・tool・edit契約が、provider呼び出し、worktree、subprocess、リポジトリ変更まで維持されることが信頼境界になる。

| 基準 | 判定 |
|------|------|
| readonly stepから編集toolまたはリポジトリ変更へ到達できる | REJECT |
| 子workflowが呼び出し元より広い権限を暗黙に取得する | REJECT |
| worktree外のパスや別repositoryへ副作用が漏れる | REJECT |
| 宣言した権限が末端provider・tool実行まで保持される | OK |

## エラーとフォールバック

selector、provider、runnerの失敗は所有境界で停止し、別workflow・provider・候補全選択へ意味を変えない。

| 基準 | 判定 |
|------|------|
| selector失敗時に全candidateまたは既定candidateを適用する | REJECT |
| provider失敗を別providerへ暗黙に切り替える | REJECT |
| 一部parallel子の準備失敗後に兄弟stepが副作用を開始する | REJECT |
| 実行開始前に入力を確定し、失敗時は同じ所有境界で停止する | OK |
