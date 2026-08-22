# データ・機密情報セキュリティ知識

## 適用条件

credential、個人情報・保護 data、log、error、response、成果物、repository 内容、暗号 material に影響する変更へ適用する。

## 露出境界

field 名や log 出力の存在だけで判定しない。data、その発生元、受け取る出力・保存先、その宛先を観測できる全主体、具体的な権限外の観測者を特定する。

| 条件 | 確認する露出・影響 |
|------|--------------------|
| password、token、API key、session 値、認証 header が log・成果物へ到達する | 宛先を読める主体と、その credential が与える access を確認する |
| request、object、exception、serialize 値全体を出力する | 含まれる機密 field と、それを受け取る権限外の観測者を特定する |
| 内部 path、query、stack、他 resource の内容が response へ到達する | caller と、その caller から保護される情報・data かを確認する |
| 個人情報を log へ出力する | data classification、運用上の必要性、保持、宛先の閲覧者、権限外露出を確認する |
| secret または保護 file を repository へ記録する | repository・後続成果物を読める主体と、得られる能力・data を特定する |

mask・除外は、実際の serialize 経路を覆う場合にだけ有効である。無効な log level は、deployment・設定によって権限外の観測者が読める出力へ値が到達しない場合にだけ露出を変える。

## 暗号 material と semantics

algorithm、key、nonce、transport protection、hash では、保護する性質、攻撃者の能力、runtime・protocol semantics、機密性・完全性への具体的影響を特定する。非推奨という名称だけでは影響を示さない。hardcoded key、nonce の再利用、保護されない transport は、関連する主体と観測・変更経路が到達可能な場合に影響を示し得る。
