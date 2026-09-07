/**
 * DG TECH ARCADE — CONTROLE REMOTO 4G/WI-FI & GESTÃO DE VENDAS
 * Foco: Disparo de Coin (Manutenção / Teste Técnico) & Controle Financeiro de Caixa
 * Comunicação direta com ESP-01S (Módulo Relé Coin) e Servidor Local/Túnel 4G
 */

const DG_STATE_KEY = 'DG_TECH_ARCADE_DATA_V4';

const defaultState = {
  machineName: 'DG ARCADE #01',
  tokenPrice: 2.50,
  soundEnabled: true,
  requireConfirm: false,
  requirePin: false,
  securityPin: '1234',

  // Conexão Wi-Fi com o Módulo Relé
  esp01Ip: '192.168.18.99',

  // Seleção Atual do Operador
  selectedMode: 'manutencao', // 'manutencao', 'cortesia', 'venda'
  selectedQty: 1,

  // Contadores da Sessão / Caixa Atual
  sessionCash: 0.00,
  sessionTokens: 0,
  paidTokens: 0,
  courtesyTokens: 0,
  maintenanceTokens: 0,

  // Totalizador Geral Inviolável
  generalTokens: 0,
  generalCash: 0.00,

  // Divisão com a Barbearia
  barberSplitPercent: 50,

  // Estatísticas Rápidas
  authorizedCoinsToday: 0,
  lastCoinTime: 'Nenhum',

  // Lista de Eventos / Transações
  events: []
};

let appState = { ...defaultState };
let audioCtx = null;
let currentFilter = 'all';
let lastTelemetryEventId = 0;

// ==========================================================================
// INICIALIZAÇÃO
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadLocalState();
  initClock();
  initAudio();
  initEventListeners();
  renderAllData();

  // Sincroniza estado com o backend Python
  fetchServerStatus();

  // Testa conectividade com o relé
  pingEsp01(false);
  startAutoPing();
  startTelemetryPolling();

  appendHardwareFeed('DG TECH ARCADE pronto para acionamento via 4G / Wi-Fi.');
});

// Detecta a URL base da API (seja local, túnel Cloudflare ou 4G)
function getApiBase() {
  if (window.location.protocol === 'file:') {
    return 'http://localhost:8088';
  }
  if (window.location.port && window.location.port !== '8088') {
    return `http://${window.location.hostname || 'localhost'}:8088`;
  }
  return '';
}

function formatNetworkError(err) {
  if (err && (err.message === 'Failed to fetch' || err.name === 'TypeError')) {
    return "Servidor local inacessível. Certifique-se de que 'python server.py' ou o túnel 4G está em execução.";
  }
  return err.message || 'Falha de comunicação';
}

function getEsp01Ip() {
  const el = document.getElementById('esp01IpInput') || document.getElementById('settingsEsp01Ip');
  return (el?.value || appState.esp01Ip || '192.168.18.99').trim();
}

function getPin() {
  const quickPin = document.getElementById('pinInputQuick')?.value;
  const settingsPin = document.getElementById('settingsPin')?.value;
  return (quickPin || settingsPin || appState.securityPin || '1234').trim();
}

// ==========================================================================
// PERSISTÊNCIA & SINCRONIZAÇÃO COM O BACKEND
// ==========================================================================
function loadLocalState() {
  try {
    const saved = localStorage.getItem(DG_STATE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.esp01Ip === '192.168.1.62' || !parsed.esp01Ip) {
        parsed.esp01Ip = '192.168.18.99';
      }
      appState = { ...defaultState, ...parsed };
    }
  } catch (e) {
    console.warn('Erro ao ler localStorage:', e);
  }
}

function saveLocalState() {
  try {
    localStorage.setItem(DG_STATE_KEY, JSON.stringify(appState));
  } catch (e) {
    console.error('Falha ao salvar localStorage:', e);
  }
}

async function fetchServerStatus() {
  try {
    let s = null;
    try {
      const resp = await fetch(`${getApiBase()}/api/vendas/status`);
      if (resp.ok) {
        const res = await resp.json();
        if (res.success && res.data) s = res.data;
      }
    } catch (e) {
      // Backend inacessível diretamente
    }

    // Se o backend não respondeu (ex: Render em modo estático ou offline), lê dados_vendas.json direto!
    if (!s) {
      try {
        const fallbackResp = await fetch('dados_vendas.json');
        if (fallbackResp.ok) {
          s = await fallbackResp.json();
        }
      } catch (e) {}
    }

    if (s) {
      appState.sessionCash = s.session_cash ?? appState.sessionCash;
      appState.sessionTokens = s.session_tokens ?? appState.sessionTokens;
      appState.paidTokens = s.paid_tokens ?? appState.paidTokens;
      appState.courtesyTokens = s.courtesy_tokens ?? appState.courtesyTokens;
      appState.maintenanceTokens = s.maintenance_tokens ?? appState.maintenanceTokens;
      appState.generalTokens = s.general_tokens ?? appState.generalTokens;
      appState.generalCash = s.general_cash ?? appState.generalCash;
      appState.tokenPrice = s.price_per_token ?? appState.tokenPrice;
      appState.requirePin = s.require_pin ?? appState.requirePin;
      appState.barberSplitPercent = s.barber_split_percent ?? appState.barberSplitPercent;

      const mpText = document.getElementById('mpSyncText');
      if (mpText) {
        mpText.textContent = s.last_mp_sync ? `BARBEARIA (${s.last_mp_sync})` : 'BARBEARIA (PIX NUVEM)';
      }

      if (s.events && s.events.length > 0) {
        appState.events = s.events;
        lastTelemetryEventId = s.events[s.events.length - 1].id;
      }

      saveLocalState();
      renderAllData();
    }
  } catch (err) {
    console.log('Servidor remoto em transição ou offline:', err.message);
  }
}

// ==========================================================================
// DISPARO DE COIN (MANUTENÇÃO / TESTE / VENDA)
// ==========================================================================

// Acionamento físico direto do relé na rede local Wi-Fi (compatível com celulares em HTTPS)
function triggerLocalRelayHardware(ip, qtd) {
  try {
    let form = document.getElementById('directRelayForm');
    if (!form) {
      form = document.createElement('form');
      form.id = 'directRelayForm';
      form.method = 'GET';
      form.target = 'relayHiddenFrame';
      form.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'quantidade';
      input.id = 'relayHiddenQtd';
      form.appendChild(input);
      document.body.appendChild(form);
    }
    let iframe = document.getElementById('relayHiddenFrame');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.name = 'relayHiddenFrame';
      iframe.id = 'relayHiddenFrame';
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
    }
    form.action = `http://${ip}/credito`;
    document.getElementById('relayHiddenQtd').value = qtd;
    form.submit();
    return true;
  } catch (e) {
    console.warn('[RELAY HARDWARE TRIGGER]', e);
    return false;
  }
}

