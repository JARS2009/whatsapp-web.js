'use strict';

/**
 * Clave de la API.
 *
 * - Si existe la variable API_TOKEN, se usa esa (no se puede regenerar).
 * - Si no, se genera una y se guarda en DATA_DIR/api-token.
 *
 * Uso por consola (dentro del contenedor):
 *   node service/token.js            muestra la clave actual
 *   node service/token.js --rotate   genera una nueva (la anterior deja de valer)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function generate() {
    return 'wa_' + crypto.randomBytes(32).toString('base64url');
}

class ApiKey {
    constructor(dataDir, envToken) {
        this.fromEnv = Boolean(envToken);
        this.file = path.join(dataDir, 'api-token');
        this.cached = envToken || null;
        this.mtime = 0;
        if (!this.fromEnv && !fs.existsSync(this.file)) this.write(generate());
    }

    write(token) {
        fs.writeFileSync(this.file, token, { mode: 0o600 });
    }

    /** Lee del disco solo si cambió (p. ej. tras `--rotate` por consola) */
    get value() {
        if (this.fromEnv) return this.cached;
        const { mtimeMs } = fs.statSync(this.file);
        if (mtimeMs !== this.mtime) {
            this.cached = fs.readFileSync(this.file, 'utf8').trim();
            this.mtime = mtimeMs;
        }
        return this.cached;
    }

    rotate() {
        if (this.fromEnv) {
            throw new Error(
                'La clave está fijada con API_TOKEN; cámbiala en el .env',
            );
        }
        this.write(generate());
        return this.value;
    }
}

module.exports = { ApiKey };

if (require.main === module) {
    const dataDir = path.resolve(
        process.env.DATA_DIR || path.join(__dirname, 'data'),
    );
    fs.mkdirSync(dataDir, { recursive: true });
    const key = new ApiKey(dataDir, process.env.API_TOKEN);
    if (process.argv.includes('--rotate')) {
        console.log(key.rotate());
        console.error(
            'Clave nueva generada. Actualiza WHATSAPP_TOKEN en Laravel.',
        );
    } else {
        console.log(key.value);
    }
}
