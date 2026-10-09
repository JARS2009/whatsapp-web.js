'use strict';

/**
 * API para que tus sistemas envíen mensajes. Requiere el token en
 * `Authorization: Bearer <API_TOKEN>`.
 *
 *   POST /v1/messages        { to, text }                          → texto
 *                            { to, text?, pdf: { base64, filename } } → PDF
 *                            { to, text?, pdf: { url, filename } }    → PDF por URL
 *   GET  /v1/messages/:id    estado de entrega (sent/delivered/read)
 *   GET  /v1/status          estado de la sesión
 *   GET  /health             sin token, para el healthcheck del contenedor
 */

const http = require('http');
const { HttpError, log } = require('./whatsapp');
const { sendJson, readJson, safeEqual, handle } = require('./http');

function createApiServer(wa, { token, maxPdfBytes }) {
    // base64 ocupa ~4/3 del archivo, más margen para el resto del JSON
    const maxBody = Math.ceil(maxPdfBytes * 1.4) + 64 * 1024;

    function authorize(req) {
        const header = req.headers.authorization || '';
        const given = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!given || !safeEqual(given, token)) {
            throw new HttpError(401, 'Token inválido');
        }
    }

    async function loadPdf(pdf) {
        if (!pdf) return null;
        let data;
        if (pdf.base64) {
            data = Buffer.from(String(pdf.base64), 'base64');
        } else if (pdf.url) {
            data = await downloadPdf(String(pdf.url), maxPdfBytes);
        } else {
            throw new HttpError(400, 'pdf necesita "base64" o "url"');
        }
        if (data.length > maxPdfBytes) {
            throw new HttpError(
                413,
                `El PDF supera ${maxPdfBytes / 1048576} MB`,
            );
        }
        if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
            throw new HttpError(400, 'El archivo no es un PDF válido');
        }
        return { data, filename: pdfFilename(pdf.filename) };
    }

    return http.createServer(
        handle(async (req, res) => {
            const url = new URL(req.url, 'http://localhost');

            if (req.method === 'GET' && url.pathname === '/health') {
                return sendJson(res, 200, { ok: true, status: wa.status });
            }

            authorize(req);

            if (req.method === 'POST' && url.pathname === '/v1/messages') {
                const body = await readJson(req, maxBody);
                if (!body.to) throw new HttpError(400, 'Falta "to"');
                const pdf = await loadPdf(body.pdf);
                const result = await wa.send({
                    to: body.to,
                    text: body.text,
                    pdf,
                });
                return sendJson(res, 201, result);
            }

            const msgMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)$/);
            if (req.method === 'GET' && msgMatch) {
                return sendJson(
                    res,
                    200,
                    await wa.messageStatus(decodeURIComponent(msgMatch[1])),
                );
            }

            if (req.method === 'GET' && url.pathname === '/v1/status') {
                return sendJson(res, 200, {
                    status: wa.status,
                    number: wa.meta.number,
                    readySince: wa.readySince,
                    pending: wa.pending,
                });
            }

            throw new HttpError(404, 'No encontrado');
        }, log),
    );
}

function pdfFilename(name) {
    const clean = String(name || 'documento')
        .replace(/[\\/:*?"<>|\r\n]+/g, '_')
        .slice(0, 120)
        .trim();
    return /\.pdf$/i.test(clean) ? clean : `${clean || 'documento'}.pdf`;
}

async function downloadPdf(url, maxBytes) {
    if (!/^https?:\/\//i.test(url)) {
        throw new HttpError(400, 'pdf.url debe ser http(s)');
    }
    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
        throw new HttpError(502, `No se pudo descargar el PDF: ${err.message}`);
    }
    if (!res.ok) {
        throw new HttpError(
            502,
            `No se pudo descargar el PDF (HTTP ${res.status})`,
        );
    }
    if (Number(res.headers.get('content-length') || 0) > maxBytes) {
        throw new HttpError(413, 'El PDF es demasiado grande');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes)
            throw new HttpError(413, 'El PDF es demasiado grande');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

module.exports = { createApiServer };
