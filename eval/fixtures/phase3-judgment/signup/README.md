# 会員登録 / Member registration

Web アプリの会員登録は次の3つの要件に従います。

1. メールアドレスの前後の空白を除き、小文字に正規化して会員を保存します。
2. 登録済みのメールアドレスでは会員を追加せず、重複登録のエラーを返します。
3. 登録確認メールの送信に失敗したら登録を取り消し、同じメールアドレスで再登録できるようにします。

The web application's member registration follows three requirements:

1. Trim surrounding whitespace and normalize the email address to lowercase before saving a member.
2. Reject an already registered email address with a duplicate registration error without adding another member.
3. If sending the registration confirmation email fails, cancel the registration so the same email address can be registered again.

`registerMember` は会員ストアと確認メール送信関数を受け取ります。会員ストアはメールアドレスをキーにした Map です。
`registerMember` receives a member store and a confirmation email sender. The member store is a Map keyed by email address.

`node --test` で登録処理のテストを実行できます。
Run `node --test` to test member registration.
