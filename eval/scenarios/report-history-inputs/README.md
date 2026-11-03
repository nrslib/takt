# 現在レポートと履歴の読み取り評価

ビルド後に `node eval/scenarios/report-history-inputs/run.mjs [model]` を実行する。

実際のpeer-reviewから修正計画へ継承する裁定入力と、development-remediationのcycle内の修正報告を宣言する監視入力を使う。入力解決、固定版保存、InstructionBuilderとrunAgentを通し、provider境界で完成した入力を捕捉して既存の読み取り専用モデル実行器へ渡す。役割ごとに作業ディレクトリを分離し、現在版の省略部分と履歴だけに実行ごとに異なる照合証拠を置く。

成功には、両方の証拠が正常終了した読み取りコマンドの出力に現れ、比較結果が現在の修正対象Bだけを保持し、Aの完了を進捗と判断することが必要。自己申告だけでは成功しない。

モデル実行とセッション監査はリポジトリ外のprivateな一時領域で行う。評価専用のHOME・CODEX_HOMEを作り、認証用のauth.jsonだけを渡す。個人の設定・記憶・指示・skillsや任意の環境変数は継承しない。認証準備に失敗した場合は評価を失敗させ、元のHOMEで続行しない。一時領域は成功・失敗・中断の各経路で削除する。

`eval/results/report-history-inputs/`へ保存するのは公開用に変換した入力、比較結果、実行条件、固定レポートと読み取り証拠である。パスは評価成果物を基準とする相対座標へ変換する。モデル応答は照合証拠・現在対象・進捗の4項目へ投影し、コマンド記録は対象レポートを読む正常終了した実コマンドと、照合証拠を含む資料行の出力抜粋に限定する。ローカル指示の出力や生のモデル記録、認証情報は公開しない。失敗時も生のエラー本文を保存せず、失敗・中断と証拠不足を記録する。

traceの`executedPromptHash`・`executedResponseHash`は実行時の値、`promptHash`・`responseHash`と`publication.json`は変換後の公開物の値を表す。固定版の読み取り証拠には公開後の本文ハッシュを付ける。

複合コマンドに対象外の操作がある場合は、実際に実行された読み取り部分を`commandExcerpt: true`として抜粋する。`exitCodeScope`が示す終了値は記録されたコマンド全体のもので、抜粋部分の独立した終了値とは扱わない。元のコマンドはハッシュだけを保持する。

既存3結果の情報除去には`node eval/scenarios/report-history-inputs/sanitize-existing.mjs`を使う。過去結果の`originalPass`と、公開後に残った証拠の`pass`を区別し、隔離後の新規実行としては扱わない。公開物の対応・ハッシュ・除去結果は別途全件確認する。

隔離・公開保存の決定的テストは`npm run eval:prompts:report-history-inputs:contracts`で実行する。
