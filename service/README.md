# Servicio de WhatsApp (texto + PDF)

API para enviar mensajes de texto y PDFs desde **un solo número**, más un panel
interno para vincularlo y vigilar la sesión. Pensado para un VPS con 1 GB de RAM.

## Despliegue en el VPS

```bash
git clone <tu-repo> whatsapp && cd whatsapp
docker compose up -d --build
```

Primera vez: abre el panel (ver abajo), pulsa **Generar QR** y escanéalo desde
_WhatsApp → Ajustes → Dispositivos vinculados_. La sesión queda guardada en el
volumen `whatsapp-data` y sobrevive a reinicios del contenedor y del VPS.

> Usa la sesión en **un solo lugar a la vez**. Si la tienes abierta en tu PC,
> detenla antes de levantar el VPS.

### Variables (`.env` junto a `docker-compose.yml`, todas opcionales)

| Variable                        | Default                       | Para qué                                                                             |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `API_TOKEN`                     | generado                      | Token de la API. Si no lo defines se genera y se muestra en el panel.                |
| `PANEL_USER` / `PANEL_PASSWORD` | —                             | Contraseña extra para el panel.                                                      |
| `MAX_PDF_MB`                    | `16`                          | Tamaño máximo de PDF.                                                                |
| `RESTART_EVERY_HOURS`           | `24`                          | Reinicio de Chromium para liberar memoria (la sesión se conserva). `0` lo desactiva. |
| `MEMORY_LIMIT_MB`               | 85% del límite del contenedor | Si se supera, reinicia Chromium cuando no hay envíos.                                |

## Panel interno (no expuesto)

El panel escucha solo en `127.0.0.1:3001` del VPS. Para abrirlo desde tu PC:

```bash
ssh -N -L 3001:127.0.0.1:3001 usuario@tu-vps
```

y entra a <http://localhost:3001>. Muestra el estado, hace cuánto está
vinculada la sesión, cuánto lleva conectada sin cortes, los mensajes enviados,
la memoria usada y el token de la API.

## API

Puerto `3000`, también solo en `127.0.0.1` del VPS: tus apps del mismo servidor
la usan directo. Si necesitas llamarla desde fuera, ponla detrás de un proxy con
HTTPS (Caddy/Nginx); no publiques el puerto tal cual.

Todas las rutas (salvo `/health`) piden `Authorization: Bearer <API_TOKEN>`.

**Texto**

```bash
curl -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"51961991613","text":"Hola"}'
```

**PDF** (en base64 o por URL; `text` es opcional y va como descripción)

```bash
curl -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"to\":\"51961991613\",\"text\":\"Tu factura\",\"pdf\":{\"filename\":\"factura.pdf\",\"base64\":\"$(base64 -w0 factura.pdf)\"}}"

curl -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"51961991613","pdf":{"url":"https://midominio.com/factura.pdf","filename":"factura.pdf"}}'
```

Respuesta `201`: `{"id":"true_…","to":"…@lid","timestamp":…}`

| Ruta                   | Qué devuelve                                               |
| ---------------------- | ---------------------------------------------------------- |
| `GET /v1/messages/:id` | `status`: `pending`, `sent`, `delivered`, `read` o `error` |
| `GET /v1/status`       | estado de la sesión y número vinculado                     |
| `GET /health`          | sin token; para el healthcheck                             |

Errores: `400` datos inválidos, `401` token, `404` número sin WhatsApp,
`413` PDF muy grande, `503` sin sesión (espera hasta 60 s a que reconecte),
`502` WhatsApp rechazó el envío.

`to` acepta el número con código de país (con o sin `+`, espacios o guiones).
Los envíos se procesan de uno en uno.

## Consumo medido

Con la sesión vinculada, en Docker (`chromium-headless-shell` 154):

- **~450–480 MB** de RAM estables (`docker stats`), CPU en reposo 2–4 %.
- Conecta en ~5 s al arrancar o tras un reinicio; no vuelve a pedir QR.
- Imagen de ~1,2 GB en disco; sesión de ~100 MB en el volumen.

Una cuenta con muchos chats usará algo más. El límite del contenedor es 1 GB y
el servicio reinicia Chromium solo si pasa del 85%.

## Cuánto dura la sesión

WhatsApp mantiene vinculado el dispositivo mientras **el teléfono principal se
conecte a internet al menos una vez cada 14 días**. El servicio, por su parte:

- guarda la sesión en disco y se reconecta solo ante caídas de red;
- retoma el control si la cuenta se abre en otro WhatsApp Web;
- reinicia Chromium cada 24 h (o si la memoria sube) **sin** pedir QR de nuevo;
- solo pide QR si desvinculas el dispositivo desde el teléfono.

## Desarrollo local

```bash
npm install && npm --prefix service install
npm --prefix service start   # API :3000, panel :3001, datos en service/data
```