async function fireCoinPulse(qtd, modo, motivo = 'Disparo Remoto') {
  const ip = getEsp01Ip();
  const pin = getPin();

  appendHardwareFeed(`[ESP-01S] Enviando disparo de ${qtd} ficha(s) (Modo: ${modo.toUpperCase()}) para ${ip}...`);

  // Disparo físico direto na rede Wi-Fi via form target (não é bloqueado por Mixed Content)
  triggerLocalRelayHardware(ip, qtd);

  let backendSuccess = false;
  let backendEvent = null;

  try {
    const url = `${getApiBase()}/api/esp01/credito?ip=${encodeURIComponent(ip)}&qtd=${qtd}&modo=${modo}&motivo=${encodeURIComponent(motivo)}&pin=${encodeURIComponent(pin)}`;
    const resp = await fetch(url);

    if (resp.status === 403) {
      playBuzzerSound();
      appendHardwareFeed(`[SEGURANÇA] PIN incorreto! Verifique o PIN de acesso.`);
      alert('PIN de segurança incorreto! Verifique a senha de acesso.');
      return false;
    }

    if (resp.ok) {
      const data = await resp.json();
      if (data.success) {
        backendSuccess = true;
        backendEvent = data.event;
      }
    }
  } catch (err) {
    // Normal em sites estáticos ou Render (onde nuvem não acessa o IP da barbearia)
  }

  // Executa ações sonoras e visuais locais de confirmação
  playCoinSound();
  triggerScreenFlash();

  appState.authorizedCoinsToday += qtd;
  appState.lastCoinTime = new Date().toLocaleTimeString('pt-BR');

  const now = new Date();
  const event = backendEvent || {
    id: Date.now(),
    tipo: modo,
    fichas: qtd,
    valor: modo === 'venda' ? (qtd * appState.tokenPrice) : 0,
    descricao: motivo || (modo === 'manutencao' ? 'Teste Técnico Wi-Fi' : (modo === 'cortesia' ? 'Cortesia Wi-Fi' : 'Venda Wi-Fi')),
    origem: `Wi-Fi (${ip})`,
    cliente: modo === 'manutencao' ? 'Técnico / Manutenção' : (modo === 'cortesia' ? 'Cortesia / Bônus' : 'Venda Local'),
    timestamp: now.getTime() / 1000,
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };

  appState.events.unshift(event);
  if (appState.events.length > 300) appState.events.pop();

  // Atualiza estado financeiro local
  const valor = qtd * appState.tokenPrice;
  if (modo === 'venda') {
    appState.sessionCash += valor;
    appState.sessionTokens += qtd;
    appState.paidTokens += qtd;
    appState.generalTokens += qtd;
    appState.generalCash += valor;
    appendHardwareFeed(`[VENDA SUCESSO] ${qtd} ficha(s) liberada(s) (R$ ${formatCurrency(valor)})!`);
    showToast(`🪙 ${qtd} ficha(s) vendida(s) no relé!`);
  } else if (modo === 'cortesia') {
    appState.courtesyTokens += qtd;
    appState.generalTokens += qtd;
    appendHardwareFeed(`[CORTESIA SUCESSO] ${qtd} ficha(s) cortesia liberada(s)!`);
    showToast(`🎁 ${qtd} ficha(s) cortesia liberada(s)!`);
  } else {
    appState.maintenanceTokens += qtd;
    appendHardwareFeed(`[MANUTENÇÃO SUCESSO] ${qtd} ficha(s) técnica(s) disparada(s) no relé (${ip})!`);
    showToast(`⚡ ${qtd} pulso(s) disparado(s) no relé!`);
  }

  saveLocalState();
  renderAllData();
  return true;
}

// Testar conexão com o ESP-01S (Ping)
async function pingEsp01(silent = false) {
  const ip = getEsp01Ip();
  if (!silent) appendHardwareFeed(`[ESP-01S] Verificando conexão no IP ${ip}...`);

  const badge = document.getElementById('esp01StatusBadge');
  const text = document.getElementById('esp01StatusText');

  try {
    const resp = await fetch(`${getApiBase()}/api/esp01/ping?ip=${encodeURIComponent(ip)}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.online) {
        if (badge) badge.className = 'status-indicator online';
        if (text) text.textContent = 'ONLINE';
        if (!silent) {
          playCoinSound();
          appendHardwareFeed(`[ESP-01S OK] Módulo Relé ONLINE no IP ${ip}!`);
          showToast(`📡 Relé ONLINE no IP ${ip}!`);
        }
        return true;
      }
    }
  } catch (err) {}

  // Se estiver acessando via Render/Nuvem (HTTPS), o servidor na nuvem não alcança o IP local,
  // mas o celular no Wi-Fi alcança! Exibe indicador de Wi-Fi configurado
  if (window.location.protocol === 'https:' || !getApiBase()) {
    if (badge) badge.className = 'status-indicator online';
    if (text) text.textContent = 'REDE WI-FI';
    if (!silent) {
      appendHardwareFeed(`[ESP-01S] Configurado para acionar ${ip} via Wi-Fi.`);
      showToast(`📡 Módulo configurado para Wi-Fi (${ip})`);
    }
    return true;
  }

  if (badge) badge.className = 'status-indicator offline';
  if (text) text.textContent = 'OFFLINE';
  if (!silent) {
    playBuzzerSound();
    appendHardwareFeed(`[ESP-01S] Sem resposta em ${ip}. Verifique a alimentação do relé.`);
  }
  return false;
}

function startAutoPing() {
  setInterval(() => {
    pingEsp01(true);
  }, 12000);
}

// Polling de Telemetria Contínuo
function startTelemetryPolling() {
  setInterval(async () => {
    try {
      const resp = await fetch(`${getApiBase()}/api/telemetria/eventos_recentes?since=${lastTelemetryEventId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.events && data.events.length > 0) {
        let hasNewVenda = false;
        data.events.forEach(evt => {
          lastTelemetryEventId = Math.max(lastTelemetryEventId, evt.id);
          // Evita duplicatas locais
          if (!appState.events.some(e => e.id === evt.id)) {
            appState.events.unshift(evt);
            if (evt.tipo === 'venda') {
              hasNewVenda = true;
              showToast(`💈 NOVO PIX NA BARBEARIA! ${evt.descricao || ''}`);
              appendHardwareFeed(`[VENDA PIX] ${evt.descricao || ''} (+R$ ${formatCurrency(evt.valor)})`);
            }
          }
        });
        if (hasNewVenda) {
          playCoinSound();
          triggerScreenFlash();
        }
        fetchServerStatus();
      }
    } catch (e) {
      // Ignora pequenas falhas de polling temporárias
    }
  }, 3000);
}

// ==========================================================================
// AÇÕES FINANCEIRAS: SANGRIA E REGISTRO MANUAL
// ==========================================================================
async function executeSangria(responsavel, observacao, shouldGenPdf = true) {
  appendHardwareFeed(`[SANGRIA] Realizando fechamento de caixa por ${responsavel}...`);

  // Captura o estado da sessão atual antes de zerar
  const sessionEvents = getSessionEvents();
  const valorRecolhido = appState.sessionCash;
  const fichasFechadas = appState.sessionTokens;
  const splitPercent = appState.barberSplitPercent ?? 50;
  const barberValor = (valorRecolhido * splitPercent) / 100.0;
  const ownerValor = valorRecolhido - barberValor;
  const now = new Date();

  let serverEvent = null;

  try {
    const resp = await fetch(`${getApiBase()}/api/vendas/sangria`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responsavel, observacao })
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.success) {
        serverEvent = data.event;
      }
    }
  } catch (err) {
    // Continua com processamento local se offline ou em site estático
  }

  playSuccessChime();
  appState.sessionCash = 0.00;
  appState.sessionTokens = 0;
  appState.paidTokens = 0;
  appState.courtesyTokens = 0;

  const event = serverEvent || {
    id: Date.now(),
    tipo: 'sangria',
    fichas: fichasFechadas,
    valor: valorRecolhido,
    descricao: `Fechamento de Caixa — ${responsavel}${observacao ? ' (' + observacao + ')' : ''}`,
    origem: 'Painel Gerencial',
    cliente: 'Fechamento de Caixa',
    responsavel: responsavel,
    observacao: observacao,
    repasse_barbearia: barberValor,
    lucro_proprietario: ownerValor,
    split_percent: splitPercent,
    timestamp: now.getTime() / 1000,
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };

  appState.events.unshift(event);
  if (appState.events.length > 300) appState.events.pop();

  saveLocalState();
  renderAllData();
  showToast(`🔒 Caixa fechado! R$ ${formatCurrency(valorRecolhido)} recolhido.`);
  appendHardwareFeed(`[SANGRIA CONCLUÍDA] R$ ${formatCurrency(valorRecolhido)} recolhido com sucesso!`);

  if (shouldGenPdf) {
    generateSangriaPdfReceipt({
      valorRecolhido: valorRecolhido,
      fichasFechadas: fichasFechadas,
      barberSplitPercent: splitPercent,
      barberValor: barberValor,
      ownerValor: ownerValor,
      responsavel: responsavel,
      observacao: observacao,
      dataHora: `${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR')}`,
      events: sessionEvents
    });
  }
  return true;
}

