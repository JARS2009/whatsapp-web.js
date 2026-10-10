const { expect } = require('chai');
const { formatMessage, MAX_LENGTH } = require('../../service/format');

const U = '\u0332';

describe('formatMessage', function () {
    describe('format "whatsapp"', function () {
        it('envía la sintaxis nativa y los emojis tal cual', function () {
            const text = '*Hola* _Juan_ ~$100~ ```code``` 🎉✅';
            expect(formatMessage(text)).to.equal(text);
        });

        it('normaliza saltos de línea de Windows y recorta los bordes', function () {
            expect(formatMessage('  Línea 1\r\nLínea 2\r\n')).to.equal(
                'Línea 1\nLínea 2',
            );
        });

        it('rechaza un formato desconocido', function () {
            expect(() => formatMessage('x', 'markdown')).to.throw(RangeError);
        });

        it('rechaza mensajes demasiado largos', function () {
            expect(() => formatMessage('a'.repeat(MAX_LENGTH + 1))).to.throw(
                RangeError,
            );
        });
    });

    describe('format "html"', function () {
        const html = (t) => formatMessage(t, 'html');

        it('convierte negrita, cursiva, tachado y código', function () {
            expect(
                html(
                    '<b>uno</b> <strong>dos</strong> <i>tres</i> <em>cuatro</em> <s>cinco</s> <code>seis</code>',
                ),
            ).to.equal('*uno* *dos* _tres_ _cuatro_ ~cinco~ `seis`');
        });

        it('saca los espacios fuera de los marcadores', function () {
            expect(html('Total:<b> S/ 100 </b>hoy')).to.equal(
                'Total: *S/ 100* hoy',
            );
        });

        it('anida estilos', function () {
            expect(html('<b><i>importante</i></b>')).to.equal('*_importante_*');
        });

        it('simula el subrayado con U+0332 sin tocar espacios ni emojis', function () {
            expect(html('<u>Hola 1</u> 🎉')).to.equal(
                `H${U}o${U}l${U}a${U} 1${U} 🎉`,
            );
        });

        it('convierte párrafos, saltos de línea y listas', function () {
            const out = html(
                '<p>Hola <b>Ana</b>,</p><p>Tu pedido:</p><ul><li>Item 1</li><li>Item 2</li></ul><ol><li>A</li><li>B</li></ol>Línea<br>siguiente',
            );
            expect(out).to.equal(
                'Hola *Ana*,\n\nTu pedido:\n\n- Item 1\n- Item 2\n\n1. A\n2. B\n\nLínea\nsiguiente',
            );
        });

        it('sangra las listas anidadas con espacios duros', function () {
            const N = '\u00a0'.repeat(4);
            expect(
                html(
                    '<ul><li>Bebidas<ul><li>Agua</li><li>Jugo<ol><li>Naranja</li></ol></li></ul></li><li>Postre</li></ul>',
                ),
            ).to.equal(
                `- Bebidas\n${N}- Agua\n${N}- Jugo\n${N}${N}1. Naranja\n- Postre`,
            );
        });

        it('convierte citas y bloques de código respetando la sangría', function () {
            expect(html('<blockquote>Nota\nimportante</blockquote>')).to.equal(
                '> Nota importante',
            );
            expect(html('<pre>if (x) {\n    y();\n}</pre>')).to.equal(
                '```if (x) {\n    y();\n}```',
            );
        });

        it('convierte enlaces y descarta etiquetas desconocidas', function () {
            expect(
                html(
                    '<a href="https://x.com">Ver</a> <span class="a">texto</span><script>x</script>',
                ),
            ).to.equal('Ver (https://x.com) textox');
        });

        it('decodifica entidades y emojis numéricos', function () {
            expect(
                html('Tom &amp; Jerry &lt;3 &#127881; &#x2705;&nbsp;listo'),
            ).to.equal('Tom & Jerry <3 🎉 ✅ listo');
        });

        it('trata los saltos de línea del HTML como espacios', function () {
            expect(html('Hola\n   mundo')).to.equal('Hola mundo');
        });
    });
});
