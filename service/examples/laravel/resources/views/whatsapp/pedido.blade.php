{{-- Plantilla con format "html": se convierte a formato de WhatsApp en el servicio. --}}
<p>Hola <b>{{ $cliente->nombre }}</b> 👋</p>

<p>Tu pedido <u>#{{ $pedido->id }}</u> fue <i>confirmado</i> ✅</p>

<ul>
    @foreach ($pedido->items as $item)
        <li>{{ $item->cantidad }} × {{ $item->nombre }}</li>
    @endforeach
</ul>

<p>Total: <b>S/ {{ number_format($pedido->total, 2) }}</b><br>
<s>Antes S/ {{ number_format($pedido->total_anterior, 2) }}</s> 🎉</p>

<blockquote>Entrega estimada: {{ $pedido->entrega->format('d/m H:i') }}</blockquote>

<p>Gracias por tu compra 🙌</p>
