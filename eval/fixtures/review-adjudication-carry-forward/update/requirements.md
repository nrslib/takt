# Manager registration

After H-42 was recorded, the person explicitly changed the manager-registration requirement. The current same-message condition replaces the previously permitted two-message confirmation.

The person must include the absolute repository path in the same message that authorizes manager registration. The director must not register a manager if the current authorizing message omits the path, even when it appeared in an earlier message. Registration is initiated only from a human message turn. The repository argument must be an absolute path to an existing Git repository.

H-42の記録後、人がmanager登録の要件を明示的に変更した。現在の同一発言条件は、以前認められていた二発言による確認に代わる。

人はmanager登録を認可する同じ発言にrepositoryの絶対パスを含めなければならない。以前の発言にパスがあっても、現在の認可発言にパスがなければ登録してはならない。登録は人のmessage turnからだけ開始する。repository引数は既存のGitリポジトリへの絶対パスとする。
