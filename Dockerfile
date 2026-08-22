# TAKT - Docker環境
# 他の環境でビルド・テストが動作するかを確認するため

FROM node:24-alpine

WORKDIR /app

# 依存関係のインストール（キャッシュ活用のため先にコピー）
COPY package.json package-lock.json ./
RUN npm ci

# ソースコードをコピー
COPY . .

# ビルド
RUN npm run build

# テスト実行
CMD ["npm", "run", "test"]
