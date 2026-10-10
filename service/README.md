# Servicio de envío de WhatsApp

Servicio **solo de envío** (texto con formato y PDFs) desde **un número**, pensado
para un VPS con 1 GB de RAM. Tu proyecto Laravel le manda los mensajes por una API
con clave, y un panel interno sirve para vincular el número y vigilar la sesión.

No lee ni procesa los mensajes que llegan al número: el servicio ignora los
mensajes entrantes, los chats y las llamadas.

---

## 1. Instalar en el VPS

Requisitos: Docker con el plugin compose (`docker compose version`).

```bash
git clone https://github.com/JARS2009/whatsapp-web.js.git whatsapp
cd whatsapp
docker compose up -d --build
```

La primera vez tarda unos minutos (descarga Chromium). Comprueba que arrancó:

```bash
docker compose ps          # debe decir "healthy"
docker compose logs -f     # Ctrl+C para salir
```

## 2. Vincular el número (panel interno)

El panel **no se publica a internet**: escucha solo en `127.0.0.1:3001` del VPS.
Desde tu PC abre un túnel SSH y déjalo abierto:

```bash
ssh -N -L 3001:127.0.0.1:3001 usuario@IP-DE-TU-VPS
```

Entra a <http://localhost:3001>, pulsa **Generar QR** y escanéalo desde
_WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo_.

> Usa la sesión en **un solo lugar a la vez**: detén cualquier otra copia del
> servicio (por ejemplo, la de tu PC) antes de vincular en el VPS.

## 3. Clave de la API

Se genera sola al primer arranque (`wa_…`, 46 caracteres). Para verla:

- en el panel, sección **Clave de la API** (Mostrar / Copiar / Regenerar), o
- por consola en el VPS:

```bash
docker compose exec whatsapp node service/token.js            # ver
docker compose exec whatsapp node service/token.js --rotate   # generar otra
```

Si prefieres fijarla tú, créala y ponla en un `.env` junto a `docker-compose.yml`:

```bash
echo "API_TOKEN=wa_$(openssl rand -hex 32)" >> .env
docker compose up -d
```

(Con `API_TOKEN` en el `.env`, el botón Regenerar se desactiva.)

## 4. Conectar Laravel

### 4.1 `.env` de Laravel

**Laravel en el mismo VPS** (instalado directo, sin Docker):

```dotenv
WHATSAPP_URL=http://127.0.0.1:3000
WHATSAPP_TOKEN=wa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Laravel en Docker en el mismo VPS**: une su contenedor a la red
`whatsapp_default` y usa `WHATSAPP_URL=http://whatsapp:3000`.

**Laravel en otro servidor**: activa el proxy HTTPS (sección 5) y usa
`WHATSAPP_URL=https://wa.tudominio.com`.

### 4.2 `config/services.php`

```php
'whatsapp' => [
    'url' => env('WHATSAPP_URL', 'http://127.0.0.1:3000'),
    'token' => env('WHATSAPP_TOKEN'),
    'timeout' => env('WHATSAPP_TIMEOUT', 90),
],
```

### 4.3 Copia los ejemplos

De [`service/examples/laravel`](examples/laravel) a tu proyecto:

| Archivo                                     | Qué es                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| `app/Services/WhatsApp.php`                 | Cliente: `sendText`, `sendPdf`, `sendPdfFromUrl`, estado |
| `app/Jobs/SendWhatsAppMessage.php`          | Envío en cola con reintentos                             |
| `resources/views/whatsapp/pedido.blade.php` | Plantilla de ejemplo en HTML                             |

Uso:

```php
use App\Jobs\SendWhatsAppMessage;
use App\Services\WhatsApp;

// Directo (espera la respuesta)
app(WhatsApp::class)->sendText('51961991613', 'Hola *Ana* 👋');

// En cola (recomendado): no bloquea la petición y reintenta si el servicio reconecta
SendWhatsAppMessage::dispatch('51961991613', 'Tu pedido está _listo_ ✅');

// Con plantilla Blade en HTML
$html = view('whatsapp.pedido', compact('cliente', 'pedido'))->render();
SendWhatsAppMessage::dispatch($cliente->telefono, $html, format: 'html');

// PDF con descripción
SendWhatsAppMessage::dispatch($tel, '*Factura F001-123* 📄', pdfPath: storage_path('app/facturas/F001-123.pdf'));
```