async function executeManualSale(fichas, valor, origem) {
  appendHardwareFeed(`[ENTRADA MANUAL] Registrando ${fichas} ficha(s) (R$ ${formatCurrency(valor)})...`);
  
  let serverEvent = null;

  try {
    const resp = await fetch(`${getApiBase()}/api/vendas/registrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fichas, valor, origem })
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.success) {
        serverEvent = data.event;
      }
    }
  } catch (err) {
    // Continua com processamento local
  }

  playSuccessChime();
  appState.sessionCash += valor;
  appState.sessionTokens += fichas;
  appState.paidTokens += fichas;
  appState.generalTokens += fichas;
  appState.generalCash += valor;

  const now = new Date();
  const event = serverEvent || {
    id: Date.now(),
    tipo: 'venda',
    fichas: fichas,
    valor: valor,
    descricao: `Entrada Manual — ${origem}`,
    origem: origem,
    cliente: 'Entrada Manual',
    banco: 'Dinheiro Físico',
    timestamp: now.getTime() / 1000,
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };

  appState.events.unshift(event);
  if (appState.events.length > 300) appState.events.pop();

  saveLocalState();
  renderAllData();
  showToast(`💵 Entrada manual de R$ ${formatCurrency(valor)} registrada!`);
  appendHardwareFeed(`[ENTRADA REGISTRADA] R$ ${formatCurrency(valor)} adicionado ao caixa.`);
  return true;
}

// ==========================================================================
// RENDERIZAÇÃO & INTERFACE
// ==========================================================================
function renderAllData() {
  // 1. Caixa e Fichas
  setText('sessionCashTotal', formatCurrency(appState.sessionCash));
  setText('sessionTokensCount', appState.sessionTokens);
  setText('paidTokensCount', appState.paidTokens);
  setText('courtesyTokensCount', appState.courtesyTokens);
  setText('maintenanceTokensCount', appState.maintenanceTokens);
  setText('totalGeneralTokens', appState.generalTokens);
  setText('totalGeneralCash', `R$ ${formatCurrency(appState.generalCash)}`);
  setText('currentPriceDisplay', `R$ ${formatCurrency(appState.tokenPrice)}`);
  setText('authorizedCoinsCount', appState.authorizedCoinsToday);
  setText('lastCoinTime', appState.lastCoinTime || 'Nenhum');

  // Divisão Financeira da Barbearia
  const splitPercent = appState.barberSplitPercent ?? 50;
  const barberVal = (appState.sessionCash * splitPercent) / 100.0;
  const ownerVal = appState.sessionCash - barberVal;

  setText('barberSplitPercentDisplay', splitPercent);
  setText('barberSplitValue', `R$ ${formatCurrency(barberVal)}`);
  setText('ownerSplitValue', `R$ ${formatCurrency(ownerVal)}`);

  setText('sangriaBarberPercentLabel', splitPercent);
  setText('sangriaOwnerPercentLabel', 100 - splitPercent);
  setText('sangriaBarberAmount', `R$ ${formatCurrency(barberVal)}`);
  setText('sangriaOwnerAmount', `R$ ${formatCurrency(ownerVal)}`);

  const totalTrans = appState.events.length;
  setText('totalTransactionsCount', totalTrans);

  // 2. Botão Principal de Disparo
  const qty = appState.selectedQty || 1;
  const mode = appState.selectedMode || 'manutencao';
  const fireLabel = document.getElementById('fireBtnLabel');
  const fireSub = document.getElementById('fireBtnSubLabel');

  if (fireLabel) {
    fireLabel.textContent = `DISPARAR ${qty} ${qty === 1 ? 'FICHA' : 'FICHAS'}`;
  }
  if (fireSub) {
    if (mode === 'venda') {
      const v = qty * appState.tokenPrice;
      fireSub.textContent = `VENDA MANUAL (R$ ${formatCurrency(v)})`;
    } else if (mode === 'cortesia') {
      fireSub.textContent = `MODO CORTESIA / BÔNUS`;
    } else {
      fireSub.textContent = `MODO MANUTENÇÃO TÉCNICA`;
    }
  }

  // 3. Renderiza Tabela de Logs de Auditoria
  renderLogsTable();
}

function renderLogsTable() {
  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;

  const search = (document.getElementById('logSearchInput')?.value || '').toLowerCase().trim();

  let filtered = appState.events;
  if (currentFilter !== 'all') {
    filtered = filtered.filter(e => e.tipo === currentFilter);
  }
  if (search) {
    filtered = filtered.filter(e => 
      (e.descricao && e.descricao.toLowerCase().includes(search)) ||
      (e.origem && e.origem.toLowerCase().includes(search)) ||
      (e.hora && e.hora.toLowerCase().includes(search))
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">Nenhum registro encontrado para este filtro.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.slice(0, 50).map(evt => {
    let badgeClass = 'badge-manutencao';
    let badgeLabel = 'MANUTENÇÃO';

    if (evt.tipo === 'venda') {
      if (evt.origem && (evt.origem.includes('Mercado Pago') || evt.origem.includes('Pix'))) {
        badgeClass = 'badge-pix';
        badgeLabel = 'PIX BARBEARIA';
      } else {
        badgeClass = 'badge-venda';
        badgeLabel = 'VENDA';
      }
    } else if (evt.tipo === 'cortesia') {
      badgeClass = 'badge-cortesia';
      badgeLabel = 'CORTESIA';
    } else if (evt.tipo === 'sangria') {
      badgeClass = 'badge-sangria';
      badgeLabel = 'SANGRIA';
    }

    const valorStr = (evt.valor && evt.valor > 0) ? `R$ ${formatCurrency(evt.valor)}` : '—';
    const fichasStr = evt.fichas ? `${evt.fichas} un` : '—';
    const clienteStr = evt.cliente || (evt.tipo === 'venda' ? (evt.banco ? `Cliente ${evt.banco}` : 'Cliente Pix') : '—');

    return `
      <tr>
        <td class="log-time">${evt.hora || '--:--'} <small class="text-muted">${evt.data || ''}</small></td>
        <td><span class="event-badge ${badgeClass}">${badgeLabel}</span></td>
        <td class="log-client font-mono">
          <div class="client-name-wrapper">
            <span class="client-name-text">${escapeHtml(clienteStr)}</span>
            ${evt.tipo === 'venda' ? `<button class="btn-edit-client" onclick="promptEditClientName(${evt.id})" title="Identificar / Nome do Cliente">✏️</button>` : ''}
          </div>
        </td>
        <td class="log-desc">${escapeHtml(evt.descricao || '')}</td>
        <td class="log-tokens font-mono">${fichasStr}</td>
        <td class="log-value font-mono text-green">${valorStr}</td>
        <td class="log-origin text-muted">${escapeHtml(evt.origem || 'Remoto')}</td>
      </tr>
    `;
  }).join('');
}

// Identificar / Renomear Cliente de uma Venda
async function promptEditClientName(eventId) {
  const evt = (appState.events || []).find(e => e.id === eventId);
  if (!evt) return;
  const current = evt.cliente || '';
  const novoNome = prompt('Identificação ou Nome do Cliente deste Pix:', current);
  if (novoNome === null) return;

  const trimmed = novoNome.trim();
  evt.cliente = trimmed || (evt.banco ? `Cliente ${evt.banco}` : 'Cliente Pix');

  saveLocalState();
  renderLogsTable();

  try {
    await fetch(`${getApiBase()}/api/vendas/cliente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, cliente: evt.cliente })
    });
    showToast(`👤 Cliente atualizado: ${evt.cliente}`);
    appendHardwareFeed(`[CLIENTE] Venda #${eventId} identificada como: ${evt.cliente}`);
  } catch (e) {
    showToast(`👤 Nome salvo localmente!`);
  }
}
window.promptEditClientName = promptEditClientName;

