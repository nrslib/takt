# ローカル process・path・terminal・設定のセキュリティ知識

## 適用条件

低信頼の CLI 引数、環境変数、設定、repository 内容が process 実行、filesystem 操作、terminal 出力、credential、sandbox、ローカル権限へ到達する変更に適用する。local という理由で同じ trust level とみなさず、各 source を分けて評価する。

## Process 実行

実行ファイル、引数、environment、working directory、loader、plugin、search path は別々の制御点である。

| 条件 | 確認する境界・影響 |
|------|--------------------|
| 低信頼の値が shell command 文字列へ入る | shell による再解釈と、起動 process の権限で可能な command まで追う |
| 値が executable・loader・plugin・environment entry・search path を選ぶ | 制御主体と、宣言された権限または sandbox を越えて実行されるかを確認する |
| 固定 executable へ shell を使わず引数配列で渡す | 引数自体が interpreter、設定、出力先、危険な実行機能を選ばないか確認する |

## Path と filesystem 権限

字句上の path 選択と、解決 target に対する権限を分ける。相対関係の正規化は lexical containment の判断材料になり、既存 symlink・filesystem race は、契約が escape を禁じる境界でのみ canonical path または handle による証拠を必要とする。path の制御主体、保護 root、解決される read・write・delete target、機密性・完全性への影響を特定する。

## Terminal の解釈

repository label、filename、command output は terminal 利用者より低信頼な場合がある。可視 text と control sequence の解釈を分ける。byte の制御主体、到達する terminal sequence と semantics、表示・clipboard・入力その他の効果、その terminal を信頼する主体を特定する。

## Repository とローカル設定の trust

repository 設定、user-global 設定、環境変数、runtime credential、明示 CLI 選択は、所有者と trust level が異なり得る。どの source が採用され、誰が制御し、process・filesystem・terminal・credential・network・sandbox・tool・ローカル権限を広げるかを確認する。同じ trust level の source を documented な方法で選ぶだけでは、権限変更を示さない。
