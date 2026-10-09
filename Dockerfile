# Build stage
FROM apify/actor-node:22 AS builder
COPY package*.json ./
RUN npm ci --include=dev --audit=false --fund=false
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies only, for a small image and fast cold start
FROM apify/actor-node:22
COPY package*.json ./
RUN npm ci --omit=dev --audit=false --fund=false \
    && npm cache clean --force
COPY --from=builder /usr/src/app/dist ./dist
CMD ["node", "dist/main.js"]
