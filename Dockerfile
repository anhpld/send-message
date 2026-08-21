# syntax=docker/dockerfile:1

# Keep this version in sync with the installed playwright package.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY src ./src

EXPOSE 3000

CMD ["node", "src/api.js"]