Para probar la conexión desde el servidor de Laravel:

```bash
php artisan tinker --execute="dump(app(App\Services\WhatsApp::class)->isReady());"
```

## 5. (Opcional) Laravel en otro servidor: HTTPS

1. Crea un registro DNS `A` de `wa.tudominio.com` hacia la IP del VPS.
2. En el `.env` junto a `docker-compose.yml`:

    ```dotenv
    DOMAIN=wa.tudominio.com
    # IP pública de tu servidor Laravel (varias separadas por espacio)
    ALLOWED_IPS=203.0.113.10
    ```

3. Abre los puertos 80 y 443 en el firewall del VPS y levanta el proxy:

    ```bash
    docker compose --profile https up -d
    ```

Caddy obtiene el certificado solo, publica únicamente `/v1/*` y `/health`
(nunca el panel) y responde 403 a cualquier IP que no esté en `ALLOWED_IPS`.

---

## Formato de los mensajes

El campo `text` admite dos formatos, que eliges con `format`.

### `format: "whatsapp"` (por defecto): sintaxis nativa

| Resultado       | Escribe                              |
| --------------- | ------------------------------------ |
| **negrita**     | `*negrita*`                          |
| _cursiva_       | `_cursiva_`                          |
| ~~tachado~~     | `~tachado~`                          |
| `monoespaciado` | ` ```monoespaciado``` `              |
| código en línea | `` `código` ``                       |
| cita            | `> texto` (al inicio)                |
| lista           | `- item` o `1. item` (una por línea) |
| salto de línea  | `\n` en el JSON                      |
| emoji           | directo: `👋 ✅ 🎉 📄`               |

Los marcadores deben ir pegados al texto: `*hola*` funciona, `* hola *` no.
Se pueden combinar: `*_importante_*`.

**Ejemplo de JSON:**

```json
{
    "to": "51961991613",
    "text": "Hola *Ana* 👋\n\nTu pedido *#1024* fue _confirmado_ ✅\n- 2 × Pizza\n- 1 × Gaseosa\n\nTotal: *S/ 89.90* ~S/ 120.00~ 🎉"
}
```

### `format: "html"`: etiquetas que se convierten

| Resultado     | Escribe                                                               |
| ------------- | --------------------------------------------------------------------- |
| negrita       | `<b>…</b>` o `<strong>…</strong>`                                     |
| cursiva       | `<i>…</i>` o `<em>…</em>`                                             |
| tachado       | `<s>…</s>` o `<del>…</del>`                                           |
| **subrayado** | `<u>…</u>` (ver nota)                                                 |
| monoespaciado | `<pre>…</pre>`; código en línea `<code>…</code>`                      |
| párrafos      | `<p>…</p>`; salto de línea `<br>`                                     |
| listas        | `<ul><li>…</li></ul>`, `<ol><li>…</li></ol>`; las anidadas se sangran |
| cita          | `<blockquote>…</blockquote>`                                          |
| enlace        | `<a href="https://…">texto</a>` → `texto (https://…)`                 |
| emoji         | directo `🎉` o entidad `&#127881;`                                    |

Las demás etiquetas se descartan (queda su texto) y las entidades (`&amp;`,
`&nbsp;`…) se decodifican, así que puedes usar `{{ }}` de Blade sin problema.

```json
{
    "to": "51961991613",
    "format": "html",
    "text": "<p>Hola <b>Ana</b> 👋</p><p>Tu pedido <u>#1024</u> fue <i>confirmado</i> ✅</p>"
}
```

> **Subrayado:** WhatsApp no tiene subrayado. `<u>` se simula poniendo el
> carácter Unicode U+0332 bajo cada letra y número: en los teléfonos se ve
> subrayado, pero ese texto no se encuentra con el buscador de WhatsApp. Úsalo
> en palabras sueltas, no en datos que el cliente vaya a copiar.

> **Datos del cliente:** WhatsApp no permite "escapar" sus marcadores. Si un
> nombre trae `*`, `_` o `~` se aplicaría formato. En Laravel usa
> `WhatsApp::escape($valor)` para quitarlos de los datos externos.

---

## Referencia de la API

Base: `http://127.0.0.1:3000` (o tu dominio HTTPS). Todas las rutas, salvo
`/health`, piden `Authorization: Bearer <clave>`.

