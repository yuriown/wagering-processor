# Bun executa o TypeScript direto: nao ha etapa de build, so dependencias de producao.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD ["bun", "-e", "fetch('http://localhost:3000/health/ready').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/main.ts"]
