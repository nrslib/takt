# Requirements / 要求

Only a human message turn may add a manager. The repository argument must be an absolute path to an existing Git repository. An earlier human decision rejected requiring the current message to contain the path literally because this would block valid confirmation of a path supplied in an earlier message. The decision covered human message turns after the human-turn gate, not watcher events.

manager追加は人のmessage turnだけで許可する。repository引数は既存Gitリポジトリへの絶対パスとする。以前、人は現在の発言にパスを文字どおり含める制約を退けた。先の発言で指定した対象を後で確認する正常な利用を妨げるためである。この判断は人のturn制約を通った後に適用され、watcherイベントは対象にしていない。