### `POST /v1/messages`

| Campo          | Tipo   | Obligatorio     | Descripción                                                 |
| -------------- | ------ | --------------- | ----------------------------------------------------------- |
| `to`           | string | sí              | Número con código de país: `51961991613`, `+51 961 991 613` |
| `text`         | string | si no hay `pdf` | Mensaje, o descripción del PDF                              |
| `format`       | string | no              | `whatsapp` (default) o `html`                               |
| `pdf.base64`   | string | —               | PDF en base64                                               |
| `pdf.url`      | string | —               | O una URL http(s) de donde descargarlo                      |
| `pdf.filename` | string | no              | Nombre que verá el cliente (`factura.pdf`)                  |

Respuesta `201`:

```json
{
    "id": "true_119654097887457@lid_3EB0…",
    "to": "119654097887457@lid",
    "timestamp": 1791571648
}
```

### Otras rutas

| Ruta                   | Devuelve                                                   |
| ---------------------- | ---------------------------------------------------------- |
| `GET /v1/messages/:id` | `status`: `pending`, `sent`, `delivered`, `read` o `error` |
| `GET /v1/status`       | estado de la sesión y número vinculado                     |
| `GET /health`          | sin clave; para el healthcheck                             |

### Errores

| Código | Significa                                     | ¿Reintentar? |
| ------ | --------------------------------------------- | ------------ |
| 400    | Datos inválidos (número, formato, PDF)        | no           |
| 401    | Clave incorrecta                              | no           |
| 404    | El número no tiene WhatsApp                   | no           |
| 413    | PDF demasiado grande                          | no           |
| 502    | WhatsApp rechazó el envío                     | sí           |
| 503    | Sin sesión o reconectando (espera hasta 60 s) | sí           |

Cuerpo de error: `{ "error": "mensaje en español" }`.

Los envíos se hacen **de uno en uno con una pausa** (`SEND_DELAY_MS`, 1 s por
defecto): enviar ráfagas a muchos números que no te tienen agendado es la causa
más común de bloqueo de cuentas en WhatsApp.

---

## Variables (`.env` junto a `docker-compose.yml`, todas opcionales)

| Variable                        | Default                       | Para qué                                                          |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `API_TOKEN`                     | generada                      | Fijar la clave de la API                                          |
| `PANEL_USER` / `PANEL_PASSWORD` | —                             | Contraseña extra para el panel                                    |
| `MAX_PDF_MB`                    | `16`                          | Tamaño máximo de PDF                                              |
| `SEND_DELAY_MS`                 | `1000`                        | Pausa mínima entre envíos                                         |
| `RESTART_EVERY_HOURS`           | `24`                          | Reinicio de Chromium para liberar memoria (la sesión se conserva) |
| `MEMORY_LIMIT_MB`               | 85% del límite del contenedor | Si se supera, reinicia Chromium cuando no hay envíos              |
| `DOMAIN` / `ALLOWED_IPS`        | —                             | Proxy HTTPS opcional (sección 5)                                  |

## Consumo medido

Con la sesión vinculada, en Docker (`chromium-headless-shell` 154):

- **~450–480 MB** de RAM estables (`docker stats`), CPU en reposo 2–4 %.
- Conecta en ~5 s al arrancar o tras un reinicio; no vuelve a pedir QR.
- Imagen de ~1,2 GB en disco; sesión de ~100 MB en el volumen.

## Cuánto dura la sesión

WhatsApp mantiene vinculado el dispositivo mientras **el teléfono principal se
conecte a internet al menos una vez cada 14 días**. El servicio:

- guarda la sesión en el volumen `whatsapp-data` (no lo borres) y se reconecta
  solo ante caídas de red;
- retoma el control si la cuenta se abre en otro WhatsApp Web;
- reinicia Chromium cada 24 h (o si la memoria sube) **sin** pedir QR;
- solo pide QR si desvinculas el dispositivo desde el teléfono.

Al vincular, WhatsApp siempre le pasa al dispositivo un resumen reciente de los
chats; es parte del protocolo y no se puede desactivar. El servicio no lo lee.

## Desarrollo local

```bash
npm install && npm --prefix service install
npm --prefix service start   # API :3000, panel :3001, datos en service/data
npx mocha tests/service      # tests del formato
```
