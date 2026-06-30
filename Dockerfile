# Stage 1: build
FROM docker.io/oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Stage 2: run
FROM docker.io/oven/bun:1-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# Mount your config.yaml here, or override CONFIG_PATH at runtime
ENV CONFIG_PATH=/config/config.yaml

# HuggingFace downloads shell out to the `hf` CLI accelerated by hf-transfer.
RUN apt-get update && apt-get install -y curl python3 python3-venv && \
    curl -LsSf https://hf.co/cli/install.sh | bash - && \
    python3 -m venv /venv && \
    /venv/bin/pip install hf-transfer && \
    rm -rf /var/lib/apt/lists/*

ENV PATH="/venv/bin:/root/.local/bin:$PATH"
ENV HF_HUB_ENABLE_HF_TRANSFER=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["bun", "server.js"]
