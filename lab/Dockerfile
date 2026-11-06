# Built from the repo root (compose: context ..), so the lab can use the
# agent toolkit (../agent) exactly as anyone installing mesa-agent would.
FROM node:22.14.0-slim
WORKDIR /src/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci
COPY agent/tsconfig.json ./
COPY agent/src ./src
RUN npm run build
WORKDIR /src/lab
COPY lab/package.json lab/package-lock.json ./
RUN npm ci
COPY lab/tsconfig.json ./
COPY lab/src ./src
COPY lab/seed.json lab/emoji.json ./
RUN npm run build && npm prune --omit=dev
CMD ["node", "dist/main.js"]
