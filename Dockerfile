# Multi-stage build for SuperCode application

# Stage 1: Build stage
FROM node:20.11.0-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build the application
COPY . .
RUN npm run build

# Stage 2: Runtime stage
FROM node:20.11.0-alpine

# Set working directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production

# Create app directory structure
RUN mkdir -p /app/out /app/static /app/reports

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built artifacts from the builder stage
COPY --from=builder /app/out ./out
COPY --from=builder /app/static ./static

# Add application user
RUN addgroup -S supercode && adduser -S supercode -G supercode
RUN chown -R supercode:supercode /app
USER supercode

# Expose the application port
EXPOSE 3000

# Set healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').request({ host: 'localhost', port: 3000, path: '/health', timeout: 2000 }, (r) => { if (r.statusCode !== 200) process.exit(1) }).end()"

# Start the application
CMD ["node", "out/main.js"] 