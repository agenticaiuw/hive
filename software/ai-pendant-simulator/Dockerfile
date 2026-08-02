# Optional generic container image for local/self-hosted relay testing.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Prefer install over ci so Cloud Build npm can resolve optional transitive bumps.
RUN npm install --omit=dev

COPY cloud-relay ./cloud-relay

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "cloud-relay/server.js"]