// ==========================================================================
// RELATÓRIOS: CSV & PDF GERENCIAL ORGANIZADO POR DATA, HORA E VALOR
// ==========================================================================

function getSessionEvents() {
  const list = [];
  for (const evt of (appState.events || [])) {
    if (evt.tipo === 'sangria') {
      break;
    }
    list.push(evt);
  }
  return list;
}

function formatEventTypeLabel(evt) {
  if (evt.tipo === 'venda') {
    if (evt.origem && (evt.origem.includes('Mercado Pago') || evt.origem.includes('Pix'))) {
      return 'Pix Barbearia';
    }
    return 'Venda Manual';
  }
  if (evt.tipo === 'sangria') return 'Fechamento / Sangria';
  if (evt.tipo === 'cortesia') return 'Cortesia';
  if (evt.tipo === 'manutencao') return 'Manutenção Técnica';
  return evt.tipo ? evt.tipo.toUpperCase() : 'OUTRO';
}

// Exportar Tabela para Arquivo CSV
function exportLogsCsv() {
  if (!appState.events || appState.events.length === 0) {
    alert('Nenhum dado para exportar.');
    return;
  }

  const headers = ['ID', 'Data', 'Horario', 'Tipo', 'Descricao', 'Fichas', 'Valor_R$', 'Origem'];
  const rows = appState.events.map(e => [
    e.id,
    e.data || '',
    e.hora || '',
    e.tipo || '',
    `"${(e.descricao || '').replace(/"/g, '""')}"`,
    e.fichas || 0,
    (e.valor || 0).toFixed(2),
    `"${(e.origem || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `auditoria_arcade_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  appendHardwareFeed('[CSV] Relatório financeiro exportado com sucesso.');
}

// Geração de Relatório Profissional em PDF (Organizado por Data, Hora e Valor)
function generatePdfReport({ scope = 'all', sort = 'desc', responsavel = 'Daniel', mode = 'download' } = {}) {
  let targetEvents = [];
  let scopeTitle = 'Histórico Geral de Transações';

  if (scope === 'session') {
    targetEvents = getSessionEvents();
    scopeTitle = 'Caixa da Sessão Atual (Aberta)';
  } else if (scope === 'pix_only') {
    targetEvents = (appState.events || []).filter(e => e.tipo === 'venda' && (e.origem?.includes('Mercado Pago') || e.origem?.includes('Pix')));
    scopeTitle = 'Vendas Pix da Barbearia (Mercado Pago)';
  } else if (scope === 'sangria_only') {
    targetEvents = (appState.events || []).filter(e => e.tipo === 'sangria');
    scopeTitle = 'Histórico de Fechamentos de Caixa (Sangrias)';
  } else {
    targetEvents = [...(appState.events || [])];
    scopeTitle = 'Histórico Completo de Transações';
  }

  if (targetEvents.length === 0) {
    alert('Nenhuma transação encontrada para o escopo selecionado.');
    return;
  }

  // Ordenação por Data, Hora ou Valor
  targetEvents.sort((a, b) => {
    if (sort === 'asc') {
      return (a.timestamp || 0) - (b.timestamp || 0);
    } else if (sort === 'value_desc') {
      return (b.valor || 0) - (a.valor || 0);
    }
    return (b.timestamp || 0) - (a.timestamp || 0); // Padrão: mais recente primeiro
  });

  // Cálculos de Totais Financeiros
  const totalVendasValor = targetEvents
    .filter(e => e.tipo === 'venda')
    .reduce((acc, e) => acc + (parseFloat(e.valor) || 0), 0);
  const totalVendasFichas = targetEvents
    .filter(e => e.tipo === 'venda')
    .reduce((acc, e) => acc + (parseInt(e.fichas) || 0), 0);
  const totalCortesias = targetEvents
    .filter(e => e.tipo === 'cortesia')
    .reduce((acc, e) => acc + (parseInt(e.fichas) || 0), 0);
  const totalManutencoes = targetEvents
    .filter(e => e.tipo === 'manutencao')
    .reduce((acc, e) => acc + (parseInt(e.fichas) || 0), 0);

  const splitPercent = appState.barberSplitPercent ?? 50;
  const repasseBarbearia = (totalVendasValor * splitPercent) / 100.0;
  const lucroProprietario = totalVendasValor - repasseBarbearia;

  const dataHoraEmissao = `${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`;

  // Se a biblioteca jsPDF não estiver carregada (offline/bloqueio), usa impressão nativa formatada
  const jsPDFConstructor = window.jspdf?.jsPDF;
  if (!jsPDFConstructor) {
    fallbackHtmlPrintReport({
      scopeTitle,
      responsavel,
      dataHoraEmissao,
      targetEvents,
      totalVendasValor,
      totalVendasFichas,
      repasseBarbearia,
      lucroProprietario,
      splitPercent,
      totalCortesias,
      totalManutencoes
    });
    return;
  }

  const doc = new jsPDFConstructor({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // 1. Cabeçalho Corporativo e Elegante
  doc.setFillColor(15, 23, 42); // Navy Slate
  doc.rect(0, 0, pageWidth, 26, 'F');
  doc.setFillColor(255, 30, 66); // Vermelho Arcade
  doc.rect(0, 26, pageWidth, 2, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('DG TECH ARCADE', 14, 11);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(203, 213, 225);
  doc.text('RELATÓRIO FINANCEIRO & AUDITORIA DE VENDAS', 14, 17);
  doc.text('Ponto: Barbearia • Telemetria Pix Nuvem (24h)', 14, 22);

  // Metadados no canto direito
  doc.setFontSize(7.5);
  doc.setTextColor(226, 232, 240);
  doc.text(`Emissão: ${dataHoraEmissao}`, pageWidth - 14, 11, { align: 'right' });
  doc.text(`Responsável: ${responsavel}`, pageWidth - 14, 16, { align: 'right' });
  doc.text(`Escopo: ${scopeTitle}`, pageWidth - 14, 21, { align: 'right' });

  // 2. Quadro de Indicadores / Cards de Resumo Financeiro
  const startY = 33;
  const cardWidth = (pageWidth - 28 - 9) / 4;
  const cardHeight = 17;

  // Card 1: Faturamento Total
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(34, 197, 94);
  doc.roundedRect(14, startY, cardWidth, cardHeight, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(22, 101, 52);
  doc.text('FATURAMENTO TOTAL', 14 + cardWidth / 2, startY + 4.5, { align: 'center' });
  doc.setFontSize(10.5);
  doc.setTextColor(21, 128, 61);
  doc.text(`R$ ${formatCurrency(totalVendasValor)}`, 14 + cardWidth / 2, startY + 10.5, { align: 'center' });
  doc.setFontSize(6);
  doc.setTextColor(100, 116, 139);
  doc.text(`${totalVendasFichas} fichas vendidas`, 14 + cardWidth / 2, startY + 14.5, { align: 'center' });

  // Card 2: Repasse Barbearia (50%)
  const c2X = 14 + cardWidth + 3;
  doc.setFillColor(254, 252, 232);
  doc.setDrawColor(234, 179, 8);
  doc.roundedRect(c2X, startY, cardWidth, cardHeight, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(133, 77, 14);
  doc.text(`BARBEARIA (${splitPercent}%)`, c2X + cardWidth / 2, startY + 4.5, { align: 'center' });
  doc.setFontSize(10.5);
  doc.setTextColor(161, 98, 7);
  doc.text(`R$ ${formatCurrency(repasseBarbearia)}`, c2X + cardWidth / 2, startY + 10.5, { align: 'center' });
  doc.setFontSize(6);
  doc.setTextColor(100, 116, 139);
  doc.text('Repasse do ponto comercial', c2X + cardWidth / 2, startY + 14.5, { align: 'center' });

  // Card 3: Seu Lucro Líquido (50%)
  const c3X = c2X + cardWidth + 3;
  doc.setFillColor(239, 246, 255);
  doc.setDrawColor(59, 130, 246);
  doc.roundedRect(c3X, startY, cardWidth, cardHeight, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(30, 64, 175);
  doc.text(`SEU LUCRO (${100 - splitPercent}%)`, c3X + cardWidth / 2, startY + 4.5, { align: 'center' });
  doc.setFontSize(10.5);
  doc.setTextColor(29, 78, 216);
  doc.text(`R$ ${formatCurrency(lucroProprietario)}`, c3X + cardWidth / 2, startY + 10.5, { align: 'center' });
  doc.setFontSize(6);
  doc.setTextColor(100, 116, 139);
  doc.text('Lucro líquido fliperama', c3X + cardWidth / 2, startY + 14.5, { align: 'center' });

  // Card 4: Fichas & Movimentação
  const c4X = c3X + cardWidth + 3;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(c4X, startY, cardWidth, cardHeight, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(51, 65, 85);
  doc.text('MOVIMENTAÇÃO TOTAL', c4X + cardWidth / 2, startY + 4.5, { align: 'center' });
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  doc.text(`${totalVendasFichas + totalCortesias} Fichas`, c4X + cardWidth / 2, startY + 10.5, { align: 'center' });
  doc.setFontSize(6);
  doc.setTextColor(100, 116, 139);
  doc.text(`${totalManutencoes} testes • ${totalCortesias} cortesias`, c4X + cardWidth / 2, startY + 14.5, { align: 'center' });

  // 3. Tabela de Transações Organizada por Data, Hora e Valor
  const tableRows = targetEvents.map(evt => {
    const dataStr = evt.data || '--/--/----';
    const horaStr = evt.hora || '--:--:--';
    const clienteStr = evt.cliente || (evt.tipo === 'venda' ? (evt.banco ? `Cliente ${evt.banco}` : 'Cliente Pix') : '—');
    const valorStr = (evt.valor && evt.valor > 0) ? `R$ ${formatCurrency(evt.valor)}` : '—';
    const fichasStr = evt.fichas ? `${evt.fichas} un` : '—';
    const tipoStr = formatEventTypeLabel(evt);
    const descStr = evt.descricao || evt.origem || 'Operação Arcade';
    return [dataStr, horaStr, clienteStr, valorStr, fichasStr, tipoStr, descStr];
  });

  doc.autoTable({
    head: [['DATA', 'HORA', 'CLIENTE / PAGADOR', 'VALOR', 'FICHAS', 'TIPO', 'DESCRIÇÃO / DETALHES']],
    body: tableRows,
    foot: [['TOTAL', '', '', `R$ ${formatCurrency(totalVendasValor)}`, `${totalVendasFichas} un`, '', `${targetEvents.length} registro(s) listado(s)`]],
    startY: 55,
    margin: { left: 14, right: 14, bottom: 18 },
    styles: {
      font: 'helvetica',
      fontSize: 7.2,
      cellPadding: 2,
      overflow: 'linebreak',
      valign: 'middle'
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.8,
      halign: 'left'
    },
    columnStyles: {
      0: { cellWidth: 19, halign: 'center', fontStyle: 'bold' }, // Data
      1: { cellWidth: 16, halign: 'center' }, // Hora
      2: { cellWidth: 32, halign: 'left' }, // Cliente
      3: { cellWidth: 20, halign: 'right', fontStyle: 'bold' }, // Valor
      4: { cellWidth: 14, halign: 'center' }, // Fichas
      5: { cellWidth: 24, halign: 'center' }, // Tipo
      6: { cellWidth: 'auto', halign: 'left' } // Descrição
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252]
    },
    footStyles: {
      fillColor: [241, 245, 249],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
      fontSize: 7.8
    },
    didParseCell: function(data) {
      if (data.section === 'body') {
        const rawRow = targetEvents[data.row.index];
        if (rawRow) {
          if (data.column.index === 3 && rawRow.valor > 0) {
            data.cell.styles.textColor = [22, 101, 52];
          }
          if (rawRow.tipo === 'sangria') {
            data.cell.styles.fillColor = [254, 242, 242];
            if (data.column.index === 5) {
              data.cell.styles.textColor = [185, 28, 28];
              data.cell.styles.fontStyle = 'bold';
            }
          }
        }
      }
    },
    didDrawPage: function(data) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(148, 163, 184);
      doc.text(
        'DG Tech Arcade • Relatório gerencial emitido para prestação de contas com a barbearia',
        14,
        pageHeight - 8
      );
    }
  });

  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(`Página ${i} de ${totalPages}`, pageWidth - 14, pageHeight - 8, { align: 'right' });
  }

  const cleanDate = new Date().toISOString().slice(0, 10);
  const fileName = `Relatorio_DG_Arcade_${scope}_${cleanDate}.pdf`;

  if (mode === 'print') {
    doc.autoPrint();
    const pdfBlob = doc.output('blob');
    const blobUrl = URL.createObjectURL(pdfBlob);
    window.open(blobUrl, '_blank');
  } else {
    doc.save(fileName);
    showToast('📄 Relatório em PDF baixado com sucesso!');
    appendHardwareFeed(`[PDF] Relatório '${fileName}' gerado com sucesso.`);
  }
}

// Geração de Comprovante de Fechamento de Caixa / Sangria em PDF
function generateSangriaPdfReceipt(data) {
  const jsPDFConstructor = window.jspdf?.jsPDF;
  if (!jsPDFConstructor) {
    alert(`Fechamento de Caixa Concluído!\n\nValor recolhido: R$ ${formatCurrency(data.valorRecolhido)}\nFichas encerradas: ${data.fichasFechadas}`);
    return;
  }

  const doc = new jsPDFConstructor({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // Cabeçalho Oficial
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 28, 'F');
  doc.setFillColor(255, 30, 66);
  doc.rect(0, 28, pageWidth, 2.5, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('DG TECH ARCADE', 14, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(203, 213, 225);
  doc.text('COMPROVANTE OFICIAL DE FECHAMENTO DE CAIXA & SANGRIA', 14, 18);
  doc.text('Acerto de Contas Fliperama & Barbearia', 14, 23);

  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text(`Data/Hora: ${data.dataHora}`, pageWidth - 14, 14, { align: 'right' });
  doc.text(`Responsável: ${data.responsavel}`, pageWidth - 14, 20, { align: 'right' });

  // Quadro de Valores
  const y = 37;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(14, y, pageWidth - 28, 36, 3, 3, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text('RESUMO DO RECOLHIMENTO DESTE CAIXA', 20, y + 7.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('Total em Dinheiro Recolhido:', 20, y + 15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 101, 52);
  doc.text(`R$ ${formatCurrency(data.valorRecolhido)}`, 80, y + 15);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text('Fichas Encerradas no Período:', 20, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text(`${data.fichasFechadas} fichas`, 80, y + 22);

  // Divisão dos 50%
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text(`Repasse Barbearia (${data.barberSplitPercent}%):`, 110, y + 15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(161, 98, 7);
  doc.text(`R$ ${formatCurrency(data.barberValor)}`, pageWidth - 20, y + 15, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text(`Lucro Proprietário (${100 - data.barberSplitPercent}%):`, 110, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(29, 78, 216);
  doc.text(`R$ ${formatCurrency(data.ownerValor)}`, pageWidth - 20, y + 22, { align: 'right' });

  if (data.observacao) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`Observações: ${data.observacao}`, 20, y + 30);
  }

  // Tabela com as vendas daquela sessão
  const tableData = (data.events || []).map(e => [
    e.data || '--/--/----',
    e.hora || '--:--',
    e.valor && e.valor > 0 ? `R$ ${formatCurrency(e.valor)}` : '—',
    e.fichas ? `${e.fichas} un` : '—',
    formatEventTypeLabel(e),
    e.descricao || 'Venda Arcade'
  ]);

  if (tableData.length > 0) {
    doc.autoTable({
      head: [['DATA', 'HORA', 'VALOR', 'FICHAS', 'TIPO', 'DISCRIMINAÇÃO DAS VENDAS DESTE CAIXA']],
      body: tableData,
      startY: y + 42,
      margin: { left: 14, right: 14, bottom: 42 },
      styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 20, halign: 'center' },
        1: { cellWidth: 18, halign: 'center' },
        2: { cellWidth: 24, halign: 'right', fontStyle: 'bold' },
        3: { cellWidth: 15, halign: 'center' },
        4: { cellWidth: 25, halign: 'center' },
        5: { cellWidth: 'auto' }
      }
    });
  }

  // Linhas de Assinatura no rodapé
  const finalY = doc.lastAutoTable ? Math.max(doc.lastAutoTable.finalY + 22, pageHeight - 32) : pageHeight - 32;

  doc.setDrawColor(148, 163, 184);
  doc.line(20, finalY, 85, finalY);
  doc.line(pageWidth - 85, finalY, pageWidth - 20, finalY);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);
  doc.text(`${data.responsavel} (Operador / Proprietário)`, 52.5, finalY + 4, { align: 'center' });
  doc.text('Responsável Barbearia (Ponto Comercial)', pageWidth - 52.5, finalY + 4, { align: 'center' });

  const fileName = `Comprovante_Fechamento_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(fileName);
  showToast('📄 Comprovante do fechamento baixado em PDF!');
  appendHardwareFeed(`[PDF] Comprovante de sangria '${fileName}' gerado com sucesso.`);
}

// Fallback caso a biblioteca externa jsPDF não esteja acessível
function fallbackHtmlPrintReport(info) {
  const win = window.open('', '_blank');
  if (!win) {
    alert('Por favor, permita pop-ups para visualizar o relatório para impressão.');
    return;
  }
  const rowsHtml = info.targetEvents.map(e => `
    <tr>
      <td style="text-align:center;">${e.data || '--'}</td>
      <td style="text-align:center;">${e.hora || '--'}</td>
      <td style="text-align:right; font-weight:bold; color:#15803d;">${e.valor ? 'R$ ' + formatCurrency(e.valor) : '—'}</td>
      <td style="text-align:center;">${e.fichas ? e.fichas + ' un' : '—'}</td>
      <td style="text-align:center;">${formatEventTypeLabel(e)}</td>
      <td>${escapeHtml(e.descricao || '')}</td>
    </tr>
  `).join('');

  win.document.write(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>Relatório Financeiro DG Tech Arcade</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; color: #1e293b; }
        .header { border-bottom: 3px solid #ff1e42; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end; }
        h1 { margin: 0; font-size: 22px; color: #0f172a; }
        .cards { display: flex; gap: 12px; margin-bottom: 20px; }
        .card { flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; text-align: center; background: #f8fafc; }
        .card strong { font-size: 16px; display: block; margin: 4px 0; color: #0f172a; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 8px; }
        th { background: #0f172a; color: #fff; }
        tr:nth-child(even) { background: #f8fafc; }
        @media print { .no-print { display: none; } }
      </style>
    </head>
    <body>
      <div class="no-print" style="margin-bottom:15px;">
        <button onclick="window.print()" style="padding:8px 16px; background:#059669; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">🖨️ Imprimir / Salvar como PDF</button>
      </div>
      <div class="header">
        <div>
          <h1>DG TECH ARCADE</h1>
          <div style="font-size:13px; color:#64748b;">Relatório de Vendas e Caixa • Barbearia</div>
        </div>
        <div style="text-align:right; font-size:11px; color:#475569;">
          <div>Emissão: ${info.dataHoraEmissao}</div>
          <div>Responsável: ${info.responsavel}</div>
          <div>Escopo: ${info.scopeTitle}</div>
        </div>
      </div>
      <div class="cards">
        <div class="card"><small>FATURAMENTO TOTAL</small><strong>R$ ${formatCurrency(info.totalVendasValor)}</strong><small>${info.totalVendasFichas} fichas vendidas</small></div>
        <div class="card"><small>BARBEARIA (${info.splitPercent}%)</small><strong>R$ ${formatCurrency(info.repasseBarbearia)}</strong><small>Repasse do ponto</small></div>
        <div class="card"><small>SEU LUCRO (${100 - info.splitPercent}%)</small><strong>R$ ${formatCurrency(info.lucroProprietario)}</strong><small>Lucro líquido</small></div>
      </div>
      <table>
        <thead>
          <tr><th>DATA</th><th>HORA</th><th>VALOR</th><th>FICHAS</th><th>TIPO</th><th>DESCRIÇÃO</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </body>
    </html>
  `);
  win.document.close();
}

// ==========================================================================
// EVENT LISTENERS & INTERATIVIDADE
// ==========================================================================
function initEventListeners() {
  // 1. Botões de Modo de Disparo
  const modePills = document.querySelectorAll('.mode-pill');
  modePills.forEach(pill => {
    pill.addEventListener('click', () => {
      modePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      appState.selectedMode = pill.getAttribute('data-mode') || 'manutencao';
      renderAllData();
      playBlipSound();
    });
  });

  // 2. Botões de Quantidade de Fichas
  const qtyBtns = document.querySelectorAll('.token-qty-btn');
  const customQtyInput = document.getElementById('customQtyInput');

  qtyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      qtyBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = parseInt(btn.getAttribute('data-qty') || '1', 10);
      appState.selectedQty = val;
      if (customQtyInput) customQtyInput.value = val;
      renderAllData();
      playBlipSound();
    });
  });

  if (customQtyInput) {
    customQtyInput.addEventListener('input', () => {
      const val = Math.max(1, Math.min(20, parseInt(customQtyInput.value || '1', 10)));
      appState.selectedQty = val;
      qtyBtns.forEach(b => b.classList.remove('active'));
      renderAllData();
    });
  }

  // 3. Botão Principal: DISPARAR COIN
  const btnFire = document.getElementById('btnAuthorizeCoin');
  if (btnFire) {
    btnFire.addEventListener('click', () => {
      const reqConfirm = document.getElementById('requireConfirmCheckbox')?.checked;
      if (reqConfirm) {
        openConfirmCoinModal();
      } else {
        fireCoinPulse(appState.selectedQty, appState.selectedMode, 'Disparo Remoto Direto');
      }
    });
  }

  // 4. Modal de Confirmação de Coin
  const btnConfirmCoin = document.getElementById('btnConfirmCoin');
  const btnCancelCoin = document.getElementById('btnCancelCoin');
  if (btnConfirmCoin) {
    btnConfirmCoin.addEventListener('click', () => {
      closeModal('confirmCoinModal');
      const reason = document.getElementById('coinAuthReason')?.value || 'Disparo Autorizado';
      fireCoinPulse(appState.selectedQty, appState.selectedMode, reason);
    });
  }
  if (btnCancelCoin) {
    btnCancelCoin.addEventListener('click', () => closeModal('confirmCoinModal'));
  }

  // 5. Botões de Ping e Teste Rápido
  const ipInput = document.getElementById('esp01IpInput');
  if (ipInput) {
    ipInput.value = appState.esp01Ip || '192.168.18.99';
    ipInput.addEventListener('input', (e) => {
      appState.esp01Ip = e.target.value.trim();
      saveLocalState();
    });
  }

  document.getElementById('btnPingEsp01')?.addEventListener('click', () => pingEsp01(false));
  document.getElementById('btnPulse1Test')?.addEventListener('click', () => fireCoinPulse(1, 'manutencao', 'Teste Rápido 1 Ficha'));
  document.getElementById('btnPulse2Test')?.addEventListener('click', () => fireCoinPulse(2, 'manutencao', 'Teste Rápido 2 Fichas'));

  // 6. Modal de Sangria / Fechamento de Caixa
  const openSangria = () => {
    setText('sangriaCashAmount', `R$ ${formatCurrency(appState.sessionCash)}`);
    setText('sangriaTokensAmount', `${appState.sessionTokens} fichas`);
    openModal('sangriaModal');
  };
  document.getElementById('btnOpenSangriaModal')?.addEventListener('click', openSangria);
  document.getElementById('btnQuickSangria')?.addEventListener('click', openSangria);
  document.getElementById('btnCancelSangria')?.addEventListener('click', () => closeModal('sangriaModal'));
  document.getElementById('btnConfirmSangria')?.addEventListener('click', async () => {
    const resp = document.getElementById('sangriaResponsavel')?.value || 'Operador';
    const obs = document.getElementById('sangriaObservacao')?.value || '';
    const shouldGenPdf = document.getElementById('sangriaGeneratePdfCheckbox')?.checked ?? true;
    closeModal('sangriaModal');
    await executeSangria(resp, obs, shouldGenPdf);
  });

  // 7. Modal de Registro Manual
  document.getElementById('btnOpenManualSaleModal')?.addEventListener('click', () => openModal('manualSaleModal'));
  document.getElementById('btnCancelManualSale')?.addEventListener('click', () => closeModal('manualSaleModal'));
  document.getElementById('btnConfirmManualSale')?.addEventListener('click', async () => {
    const fichas = parseInt(document.getElementById('manualSaleFichas')?.value || '1', 10);
    const valor = parseFloat(document.getElementById('manualSaleValor')?.value || '2.50');
    const origem = document.getElementById('manualSaleOrigem')?.value || 'Moedeiro Físico';
    closeModal('manualSaleModal');
    await executeManualSale(fichas, valor, origem);
  });

  // 8. Modal de Configurações
  document.getElementById('settingsModalBtn')?.addEventListener('click', () => {
    const pinEl = document.getElementById('settingsPin');
    const ipEl = document.getElementById('settingsEsp01Ip');
    const priceEl = document.getElementById('inputTokenPrice');
    const soundEl = document.getElementById('inputSoundEnabled');
    const reqPinEl = document.getElementById('requirePinCheckbox');
    const splitEl = document.getElementById('settingsBarberSplit');

    if (pinEl) pinEl.value = appState.securityPin || '1234';
    if (ipEl) ipEl.value = appState.esp01Ip || '192.168.18.99';
    if (priceEl) priceEl.value = appState.tokenPrice || 2.50;
    if (soundEl) soundEl.checked = appState.soundEnabled;
    if (reqPinEl) reqPinEl.checked = appState.requirePin;
    if (splitEl) splitEl.value = appState.barberSplitPercent ?? 50;

    openModal('settingsModal');
  });

  document.getElementById('btnCloseSettings')?.addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('btnSaveSettings')?.addEventListener('click', async () => {
    const newPin = document.getElementById('settingsPin')?.value || '1234';
    const newIp = document.getElementById('settingsEsp01Ip')?.value || '192.168.18.99';
    const newPrice = parseFloat(document.getElementById('inputTokenPrice')?.value || '2.50');
    const newSound = document.getElementById('inputSoundEnabled')?.checked ?? true;
    const reqPin = document.getElementById('requirePinCheckbox')?.checked ?? false;
    const newSplit = parseInt(document.getElementById('settingsBarberSplit')?.value || '50', 10);

    appState.securityPin = newPin;
    appState.esp01Ip = newIp;
    appState.tokenPrice = newPrice;
    appState.soundEnabled = newSound;
    appState.requirePin = reqPin;
    appState.barberSplitPercent = newSplit;

    const quickPin = document.getElementById('pinInputQuick');
    if (quickPin) quickPin.value = newPin;

    saveLocalState();
    closeModal('settingsModal');

    // Envia configurações para o backend Python
    try {
      await fetch(`${getApiBase()}/api/config/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin: newPin,
          require_pin: reqPin,
          price_per_token: newPrice,
          barber_split_percent: newSplit
        })
      });
    } catch (e) {}

    appendHardwareFeed('[CONFIG] Configurações e divisão da barbearia salvas.');
    renderAllData();
  });

  // 9. Sincronização Manual Mercado Pago
  document.getElementById('btnManualSyncMp')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnManualSyncMp');
    if (btn) btn.style.transition = 'transform 0.5s ease';
    if (btn) btn.style.transform = 'rotate(360deg)';
    appendHardwareFeed('[MERCADO PAGO] Verificando pagamentos Pix da barbearia...');

    try {
      const resp = await fetch(`${getApiBase()}/api/mercadopago/sincronizar`);
      const data = await resp.json();
      if (btn) setTimeout(() => { btn.style.transform = 'none'; }, 600);

      if (data.success) {
        playSuccessChime();
        if (data.new_sales > 0) {
          appendHardwareFeed(`[MERCADO PAGO OK] +${data.new_sales} nova(s) venda(s) Pix! Total Caixa: R$ ${formatCurrency(data.session_cash)}`);
          showToast(`💈 +${data.new_sales} vendas Pix sincronizadas!`);
        } else {
          appendHardwareFeed(`[MERCADO PAGO OK] Tudo atualizado! Nenhuma nova venda pendente.`);
          showToast('💈 Mercado Pago: Tudo sincronizado!');
        }
        await fetchServerStatus();
      } else {
        appendHardwareFeed(`[MERCADO PAGO ERRO] ${data.error || 'Falha ao sincronizar'}`);
      }
    } catch (err) {
      if (btn) btn.style.transform = 'none';
      appendHardwareFeed(`[MERCADO PAGO ERRO] ${formatNetworkError(err)}`);
    }
  });

  // 10. Modal de QR Code para Celular 4G/5G
  document.getElementById('btnOpenQrModal')?.addEventListener('click', async () => {
    openModal('qrModal');
    const input = document.getElementById('tunnelUrlInput');
    const img = document.getElementById('qrCodeImg');
    try {
      const resp = await fetch(`${getApiBase()}/api/tunnel/url`);
      const data = await resp.json();
      const liveUrl = (data && data.url) ? data.url : window.location.href;
      if (input) input.value = liveUrl;
      if (img && data && data.url) {
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.url)}`;
      }
    } catch (e) {
      if (input) input.value = window.location.href;
    }
  });

  document.getElementById('btnCloseQrModal')?.addEventListener('click', () => closeModal('qrModal'));
  document.getElementById('btnCopyTunnelUrl')?.addEventListener('click', () => {
    const input = document.getElementById('tunnelUrlInput');
    if (input && input.value) {
      navigator.clipboard.writeText(input.value).then(() => {
        const btn = document.getElementById('btnCopyTunnelUrl');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = 'Copiado!';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }
      }).catch(() => {
        input.select();
        document.execCommand('copy');
      });
    }
  });

  // 11. Relatório em PDF & Exportação CSV
  document.getElementById('btnOpenPdfReportModal')?.addEventListener('click', () => {
    setText('pdfModalSessionCash', `R$ ${formatCurrency(appState.sessionCash)}`);
    setText('pdfModalGeneralCash', `R$ ${formatCurrency(appState.generalCash)}`);
    setText('pdfModalTotalEvents', `${appState.events.length} transações`);
    const respInput = document.getElementById('pdfReportResponsavel');
    if (respInput && !respInput.value) respInput.value = 'Daniel';
    openModal('pdfReportModal');
  });

  document.getElementById('btnCancelPdfReport')?.addEventListener('click', () => closeModal('pdfReportModal'));

  document.getElementById('btnGeneratePdfDownload')?.addEventListener('click', () => {
    const scope = document.getElementById('pdfReportScope')?.value || 'all';
    const sort = document.getElementById('pdfReportSort')?.value || 'desc';
    const responsavel = document.getElementById('pdfReportResponsavel')?.value || 'Daniel';
    closeModal('pdfReportModal');
    generatePdfReport({ scope, sort, responsavel, mode: 'download' });
  });

  document.getElementById('btnPrintPdfReport')?.addEventListener('click', () => {
    const scope = document.getElementById('pdfReportScope')?.value || 'all';
    const sort = document.getElementById('pdfReportSort')?.value || 'desc';
    const responsavel = document.getElementById('pdfReportResponsavel')?.value || 'Daniel';
    closeModal('pdfReportModal');
    generatePdfReport({ scope, sort, responsavel, mode: 'print' });
  });

  document.getElementById('btnExportCsv')?.addEventListener('click', exportLogsCsv);

  // 12. Filtros da Tabela de Logs
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.getAttribute('data-filter') || 'all';
      renderLogsTable();
      playBlipSound();
    });
  });

  document.getElementById('logSearchInput')?.addEventListener('input', renderLogsTable);

  // 13. Alternar Som
  document.getElementById('toggleSoundBtn')?.addEventListener('click', () => {
    appState.soundEnabled = !appState.soundEnabled;
    const icon = document.getElementById('soundIcon');
    if (icon) icon.textContent = appState.soundEnabled ? '🔊' : '🔇';
    saveLocalState();
    if (appState.soundEnabled) playCoinSound();
  });
}

