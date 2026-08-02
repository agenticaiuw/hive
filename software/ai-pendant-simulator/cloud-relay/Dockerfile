FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY cloud-relay ./cloud-relay

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "cloud-relay/server.js"]
