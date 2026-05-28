require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════
// ESTOQUE (compartilhado com o PDV)
// Em produção isso seria um banco de dados
// Por ora usamos um arquivo JSON em memória
// ══════════════════════════════════════════
let estoque = []; // será preenchido pelo PDV via POST /api/estoque/sync

// ── ROTAS DE ESTOQUE ──────────────────────

// PDV sincroniza estoque aqui
app.post('/api/estoque/sync', (req, res) => {
  try {
    estoque = req.body.produtos || [];
    res.json({ ok: true, total: estoque.length });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// Loja consulta estoque
app.get('/api/estoque', (req, res) => {
  res.json(estoque);
});

// ── CALCULAR FRETE (SuperFrete) ───────────
app.post('/api/frete/calcular', async (req, res) => {
  try {
    const { cep_destino, produtos } = req.body;

    // Monta itens para a API do SuperFrete
    const itens = produtos.map(p => ({
      id:       String(p.id || 1),
      width:    p.largura  || 20,
      height:   p.altura   || 5,
      length:   p.comprimento || 30,
      weight:   p.peso     || 0.5,
      insurance_value: p.preco || 0,
      quantity: p.quantidade || 1
    }));

    const payload = {
      from: { postal_code: process.env.SUPERFRETE_CEP_ORIGEM },
      to:   { postal_code: cep_destino.replace(/\D/g,'') },
      products: itens,
      options: { receipt: false, own_hand: false }
    };

    const resp = await axios.post(
      'https://api.superfrete.com/api/v0/calculator',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.SUPERFRETE_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'CarinhaDeAnjo/1.0 (carinhadeanjopag@gmail.com)'
        }
      }
    );

    // Filtra apenas transportadoras sem erro e ordena por preço
    const opcoes = resp.data
      .filter(o => !o.error && o.price)
      .map(o => ({
        id:          o.id,
        nome:        o.name,
        empresa:     o.company?.name || '',
        preco:       parseFloat(o.price),
        prazo:       o.delivery_time,
        logo:        o.company?.picture || ''
      }))
      .sort((a,b) => a.preco - b.preco);

    res.json(opcoes);
  } catch(e) {
    console.error('Erro frete:', e.response?.data || e.message);
    res.status(500).json({ erro: 'Erro ao calcular frete', detalhe: e.message });
  }
});

// ── GERAR PIX (PagBank) ───────────────────
app.post('/api/pix/gerar', async (req, res) => {
  try {
    const { pedido } = req.body;
    const valor = pedido.total.toFixed(2);

    const payload = {
      reference_id: `PEDIDO-${Date.now()}`,
      customer: {
        name:  pedido.cliente.nome,
        email: pedido.cliente.email || 'cliente@carinhadeanjoloja.com',
        tax_id: '00000000000', // CPF genérico — PagBank exige
        phones: [{
          country: '55',
          area: pedido.cliente.telefone?.slice(0,2) || '79',
          number: pedido.cliente.telefone?.slice(2) || '999999999',
          type: 'MOBILE'
        }]
      },
      items: pedido.itens.map(it => ({
        reference_id: String(it.id || '1'),
        name:         it.nome.substring(0,64),
        quantity:     it.quantidade,
        unit_amount:  Math.round(it.preco * 100)
      })),
      qr_codes: [{
        amount: { value: Math.round(parseFloat(valor) * 100) },
        expiration_date: new Date(Date.now() + 30*60*1000).toISOString()
      }],
      shipping: {
        address: {
          street:      pedido.endereco.rua,
          number:      pedido.endereco.numero,
          complement:  pedido.endereco.complemento || '',
          locality:    pedido.endereco.bairro,
          city:        pedido.endereco.cidade,
          region_code: pedido.endereco.estado || 'SE',
          country:     'BRA',
          postal_code: pedido.endereco.cep.replace(/\D/g,'')
        }
      }
    };

    const resp = await axios.post(
      'https://api.pagseguro.com/orders',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAGBANK_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const qr = resp.data.qr_codes?.[0];
    const pixCopiaECola = qr?.text || '';
    const pedidoId      = resp.data.id || resp.data.reference_id;

    res.json({
      ok: true,
      pedido_id:       pedidoId,
      pix_copia_cola:  pixCopiaECola,
      expiracao:       qr?.expiration_date,
      valor:           valor
    });

  } catch(e) {
    console.error('Erro PIX:', e.response?.data || e.message);
    res.status(500).json({ erro: 'Erro ao gerar PIX', detalhe: e.response?.data || e.message });
  }
});

// ── VERIFICAR PAGAMENTO ───────────────────
app.get('/api/pix/verificar/:pedidoId', async (req, res) => {
  try {
    const resp = await axios.get(
      `https://api.pagseguro.com/orders/${req.params.pedidoId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAGBANK_TOKEN}`
        }
      }
    );

    const status = resp.data.charges?.[0]?.status || resp.data.status;
    const pago   = status === 'PAID' || status === 'AUTHORIZED';

    res.json({ pago, status });
  } catch(e) {
    res.status(500).json({ erro: 'Erro ao verificar', pago: false });
  }
});

