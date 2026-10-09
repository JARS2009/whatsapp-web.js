# Servicio de WhatsApp (API texto + PDF y panel interno) de bajo consumo.
FROM node:22-bookworm-slim

# chromium-headless-shell de Debian: sin la interfaz del navegador (~100 MB
# menos de RAM que chromium completo), con parches de seguridad vía apt y
# builds para amd64/arm64
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium-headless-shell ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium-headless-shell \
    CHROME_HEADLESS=shell \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    API_PORT=3000 \
    PANEL_PORT=3001 \
    NODE_OPTIONS=--max-old-space-size=192

WORKDIR /app

# Dependencias primero para aprovechar la caché de capas
COPY package.json ./
RUN npm install --omit=dev --omit=optional --ignore-scripts --no-package-lock \
        --no-audit --no-fund \
    && npm cache clean --force
COPY service/package.json service/
RUN cd service \
    && npm install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund \
    && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY service ./service

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000 3001

HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "service/index.js"]
