FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3002
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3   CMD wget -qO- http://127.0.0.1:3002/live || exit 1
CMD ["node", "src/index.js"]
