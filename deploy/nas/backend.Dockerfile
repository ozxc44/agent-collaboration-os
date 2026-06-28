FROM node:22-bookworm-slim

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci

COPY backend/ ./
COPY openapi-v2.yaml /app/openapi-v2.yaml
COPY cli/ /app/cli/

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "npm run migration:run && node dist/src/index.js"]

