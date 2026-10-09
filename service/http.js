'use strict';

const crypto = require('crypto');
const { HttpError } = require('./whatsapp');

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store',
    });
    res.end(data);
}

function readJson(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > maxBytes) {
            req.resume();
            return reject(new HttpError(413, 'Cuerpo demasiado grande'));
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new HttpError(413, 'Cuerpo demasiado grande'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(new HttpError(400, 'JSON inválido'));
            }
        });
        req.on('error', reject);
    });
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Envuelve un handler async y traduce errores a respuestas JSON */
function handle(fn, log) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            const message = err?.message || String(err);
            if (status >= 500) log('[http]', req.method, req.url, message);
            if (res.headersSent) return res.end();
            sendJson(res, status, { error: message });
        }
    };
}

module.exports = { sendJson, readJson, safeEqual, handle };
