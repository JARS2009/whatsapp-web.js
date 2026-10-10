'use strict';

/**
 * Ciclo de vida de la sesión de WhatsApp (una sola cuenta).
 *
 * - Mantiene la sesión vinculada el mayor tiempo posible: la guarda en disco,
 *   se reconecta sola ante caídas y toma el control si hay conflicto.
 * - Controla la memoria: Chromium arranca con flags de bajo consumo y se
 *   reinicia (sin perder la sesión) cada cierto tiempo o si crece demasiado.
 * - Serializa los envíos en una cola para no saturar el navegador.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('..');
const { formatMessage } = require('./format');

const CLIENT_ID = 'main';

// Flags de Chromium orientados a gastar poca RAM/CPU en un servidor
const CHROME_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--in-process-gpu',
    '--no-zygote',
    '--renderer-process-limit=1',
    '--disable-site-isolation-trials',
    '--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion,BackForwardCache',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-breakpad',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--blink-settings=imagesEnabled=false',
    '--disk-cache-size=33554432',
];

// Puentes página → Node que la librería usa para mensajes entrantes, chats,
// llamadas, etc. Este servicio solo envía: se anulan para que WhatsApp Web no
// serialice ni mande a Node cada mensaje que llega. Se deja
// onAppStateChangedEvent, que es el que avisa de desconexiones.
const INCOMING_BRIDGES = [
    'onAddMessageEvent',
    'onAddMessageCiphertextEvent',
    'onCiphertextFailedEvent',
    'onChangeMessageEvent',
    'onChangeMessageTypeEvent',
    'onEditMessageEvent',
    'onRemoveMessageEvent',
    'onMessageAckEvent',
    'onMessageMediaUploadedEvent',
    'onChatUnreadCountEvent',
    'onArchiveChatEvent',
    'onRemoveChatEvent',
    'onPollVoteEvent',
    'onReaction',
    'onIncomingCall',
    'onBatteryStateChangedEvent',
];

// Estados de desconexión tras los que la sesión ya no sirve
const UNLINKED_REASONS = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE'];

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

function errorMessage(err) {
    // La librería a veces lanza strings
    return err?.message || String(err);
}

class WhatsAppService extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.client = null;
        this.status = 'stopped'; // stopped | starting | qr | code | syncing | ready | unlinked | error
        this.qrImage = null;
        this.pairingCode = null;
        this.pairingPhone = null;
        this.lastError = null;
        this.startedAt = Date.now();
        this.readySince = null;
        this.numberCache = new Map();
        this.queue = Promise.resolve();
        this.pending = 0;
        this.timers = [];
        this.restarting = false;
        this.newLink = false;

        this.metaFile = path.join(config.dataDir, 'meta.json');
        this.meta = this.loadMeta();
    }

    // ------------------------------------------------------------------
    // Metadatos persistentes (para el panel)
    // ------------------------------------------------------------------

    loadMeta() {
        try {
            return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
        } catch {
            return {
                linkedAt: null,
                number: null,
                name: null,
                connections: 0,
                restarts: 0,
                lastDisconnect: null,
                sent: { text: 0, pdf: 0, failed: 0 },
                lastSentAt: null,
            };
        }
    }

    saveMeta() {
        const tmp = this.metaFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2));
        fs.renameSync(tmp, this.metaFile);
    }

    sessionExists() {
        return fs.existsSync(
            path.join(this.config.dataDir, `session-${CLIENT_ID}`),
        );
    }

    /**
     * Chromium deja un candado con el hostname en el perfil. Tras recrear el
     * contenedor (otro hostname) o un apagado brusco se niega a abrirlo; como
     * aquí solo corre un navegador por carpeta, es seguro quitarlo.
     */
    clearProfileLock() {
        const dir = path.join(this.config.dataDir, `session-${CLIENT_ID}`);
        for (const name of [
            'SingletonLock',
            'SingletonSocket',
            'SingletonCookie',
        ]) {
            try {
                fs.rmSync(path.join(dir, name), { force: true });
            } catch {
                /* no existe */
            }
        }
    }

    sessionCreatedAt() {
        try {
            const dir = path.join(this.config.dataDir, `session-${CLIENT_ID}`);
            return Math.round(fs.statSync(dir).birthtimeMs) || null;
        } catch {
            return null;
        }
    }

    setStatus(status, patch = {}) {
        Object.assign(this, patch);
        this.status = status;
        this.emit('change');
    }

    snapshot() {
        return {
            status: this.status,
            qrImage: this.status === 'qr' ? this.qrImage : null,
            pairingCode: this.status === 'code' ? this.pairingCode : null,
            pairingPhone: this.pairingPhone,
            lastError: this.lastError,
            readySince: this.readySince,
            startedAt: this.startedAt,
            pending: this.pending,
            meta: this.meta,
        };
    }

    // ------------------------------------------------------------------
    // Arranque / parada
    // ------------------------------------------------------------------

    async start({ phoneNumber = null, attempt = 1 } = {}) {
        await this.stop();
        log(
            `[wa] iniciando (intento ${attempt})`,
            this.sessionExists() ? 'con sesión guardada' : 'sin sesión',
        );
        this.setStatus('starting', {
            qrImage: null,
            pairingCode: null,
            pairingPhone: phoneNumber,
            readySince: null,
        });

        this.clearProfileLock();

        const options = {
            authStrategy: new LocalAuth({
                clientId: CLIENT_ID,
                dataPath: this.config.dataDir,
            }),
            authTimeoutMs: 60000,
            // Sin QR infinito: tras unos minutos se pausa hasta pedirlo en el panel
            qrMaxRetries: 6,
            // Si la cuenta se abre en otro WhatsApp Web, esta sesión retoma el control
            takeoverOnConflict: true,
            takeoverTimeoutMs: 10000,
            // Evita cachear el HTML de WhatsApp Web en disco e interceptar peticiones
            webVersionCache: { type: 'none' },
            puppeteer: {
                // 'shell' = chrome-headless-shell: sin la interfaz del navegador, menos RAM
                headless: this.config.headlessMode,
                executablePath: this.config.chromePath || undefined,
                args: CHROME_ARGS,
            },
        };
        if (phoneNumber) {
            options.pairWithPhoneNumber = {
                phoneNumber,
                showNotification: true,
            };
        }

        const c = new Client(options);
        this.client = c;
        const on = (event, fn) =>
            c.on(event, (...args) => this.client === c && fn(...args));

        on('qr', async (qr) => {
            this.newLink = true;
            const qrImage = await QRCode.toDataURL(qr, {
                margin: 1,
                width: 300,
            });
            this.setStatus('qr', { qrImage });
        });
        on('code', (code) => {
            this.newLink = true;
            this.setStatus('code', { pairingCode: code });
        });
        on('authenticated', () => {
            log('[wa] autenticado');
            this.setStatus('syncing', { qrImage: null, pairingCode: null });
            this.armSyncWatchdog(c, phoneNumber, attempt);
        });
        on('auth_failure', (msg) => {
            log('[wa] fallo de autenticación:', msg);
            this.setStatus('error', {
                lastError: `Fallo de autenticación: ${msg}`,
            });
        });
        on('ready', () => this.onReady(c));
        on('disconnected', (reason) => this.onDisconnected(reason));

        c.initialize().catch((err) => {
            if (this.client !== c) return;
            const message = errorMessage(err);
            log(`[wa] error al iniciar (intento ${attempt}):`, message);
            this.lastError = message;
            if (attempt < 3) {
                this.start({ phoneNumber, attempt: attempt + 1 }).catch(
                    () => {},
                );
            } else {
                this.setStatus('error');
                this.scheduleReconnect();
            }
        });
    }

    async stop() {
        this.clearTimers();
        const c = this.client;
        this.client = null;
        if (c) await c.destroy().catch(() => {});
    }

    clearTimers() {
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
    }

    later(ms, fn) {
        const t = setTimeout(fn, ms);
        t.unref();
        this.timers.push(t);
        return t;
    }

    // WhatsApp Web a veces queda sincronizando sin emitir 'ready'
    armSyncWatchdog(c, phoneNumber, attempt) {
        this.later(90 * 1000, () => {
            if (this.client !== c || this.status === 'ready') return;
            log('[wa] sin "ready" tras autenticar, reiniciando');
            this.start({ phoneNumber, attempt: attempt + 1 }).catch(() => {});
        });
    }

    onReady(c) {
        const { wid, pushname } = c.info || {};
        log('[wa] listo como', wid?.user);
        const now = Date.now();
        if (this.newLink) {
            this.meta.linkedAt = now;
        } else if (!this.meta.linkedAt || this.meta.number !== wid?.user) {
            // Sesión previa sin registro: la fecha de la carpeta es la del vínculo
            this.meta.linkedAt = this.sessionCreatedAt() || now;
        }
        this.newLink = false;
        this.meta.number = wid?.user || null;
        this.meta.name = pushname || null;
        this.meta.connections++;
        this.saveMeta();
        this.setStatus('ready', { readySince: now, lastError: null });
        this.scheduleMaintenance();
        this.muteIncoming(c);
    }

    /** Modo solo envío: ignora todo lo que llega (mensajes, chats, llamadas) */
    async muteIncoming(c) {
        try {
            await c.pupPage.evaluate((names) => {
                for (const name of names) {
                    if (typeof window[name] === 'function')
                        window[name] = () => {};
                }
            }, INCOMING_BRIDGES);
        } catch (err) {
            log('[wa] no se pudo activar el modo solo envío:', err.message);
        }
    }

    onDisconnected(reason) {
        log('[wa] desconectado:', reason);
        this.meta.lastDisconnect = { reason: String(reason), at: Date.now() };
        this.saveMeta();
        this.client = null;
        this.clearTimers();

        if (UNLINKED_REASONS.includes(reason)) {
            // El teléfono quitó el dispositivo vinculado: hay que volver a escanear
            this.meta.linkedAt = null;
            this.saveMeta();
            this.removeSession();
            this.setStatus('unlinked', {
                readySince: null,
                lastError: 'El dispositivo fue desvinculado desde el teléfono',
            });
            return;
        }
        if (reason === 'Max qrcode retries reached') {
            this.setStatus('unlinked', {
                readySince: null,
                lastError: 'QR sin escanear. Genera uno nuevo desde el panel.',
            });
            return;
        }
        this.setStatus('error', {
            readySince: null,
            lastError: `Conexión perdida (${reason}), reconectando…`,
        });
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        this.later(15 * 1000, () => {
            if (this.client) return;
            this.start().catch((e) =>
                log('[wa] reconexión fallida', e.message),
            );
        });
    }

    removeSession() {
        fs.rmSync(path.join(this.config.dataDir, `session-${CLIENT_ID}`), {
            recursive: true,
            force: true,
        });
    }

    async logout() {
        const c = this.client;
        this.client = null;
        this.clearTimers();
        if (c && this.status === 'ready') {
            await c.logout().catch(() => c.destroy().catch(() => {}));
        } else if (c) {
            await c.destroy().catch(() => {});
        }
        this.removeSession();
        this.numberCache.clear();
        this.meta.linkedAt = null;
        this.saveMeta();
        this.setStatus('unlinked', { readySince: null, lastError: null });
    }

    // ------------------------------------------------------------------
    // Mantenimiento de memoria
    // ------------------------------------------------------------------

    scheduleMaintenance() {
        const { restartEveryHours, memoryCheckMinutes } = this.config;
        if (restartEveryHours > 0) {
            this.later(restartEveryHours * 3600 * 1000, () =>
                this.softRestart('mantenimiento programado'),
            );
        }
        const check = async () => {
            const mem = await this.memory();
            // Sin límite explícito: 85% del límite del contenedor
            const limit =
                this.config.memoryLimitMb ||
                (mem.containerLimitMb &&
                    Math.round(mem.containerLimitMb * 0.85));
            if (limit && mem.totalMb && mem.totalMb > limit) {
                await this.softRestart(
                    `memoria alta (${mem.totalMb} MB > ${limit} MB)`,
                );
                return;
            }
            this.later(memoryCheckMinutes * 60 * 1000, check);
        };
        this.later(memoryCheckMinutes * 60 * 1000, check);
    }

    /** Reinicia Chromium conservando la sesión, esperando a que no haya envíos */
    async softRestart(reason) {
        if (this.restarting || this.status !== 'ready') return;
        this.restarting = true;
        try {
            await this.queue.catch(() => {});
            log('[wa] reinicio suave:', reason);
            this.meta.restarts++;
            this.saveMeta();
            await this.start();
        } finally {
            this.restarting = false;
        }
    }

    /** Memoria usada: proceso Node + navegador (o el contenedor completo) */
    async memory() {
        const nodeMb = Math.round(process.memoryUsage().rss / 1048576);
        let browserHeapMb = null;
        try {
            const m = await this.client?.pupPage?.metrics();
            if (m) browserHeapMb = Math.round(m.JSHeapTotalSize / 1048576);
        } catch {
            /* página cerrándose */
        }
        const container = readCgroupMemory();
        return {
            nodeMb,
            browserHeapMb,
            containerMb: container?.usedMb ?? null,
            containerLimitMb: container?.limitMb ?? null,
            // Lo que se compara contra el límite configurado
            totalMb: container?.usedMb ?? nodeMb + (browserHeapMb || 0),
        };
    }

    // ------------------------------------------------------------------
    // Envíos
    // ------------------------------------------------------------------

    async waitReady(timeoutMs = 60000) {
        if (this.status === 'ready') return;
        if (['unlinked', 'qr', 'code'].includes(this.status)) {
            throw new HttpError(503, 'No hay un número vinculado');
        }
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off('change', onChange);
                reject(new HttpError(503, 'WhatsApp no está conectado'));
            }, timeoutMs);
            const onChange = () => {
                if (this.status !== 'ready') return;
                clearTimeout(timer);
                this.off('change', onChange);
                resolve();
            };
            this.on('change', onChange);
        });
    }

    /** Ejecuta envíos de uno en uno */
    enqueue(job) {
        this.pending++;
        this.emit('change');
        const run = this.queue.then(async () => {
            await this.waitReady();
            try {
                return await job(this.client);
            } finally {
                // Pausa entre envíos: ráfagas de mensajes elevan el riesgo de bloqueo
                const delay = this.config.sendDelayMs;
                if (delay > 0) await sleep(delay + Math.random() * delay * 0.5);
            }
        });
        this.queue = run.catch(() => {});
        return run.finally(() => {
            this.pending--;
            this.emit('change');
        });
    }

    async resolveChatId(client, to) {
        const raw = String(to || '').trim();
        if (/@(c\.us|lid|g\.us)$/.test(raw)) return raw;
        const number = raw.replace(/\D/g, '');
        if (number.length < 8 || number.length > 15) {
            throw new HttpError(
                400,
                'Número inválido: usa código de país + número (ej. 51961991613)',
            );
        }
        const cached = this.numberCache.get(number);
        if (cached) return cached;
        const wid = await client.getNumberId(number);
        if (!wid) throw new HttpError(404, `+${number} no tiene WhatsApp`);
        // Algunas versiones de WhatsApp renombraron `_serialized` a `$1`
        const id = wid._serialized || wid.$1 || `${wid.user}@${wid.server}`;
        if (this.numberCache.size > 1000) this.numberCache.clear();
        this.numberCache.set(number, id);
        return id;
    }

    /**
     * Envía texto (con formato) y/o un PDF.
     * @param {{to: string, text?: string, format?: 'whatsapp'|'html', pdf?: {data: Buffer, filename: string}}} msg
     */
    send({ to, text, format, pdf }) {
        let body;
        try {
            body = formatMessage(text, format || 'whatsapp');
        } catch (err) {
            return Promise.reject(new HttpError(400, err.message));
        }
        if (!body && !pdf) {
            return Promise.reject(new HttpError(400, 'Falta "text" o "pdf"'));
        }
        return this.enqueue(async (client) => {
            try {
                const chatId = await this.resolveChatId(client, to);
                let sent;
                if (pdf) {
                    const media = new MessageMedia(
                        'application/pdf',
                        pdf.data.toString('base64'),
                        pdf.filename,
                        pdf.data.length,
                    );
                    sent = await client.sendMessage(chatId, media, {
                        caption: body || undefined,
                        sendMediaAsDocument: true,
                    });
                    this.meta.sent.pdf++;
                } else {
                    sent = await client.sendMessage(chatId, body);
                    this.meta.sent.text++;
                }
                this.meta.lastSentAt = Date.now();
                this.saveMeta();
                return {
                    id: sent.id?._serialized || sent.id?.$1,
                    to: chatId,
                    timestamp: sent.timestamp,
                };
            } catch (err) {
                // Los errores de validación (número inválido, sin WhatsApp) no cuentan
                if (err instanceof HttpError) throw err;
                this.meta.sent.failed++;
                this.saveMeta();
                throw new HttpError(502, errorMessage(err));
            }
        });
    }

    async messageStatus(id) {
        await this.waitReady(5000);
        const msg = await this.client.getMessageById(id);
        if (!msg) throw new HttpError(404, 'Mensaje no encontrado');
        const ACK = {
            '-1': 'error',
            0: 'pending',
            1: 'sent',
            2: 'delivered',
            3: 'read',
            4: 'played',
        };
        return { id, ack: msg.ack, status: ACK[msg.ack] || 'unknown' };
    }
}

/** Memoria del contenedor (cgroup v2), igual que la calcula `docker stats` */
function readCgroupMemory() {
    try {
        const current = Number(
            fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'),
        );
        const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
        const stat = fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
        const inactive = Number(/^inactive_file (\d+)/m.exec(stat)?.[1] || 0);
        return {
            usedMb: Math.round((current - inactive) / 1048576),
            limitMb: max === 'max' ? null : Math.round(Number(max) / 1048576),
        };
    } catch {
        return null;
    }
}

module.exports = { WhatsAppService, HttpError, log };
