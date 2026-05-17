# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY vite.config.ts ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build the project
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create directories for data, exports, temp, and SSL
RUN mkdir -p data whatsapp-exports .temp ssl

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV WHATSAPP_EXPORTS_DIR=/app/whatsapp-exports
ENV TEMP_DIR=/app/.temp
ENV DB_PATH=/app/data/whatsapp.db
# SSL: mount cert/key to /app/ssl/ and set these env vars
# ENV SSL_CERT_PATH=/app/ssl/cert.pem
# ENV SSL_KEY_PATH=/app/ssl/key.pem

# Start the server with GC enabled for better memory management
CMD ["node", "--expose-gc", "dist/server/index.js"]