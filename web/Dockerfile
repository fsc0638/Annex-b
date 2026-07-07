# Phase 0 scope: dev-mode Next.js server. A production multi-stage build
# (standalone output, distroless runtime) is deferred to a later phase
# once the app has real pages worth optimizing — for now this favors
# simplicity and fast iteration on the Mac Mini deployment target.

FROM node:20-slim AS base

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["pnpm", "dev"]
