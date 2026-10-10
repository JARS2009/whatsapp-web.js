'use strict';

/**
 * Panel interno: vincular el número, ver el estado de la sesión, la memoria
 * y probar envíos. Debe quedar accesible solo desde el propio servidor
 * (en docker-compose se publica en 127.0.0.1) y se entra por túnel SSH.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { HttpError, log } = require('./whatsapp');
const { sendJson, readJson, safeEqual, handle } = require('./http');

const PANEL_HTML = path.join(__dirname, 'panel.html');

function createPanelServer(wa, { user, password, apiKey, maxPdfBytes }) {
    const clients = new Set();

    async function info() {
        return {
            ...wa.snapshot(),
            memory: await wa.memory(),
            uptimeSec: Math.round(process.uptime()),
            config: {
                restartEveryHours: wa.config.restartEveryHours,
                apiPort: wa.config.apiPort,
                maxPdfMb: Math.round(maxPdfBytes / 1048576),
            },
            token: apiKey.value,
            tokenFromEnv: apiKey.fromEnv,
        };
    }

    let pushTimer = null;
    function push() {
        if (pushTimer || !clients.size) return;
        pushTimer = setTimeout(async () => {
            pushTimer = null;
            const data = `data: ${JSON.stringify(await info())}\n\n`;
            for (const res of clients) res.write(data);
        }, 250);
    }
    wa.on('change', push);
    setInterval(push, 15000).unref();

    function authorize(req) {
        if (!user || !password) return true;
        const [scheme, encoded] = (req.headers.authorization || '').split(' ');
        if (scheme !== 'Basic' || !encoded) return false;
        const decoded = Buffer.from(encoded, 'base64').toString();
        const i = decoded.indexOf(':');
        return (
            safeEqual(decoded.slice(0, i), user) &&
            safeEqual(decoded.slice(i + 1), password)
        );
    }

    return http.createServer(
        handle(async (req, res) => {
            if (!authorize(req)) {
                res.writeHead(401, {
                    'WWW-Authenticate': 'Basic realm="WhatsApp"',
                });
                return res.end();
            }
            const url = new URL(req.url, 'http://localhost');
            const route = `${req.method} ${url.pathname}`;

            switch (route) {
                case 'GET /':
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store',
                    });
                    return fs.createReadStream(PANEL_HTML).pipe(res);

                case 'GET /events':
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-store',
                        Connection: 'keep-alive',
                    });
                    res.write(`data: ${JSON.stringify(await info())}\n\n`);
                    clients.add(res);
                    req.on('close', () => clients.delete(res));
                    return;

                case 'POST /link/qr':
                    if (wa.status === 'ready') {
                        throw new HttpError(409, 'Ya hay un número vinculado');
                    }
                    await wa.start();
                    return sendJson(res, 200, { ok: true });

                case 'POST /link/phone': {
                    const { phone } = await readJson(req, 4096);
                    const phoneNumber = String(phone || '').replace(/\D/g, '');
                    if (phoneNumber.length < 8 || phoneNumber.length > 15) {
                        throw new HttpError(400, 'Número inválido');
                    }
                    if (wa.status === 'ready') {
                        throw new HttpError(409, 'Ya hay un número vinculado');
                    }
                    await wa.start({ phoneNumber });
                    return sendJson(res, 200, { ok: true });
                }

                case 'POST /restart':
                    if (wa.status === 'ready') {
                        await wa.softRestart('manual desde el panel');
                    } else {
                        await wa.start();
                    }
                    return sendJson(res, 200, { ok: true });

                case 'POST /token/rotate':
                    try {
                        apiKey.rotate();
                    } catch (err) {
                        throw new HttpError(409, err.message);
                    }
                    log('[panel] clave de API regenerada');
                    push();
                    return sendJson(res, 200, { ok: true });

                case 'POST /logout':
                    await wa.logout();
                    log('[panel] sesión cerrada desde el panel');
                    return sendJson(res, 200, { ok: true });

                case 'POST /test': {
                    const body = await readJson(
                        req,
                        Math.ceil(maxPdfBytes * 1.4) + 64 * 1024,
                    );
                    let pdf = null;
                    if (body.pdfBase64) {
                        const data = Buffer.from(body.pdfBase64, 'base64');
                        if (
                            data.subarray(0, 5).toString('latin1') !== '%PDF-'
                        ) {
                            throw new HttpError(400, 'El archivo no es un PDF');
                        }
                        pdf = {
                            data,
                            filename: body.filename || 'documento.pdf',
                        };
                    }
                    return sendJson(
                        res,
                        200,
                        await wa.send({
                            to: body.to,
                            text: body.text,
                            format: body.format,
                            pdf,
                        }),
                    );
                }

                default:
                    throw new HttpError(404, 'No encontrado');
            }
        }, log),
    );
}

module.exports = { createPanelServer };
