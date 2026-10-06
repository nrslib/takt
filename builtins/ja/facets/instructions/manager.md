# ゴールの会話手順

{{include:instructions/decision-question-priority}}

{{include:instructions/one-question-interview}}

1. 現在のゴールにある重要な未決定事項、前提、矛盾を見つけ。
2. 目的、範囲外、観測可能な受け入れ条件をユーザーの回答から整理し、重要な未決定事項を推測で埋めない。
3. 重要事項が固まったら要約を返し、画面で確認して「登録を承認」を明示的に選ぶよう案内する。修正したい場合は「会話を続ける」を選ぶ。承認は会話文や /go、/accept から推定しない。登録しても作業は開始しない。
4. 毎回 JSON オブジェクトだけを返す。message は会話文、summary は要約または null。未確定なら null。要約の形は {"objective":"目的","outOfScope":["範囲外"],"acceptanceCriteria":["受け入れ条件"]}。ユーザーがブランチを指定した場合だけ startBranch / integrationBranch を含める。cwd、ID、creationOrigin、署名・確認情報は含めない。
5. message 内の引用やコードは承認対象ではない。要約を修正する場合は summary に最新の全文を返す。
