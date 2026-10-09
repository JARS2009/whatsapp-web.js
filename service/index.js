'use strict';

/**
 * Servicio de WhatsApp para un solo número: API de envío (texto + PDF) y
 * panel interno. Configuración por variables de entorno (ver README.md).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WhatsAppService, log } = require('./whatsapp');
const { createApiServer } = require('./api');
const { createPanelServer } = require('./panel');

const env = process.env;
const config = {
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
    host: env.HOST || '127.0.0.1',
    apiPort: Number(env.API_PORT) || 3000,
    panelPort: Number(env.PANEL_PORT) || 3001,
    panelUser: env.PANEL_USER,
    panelPassword: env.PANEL_PASSWORD,
    chromePath: env.CHROME_PATH,
    headlessMode: env.CHROME_HEADLESS === 'shell' ? 'shell' : true,
    maxPdfBytes: (Number(env.MAX_PDF_MB) || 16) * 1048576,
    restartEveryHours: env.RESTART_EVERY_HOURS
        ? Number(env.RESTART_EVERY_HOURS)
        : 24,
    memoryLimitMb: Number(env.MEMORY_LIMIT_MB) || null,
    memoryCheckMinutes: Number(env.MEMORY_CHECK_MINUTES) || 5,
};

fs.mkdirSync(config.dataDir, { recursive: true });

/** Usa API_TOKEN o genera uno y lo guarda en el volumen de datos */
function loadToken() {
    if (env.API_TOKEN) return env.API_TOKEN;
    const file = path.join(config.dataDir, 'api-token');
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        const token = crypto.randomBytes(24).toString('base64url');
        fs.writeFileSync(file, token, { mode: 0o600 });
        log('[service] token de API generado en', file);
        return token;
    }
}

const token = loadToken();
const wa = new WhatsAppService(config);

const api = createApiServer(wa, { token, maxPdfBytes: config.maxPdfBytes });
const panel = createPanelServer(wa, {
    user: config.panelUser,
    password: config.panelPassword,
    token,
    maxPdfBytes: config.maxPdfBytes,
});

api.listen(config.apiPort, config.host, () =>
    log(`[service] API en http://${config.host}:${config.apiPort}`),
);
panel.listen(config.panelPort, config.host, () =>
    log(`[service] panel en http://${config.host}:${config.panelPort}`),
);

// Con sesión guardada se reconecta sola; sin ella espera a que se pida el QR
if (wa.sessionExists()) {
    wa.start().catch((err) => log('[service] no se pudo iniciar', err.message));
} else {
    wa.setStatus('unlinked');
    log('[service] sin sesión: abre el panel para vincular el número');
}

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log(`[service] ${signal}, cerrando…`);
    api.close();
    panel.close();
    await wa.stop();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) =>
    log('[service] promesa rechazada sin manejar:', err?.message || err),
);
