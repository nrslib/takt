# タスク計画
要件: タスク指示書と CONTRACT.md の受付処理を実装する。
実装: 署名検証、paid / refunded の受付、再送時の二重処理抑止。
検証: node --test と本番 webhook の受信確認。
本番確認を加えた根拠: CONTRACT.md:4「署名付きの paid と refunded を既存の receive 経路へ渡し、受付結果を返す。」および environment.md:4「決済事業者の本番管理画面から署名付きイベントを送信し、同じイベントを再送すると、受信記録で受付結果と二重処理の有無を観測できる。」