function openConfirmCoinModal() {
  const modeText = appState.selectedMode === 'venda' ? 'Venda Manual (Soma no faturamento)' :
                   appState.selectedMode === 'cortesia' ? 'Cortesia / Bônus (Não altera o caixa)' :
                   'Manutenção Técnica / Teste (Não altera o caixa)';
  setText('confirmModalModeHighlight', `Modo: ${modeText}`);
  setText('confirmModalDesc', `Você está prestes a disparar ${appState.selectedQty} crédito(s) físico(s) no relé.`);
  openModal('confirmCoinModal');
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('open');
    el.classList.add('active');
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('open');
    el.classList.remove('active');
  }
}

// ==========================================================================
// FEED DE LOG E EFEITOS VISUAIS
// ==========================================================================
function appendHardwareFeed(msg) {
  const feed = document.getElementById('hardwareFeed');
  if (!feed) return;
  const timeStr = new Date().toLocaleTimeString('pt-BR');
  const line = document.createElement('div');
  line.className = 'feed-line';
  line.innerHTML = `<span class="feed-time">${timeStr}</span> ${escapeHtml(msg)}`;
  feed.insertBefore(line, feed.firstChild);
  while (feed.children.length > 40) {
    feed.removeChild(feed.lastChild);
  }
}

function triggerScreenFlash() {
  const body = document.body;
  body.classList.add('screen-flash');
  setTimeout(() => body.classList.remove('screen-flash'), 250);
}

