'use strict';

/**
 * Formato de mensajes.
 *
 * - format "whatsapp" (default): el texto se envía tal cual, con la sintaxis
 *   nativa de WhatsApp: *negrita*, _cursiva_, ~tachado~, ```mono```, `código`,
 *   "> cita", "- lista", "1. lista". Los emojis van como caracteres UTF-8.
 * - format "html": se convierten etiquetas HTML simples a esa sintaxis.
 *   <b> <strong> <i> <em> <s> <del> <u> <code> <pre> <br> <p> <div>
 *   <ul>/<ol>/<li> <blockquote> <a href>. El resto de etiquetas se descarta.
 *
 * WhatsApp no tiene subrayado: <u> se simula con U+0332 (subrayado
 * combinado) debajo de cada letra o número.
 */

const MAX_LENGTH = 65536;
// Escapes explícitos: son caracteres invisibles o combinados
const UNDERLINE = '\u0332';
const INDENT = '\u00a0'.repeat(4);

const INLINE = {
    b: '*',
    strong: '*',
    i: '_',
    em: '_',
    s: '~',
    del: '~',
    strike: '~',
    code: '`',
};
const BLOCK = new Set([
    'p',
    'div',
    'ul',
    'ol',
    'blockquote',
    'pre',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
]);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

function decodeEntities(text) {
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
    };
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
        if (code[0] === '#') {
            const n =
                code[1].toLowerCase() === 'x'
                    ? parseInt(code.slice(2), 16)
                    : parseInt(code.slice(1), 10);
            return Number.isFinite(n) && n <= 0x10ffff
                ? String.fromCodePoint(n)
                : m;
        }
        return named[code.toLowerCase()] ?? m;
    });
}

/** Árbol mínimo: { tag, attrs, children } o string */
function parseHtml(html) {
    const root = { tag: '#root', children: [] };
    const stack = [root];
    const re = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->/gi;
    let last = 0;
    let m;
    while ((m = re.exec(html))) {
        if (m.index > last)
            stack
                .at(-1)
                .children.push(decodeEntities(html.slice(last, m.index)));
        last = re.lastIndex;
        if (!m[2]) continue; // comentario
        const tag = m[2].toLowerCase();
        if (m[1]) {
            // Cierra hasta la etiqueta correspondiente (tolera HTML mal anidado)
            const i = stack.findLastIndex((n) => n.tag === tag);
            if (i > 0) stack.length = i;
            continue;
        }
        const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[3]);
        const node = {
            tag,
            href: href ? decodeEntities(href[2] ?? href[3]) : null,
            children: [],
        };
        stack.at(-1).children.push(node);
        if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node);
    }
    if (last < html.length)
        stack.at(-1).children.push(decodeEntities(html.slice(last)));
    return root;
}

/** Envuelve con un marcador sacando los espacios de los bordes (*hola* y no * hola *) */
function wrap(text, marker) {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!match[2]) return text;
    return match[1] + marker + match[2] + marker + match[3];
}

function underline(text) {
    return text.replace(/[\p{L}\p{N}]/gu, (c) => c + UNDERLINE);
}

function render(node, ctx = { list: null }) {
    if (typeof node === 'string') {
        // Dentro de <pre> se respeta el texto; fuera, los saltos de línea del HTML son espacios
        return ctx.pre ? node : node.replace(/\s+/g, ' ');
    }
    const { tag } = node;
    const inner = (extra = {}) =>
        node.children.map((c) => render(c, { ...ctx, ...extra })).join('');

    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n';
    if (INLINE[tag]) return wrap(inner(), INLINE[tag]);
    if (tag === 'u' || tag === 'ins') return underline(inner());
    if (tag === 'pre')
        return (
            '\n\n```' +
            inner({ pre: true }).replace(/^\n+|\n+$/g, '') +
            '```\n\n'
        );
    if (tag === 'a') {
        const text = inner().trim();
        if (!node.href || node.href === text) return text || node.href || '';
        return text ? `${text} (${node.href})` : node.href;
    }
    if (tag === 'ul' || tag === 'ol') {
        // WhatsApp no anida listas: los subniveles se sangran con espacios
        // duros (U+00A0), que no se recortan al limpiar las líneas
        const depth = ctx.depth || 0;
        const indent = INDENT.repeat(depth);
        let n = 0;
        const items = node.children
            .filter((c) => typeof c !== 'string' || c.trim())
            .map((c) => {
                const body = render(c, { ...ctx, depth: depth + 1 })
                    .trim()
                    .replace(/\n{2,}/g, '\n');
                if (!body) return null;
                n++;
                return indent + (tag === 'ol' ? `${n}. ` : '- ') + body;
            })
            .filter(Boolean);
        if (depth > 0) return '\n' + items.join('\n') + '\n';
        return '\n\n' + items.join('\n') + '\n\n';
    }
    if (tag === 'blockquote') {
        const body = inner().trim();
        return (
            '\n\n' +
            body
                .split('\n')
                .map((l) => '> ' + l.trim())
                .join('\n') +
            '\n\n'
        );
    }
    if (/^h[1-6]$/.test(tag))
        return '\n\n' + wrap(inner().trim(), '*') + '\n\n';
    if (BLOCK.has(tag)) return '\n\n' + inner().trim() + '\n\n';
    return inner();
}

function htmlToWhatsApp(html) {
    // Limpia espacios al inicio/fin de cada línea, salvo dentro de ``` (sangría de código)
    let inFence = false;
    return render(parseHtml(html))
        .split('\n')
        .map((line) => {
            const fences = (line.match(/```/g) || []).length;
            // Solo espacios normales: los U+00A0 de las sublistas se conservan
            const out = inFence ? line : line.replace(/^[ \t]+|[ \t]+$/g, '');
            if (fences % 2) inFence = !inFence;
            return out;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Devuelve el texto listo para WhatsApp.
 * @param {string} text
 * @param {'whatsapp'|'html'} [format]
 */
function formatMessage(text, format = 'whatsapp') {
    if (text == null) return '';
    if (typeof text !== 'string') throw new TypeError('"text" debe ser texto');
    const normalized = text.replace(/\r\n?/g, '\n');
    let out;
    if (format === 'html') out = htmlToWhatsApp(normalized);
    else if (format === 'whatsapp') out = normalized.trim();
    else throw new RangeError('"format" debe ser "whatsapp" o "html"');
    if (out.length > MAX_LENGTH) {
        throw new RangeError(`El mensaje supera ${MAX_LENGTH} caracteres`);
    }
    return out;
}

module.exports = { formatMessage, htmlToWhatsApp, underline, MAX_LENGTH };
