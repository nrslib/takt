# Requirements / 要求

Only a human message turn may add a manager. The repository argument must be an absolute path to an existing Git repository. A human may specify the repository in an earlier message and confirm the addition in a later message. Do not expose the stored API key to callers without authentication.

manager追加は人のmessage turnだけで許可する。repository引数は既存Gitリポジトリへの絶対パスとする。人は先の発言で対象を指定し、後の発言で追加を確認できる。未認証の呼び出し元に保存済みAPIキーを公開しない。

An earlier human decision rejected requiring the current message to contain the repository path literally. The reason was that it would reject the documented two-message flow and had no separate requirement basis. The decision applies to human message turns that still validate the absolute Git path. It did not waive the human-turn gate or API-key confidentiality.

以前、人は「現在の発言本文にrepositoryパスを文字どおり含める」保証を採らないと決めた。二つの発言に分ける正常な利用を拒否し、別の要求上の根拠もないためである。この判断は絶対パスとGitの検証を維持する人のmessage turnに適用する。人のturn制約とAPIキーの秘匿は免除していない。