function initClock() {
  const clockEl = document.getElementById('systemClock');
  if (!clockEl) return;
  const update = () => {
    clockEl.textContent = new Date().toLocaleTimeString('pt-BR');
  };
  update();
  setInterval(update, 1000);
}

// ==========================================================================
// MOTOR DE ÁUDIO RETRÔ (WEB AUDIO API SINTETIZADA)
// ==========================================================================
function initAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  } catch (e) {
    console.warn('Web Audio API não suportada');
  }
}

function playCoinSound() {
  if (!appState.soundEnabled || !audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    const now = audioCtx.currentTime;
    osc.frequency.setValueAtTime(987.77, now); // B5
    osc.frequency.setValueAtTime(1318.51, now + 0.08); // E6
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch (e) {}
}

function playSuccessChime() {
  if (!appState.soundEnabled || !audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  try {
    const notes = [523.25, 659.25, 783.99, 1046.50];
    const now = audioCtx.currentTime;
    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);
      gain.gain.setValueAtTime(0.15, now + idx * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.25);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.26);
    });
  } catch (e) {}
}

function playBlipSound() {
  if (!appState.soundEnabled || !audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    const now = audioCtx.currentTime;
    osc.frequency.setValueAtTime(440, now);
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  } catch (e) {}
}

function playBuzzerSound() {
  if (!appState.soundEnabled || !audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    const now = audioCtx.currentTime;
    osc.frequency.setValueAtTime(150, now);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.26);
  } catch (e) {}
}

// ==========================================================================
// UTILITÁRIOS
// ==========================================================================
function formatCurrency(val) {
  return Number(val || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function showToast(msg) {
  const existing = document.querySelectorAll('.toast-notification');
  existing.forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.innerHTML = `<span>⚡</span> <span>${escapeHtml(msg)}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 400);
  }, 4500);
}