// ── CONFIRMAR PEDIDO (dispara WhatsApp) ───
app.post('/api/pedido/confirmar', async (req, res) => {
  try {
    const { pedido } = req.body;

    // Monta mensagem do WhatsApp
    const itensTexto = pedido.itens.map(it =>
      `• ${it.quantidade}x ${it.nome} (Tam: ${it.tamanho || '-'}) — R$ ${(it.preco * it.quantidade).toFixed(2).replace('.',',')}`
    ).join('\n');

    const entregaTexto = pedido.entrega.tipo === 'motoboy'
      ? `🛵 Motoboy — ${pedido.entrega.bairro} — R$ ${pedido.entrega.valor.toFixed(2).replace('.',',')}`
      : pedido.entrega.tipo === 'retirada'
      ? `🏪 Retirada na loja`
      : `📦 Transportadora: ${pedido.entrega.transportadora} — R$ ${pedido.entrega.valor.toFixed(2).replace('.',',')} — Prazo: ${pedido.entrega.prazo} dias`;

    const msg = encodeURIComponent(
`🛍️ *NOVO PEDIDO — CARINHA DE ANJO*

👤 *Cliente:* ${pedido.cliente.nome}
📱 *Telefone:* ${pedido.cliente.telefone}

📦 *Itens:*
${itensTexto}

${entregaTexto}

📍 *Endereço:*
${pedido.endereco.rua}, ${pedido.endereco.numero}${pedido.endereco.complemento ? ' — '+pedido.endereco.complemento : ''}
${pedido.endereco.bairro} — ${pedido.endereco.cidade}/${pedido.endereco.estado}
CEP: ${pedido.endereco.cep}

💰 *Total pago:* R$ ${pedido.total.toFixed(2).replace('.',',')}
✅ *Pagamento: PIX CONFIRMADO*`
    );

    const linkWhatsApp = `https://wa.me/${process.env.WHATSAPP_NUMERO}?text=${msg}`;

    // Baixa estoque
    pedido.itens.forEach(it => {
      const prod = estoque.find(e => e.id === it.id);
      if(prod) {
        const tam = prod.tamanhos?.find(t => t.tamanho === it.tamanho);
        if(tam) tam.quantidade = Math.max(0, tam.quantidade - it.quantidade);
        prod.estoque_total = Math.max(0, (prod.estoque_total || 0) - it.quantidade);
      }
    });

    res.json({ ok: true, whatsapp: linkWhatsApp });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── WEBHOOK PagBank (notificações) ────────
app.post('/api/webhook/pagbank', async (req, res) => {
  try {
    console.log('Webhook PagBank:', JSON.stringify(req.body));
    res.sendStatus(200);
  } catch(e) {
    res.sendStatus(500);
  }
});

// ── CONSULTAR CEP ─────────────────────────
app.get('/api/cep/:cep', async (req, res) => {
  try {
    const cep = req.params.cep.replace(/\D/g,'');
    const resp = await axios.get(`https://viacep.com.br/ws/${cep}/json/`);
    res.json(resp.data);
  } catch(e) {
    res.status(500).json({ erro: 'CEP não encontrado' });
  }
});

// Serve a loja
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
