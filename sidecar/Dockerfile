FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcups2 libasound2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY proxy.js ./

RUN mkdir -p /data

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
EXPOSE 3000

CMD ["node", "proxy.js"]