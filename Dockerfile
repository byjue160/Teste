FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["node", "server.js"]
