<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;

/**
 * Cliente del servicio de WhatsApp.
 *
 * Formatos de texto:
 *  - 'whatsapp' (default): sintaxis nativa  *negrita*  _cursiva_  ~tachado~  ```mono```
 *  - 'html': <b> <i> <u> <s> <code> <pre> <br> <p> <ul>/<ol>/<li> <blockquote> <a>
 * Los emojis se escriben directo en el texto (UTF-8): 👋 ✅ 🎉
 */
class WhatsApp
{
    protected function http(): PendingRequest
    {
        return Http::baseUrl(rtrim(config('services.whatsapp.url'), '/'))
            ->withToken(config('services.whatsapp.token'))
            ->acceptJson()
            ->asJson()
            ->connectTimeout(5)
            // El servicio espera hasta 60 s si WhatsApp está reconectando
            ->timeout((int) config('services.whatsapp.timeout', 90));
    }

    /**
     * @return array{id: string, to: string, timestamp: int}
     *
     * @throws \Illuminate\Http\Client\RequestException
     */
    public function sendText(string $to, string $text, string $format = 'whatsapp'): array
    {
        return $this->http()
            ->post('/v1/messages', [
                'to' => $to,
                'text' => $text,
                'format' => $format,
            ])
            ->throw()
            ->json();
    }

    /**
     * Envía un PDF desde un archivo local; $caption es opcional y admite formato.
     *
     * @return array{id: string, to: string, timestamp: int}
     *
     * @throws \Illuminate\Http\Client\RequestException
     */
    public function sendPdf(
        string $to,
        string $path,
        ?string $filename = null,
        ?string $caption = null,
        string $format = 'whatsapp',
    ): array {
        return $this->http()
            ->post('/v1/messages', [
                'to' => $to,
                'text' => $caption,
                'format' => $format,
                'pdf' => [
                    'base64' => base64_encode(file_get_contents($path)),
                    'filename' => $filename ?? basename($path),
                ],
            ])
            ->throw()
            ->json();
    }

    /**
     * Envía un PDF que el servicio descarga de una URL pública (p. ej. un enlace firmado de S3).
     *
     * @return array{id: string, to: string, timestamp: int}
     *
     * @throws \Illuminate\Http\Client\RequestException
     */
    public function sendPdfFromUrl(
        string $to,
        string $url,
        string $filename,
        ?string $caption = null,
        string $format = 'whatsapp',
    ): array {
        return $this->http()
            ->post('/v1/messages', [
                'to' => $to,
                'text' => $caption,
                'format' => $format,
                'pdf' => ['url' => $url, 'filename' => $filename],
            ])
            ->throw()
            ->json();
    }

    /**
     * Estado de entrega: pending, sent, delivered, read o error.
     *
     * @return array{id: string, ack: int, status: string}
     */
    public function messageStatus(string $messageId): array
    {
        return $this->http()
            ->get('/v1/messages/'.rawurlencode($messageId))
            ->throw()
            ->json();
    }

    /** true si hay un número vinculado y conectado. */
    public function isReady(): bool
    {
        $response = $this->http()->timeout(5)->get('/v1/status');

        return $response->successful() && $response->json('status') === 'ready';
    }

    /**
     * WhatsApp no tiene forma de "escapar" sus marcadores: si un dato del
     * cliente trae * _ ~ ` se aplicaría formato. Úsalo con valores externos.
     */
    public static function escape(?string $value): string
    {
        return str_replace(['*', '_', '~', '`'], '', (string) $value);
    }
}
