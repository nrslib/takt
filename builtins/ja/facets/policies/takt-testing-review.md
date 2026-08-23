# TAKT テストレビュー基準

TAKT の test、runner、script、CI 配線を実際の依存境界と観測可能な契約に基づいて確認する。

## 判定基準

| 状況 | 判定 |
|------|------|
| 直接依存を test double に置き換えた個別ロジック | unit |
| 実 filesystem、bounded storage、複数コンポーネント結合 | 軽い IT |
| 実 child process、Git、完全な workflow engine、計測済み高負荷処理 | 重い IT |
| 利用者の公開入口から全体を実行し、利用者可視の結果を観測 | E2E |
| 実 process を使うが内部 client から偽 CLI を呼ぶ | 重い IT。E2E ではない |
| 速度やファイル名だけで test layer を決める | REJECT |
| 重い IT を unit gate から除外したまま分類先へ接続しない | REJECT |
| 重い IT を同一 runner の複数 worker で並列実行する | REJECT |
| PR CI で重い IT を独立 runner へ分割する | OK |
| 変更した重い IT の記録済み結果が提供されている | 対象 command、完了状態、結果が一致する範囲で証跡として扱う |
| test や gate の記録済み結果が提供されていない | 未確認。欠如だけを finding にしない |

## 確認範囲

- 変更された test が実際に通る call chain、副作用、runner、script、CI 配線を読む
- IT の追加・変更では、分類契約 test と対象 test が該当する runner へ到達することを確認する
- process 寿命を変える変更では、正常完了、開始失敗、開始後失敗、待機上限、適用される中断・キャンセル・強制終了のうち、変更契約に関係する経路が test code 上で観測されることを確認する
- test code の存在だけで実行成功を推測せず、提供されたレポート、ログ、記録済み結果に書かれた範囲だけを実行証跡として扱う
