FROM node:20-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Install deps first so we can cache the layer.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Then copy the rest of the source.
COPY . .

# Persistent data dir (mount a volume here in compose).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Run as the built-in non-root user for safety.
USER node

CMD ["node", "server.js"]
