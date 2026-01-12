# Build stage
FROM node:20-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

# Install Python and scikit-learn for BIRCH clustering
# Using py3-scikit-learn from Alpine packages for faster builds
RUN apk add --no-cache python3 py3-numpy py3-scikit-learn

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy migrations for release_command
COPY migrations/ ./migrations/

# Set environment
ENV NODE_ENV=production
# Set explicit heap size (leaving room for OS overhead in 512MB VM)
ENV NODE_OPTIONS="--max-old-space-size=384"

# Expose port
EXPOSE 3000

# Run the app
CMD ["node", "dist/index.js"]
