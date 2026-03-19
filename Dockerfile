# --- Build stage ---
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Runtime stage ---
FROM node:20-slim

# Install kubectl for agent to exec into etcd pods
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/package.json .

# Copy group folders (CLAUDE.md runbooks)
COPY groups/ groups/

# Run as non-root — Node.js and kubectl don't need root.
# kubectl uses the SA token from the filesystem, not a privileged socket.
RUN adduser --system --no-create-home nanoclaw && \
    mkdir -p /app/store /app/data && \
    chown -R nanoclaw /app/store /app/data /app/groups
USER nanoclaw

# No KUBECONFIG — in-cluster, kubectl uses the ServiceAccount token
# at /var/run/secrets/kubernetes.io/serviceaccount/ automatically.
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
