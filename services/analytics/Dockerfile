FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3003
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3   CMD wget -qO- http://127.0.0.1:3003/live || exit 1
CMD ["node", "src/index.js"]
