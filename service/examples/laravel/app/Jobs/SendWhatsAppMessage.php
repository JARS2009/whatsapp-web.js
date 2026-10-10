<?php

namespace App\Jobs;

use App\Services\WhatsApp;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Http\Client\RequestException;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;

/**
 * Envía el mensaje en segundo plano y reintenta si el servicio no está
 * disponible (503, red caída). Los errores de datos (400, 401, 404, 413) no
 * se reintentan porque fallarían igual.
 *
 *   SendWhatsAppMessage::dispatch('51961991613', 'Hola *Ana* 👋');
 *   SendWhatsAppMessage::dispatch($tel, $html, format: 'html');
 *   SendWhatsAppMessage::dispatch($tel, 'Tu factura 📄', pdfPath: storage_path('app/facturas/F001.pdf'));
 */
class SendWhatsAppMessage implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 5;

    public function __construct(
        public string $to,
        public ?string $text = null,
        public string $format = 'whatsapp',
        public ?string $pdfPath = null,
        public ?string $pdfName = null,
    ) {}

    /** Segundos entre reintentos. */
    public function backoff(): array
    {
        return [30, 60, 120, 300];
    }

    public function handle(WhatsApp $whatsapp): void
    {
        try {
            $result = $this->pdfPath
                ? $whatsapp->sendPdf($this->to, $this->pdfPath, $this->pdfName, $this->text, $this->format)
                : $whatsapp->sendText($this->to, (string) $this->text, $this->format);

            Log::info('WhatsApp enviado', ['to' => $this->to, 'id' => $result['id'] ?? null]);
        } catch (RequestException $e) {
            $status = $e->response->status();

            if (in_array($status, [400, 401, 404, 413], true)) {
                Log::warning('WhatsApp rechazado', [
                    'to' => $this->to,
                    'status' => $status,
                    'error' => $e->response->json('error'),
                ]);
                $this->fail($e);

                return;
            }

            throw $e; // 502/503/500: se reintenta según backoff()
        }
    }
}
