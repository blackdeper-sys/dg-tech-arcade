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
    const resp = await fetch(`${getApiBase()}/api/vendas/status`);
    if (!resp.ok) return;
    const res = await resp.json();
    if (res.success && res.data) {
      const s = res.data;
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
async function fireCoinPulse(qtd, modo, motivo = 'Disparo Remoto') {
  const ip = getEsp01Ip();
  const pin = getPin();

  appendHardwareFeed(`[ESP-01S] Enviando disparo de ${qtd} ficha(s) (Modo: ${modo.toUpperCase()}) para ${ip}...`);

  try {
    const url = `${getApiBase()}/api/esp01/credito?ip=${encodeURIComponent(ip)}&qtd=${qtd}&modo=${modo}&motivo=${encodeURIComponent(motivo)}&pin=${encodeURIComponent(pin)}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (resp.status === 403) {
      playBuzzerSound();
      appendHardwareFeed(`[SEGURANÇA] PIN incorreto! Verifique o PIN de acesso.`);
      alert('PIN de segurança incorreto! Verifique a senha de acesso.');
      return false;
    }

    if (data.success) {
      playCoinSound();
      triggerScreenFlash();

      appState.authorizedCoinsToday += qtd;
      appState.lastCoinTime = new Date().toLocaleTimeString('pt-BR');

      if (data.event) {
        appState.events.unshift(data.event);
        if (appState.events.length > 300) appState.events.pop();
        lastTelemetryEventId = Math.max(lastTelemetryEventId, data.event.id);
      }

      // Atualiza estado financeiro local
      const valor = qtd * appState.tokenPrice;
      if (modo === 'venda') {
        appState.sessionCash += valor;
        appState.sessionTokens += qtd;
        appState.paidTokens += qtd;
        appState.generalTokens += qtd;
        appState.generalCash += valor;
        appendHardwareFeed(`[VENDA SUCESSO] ${qtd} ficha(s) liberada(s) (R$ ${formatCurrency(valor)})!`);
      } else if (modo === 'cortesia') {
        appState.courtesyTokens += qtd;
        appState.generalTokens += qtd;
        appendHardwareFeed(`[CORTESIA SUCESSO] ${qtd} ficha(s) cortesia liberada(s)!`);
      } else {
        appState.maintenanceTokens += qtd;
        appendHardwareFeed(`[MANUTENÇÃO SUCESSO] ${qtd} ficha(s) técnica(s) disparada(s) no relé!`);
      }

      saveLocalState();
      renderAllData();
      return true;
    } else {
      playBuzzerSound();
      appendHardwareFeed(`[ESP-01S FALHA] Erro: ${data.error || 'Sem resposta do relé'}`);
      return false;
    }
  } catch (err) {
    playBuzzerSound();
    appendHardwareFeed(`[ESP-01S ERRO] ${formatNetworkError(err)}`);
    return false;
  }
}

// Testar conexão com o ESP-01S (Ping)
async function pingEsp01(silent = false) {
  const ip = getEsp01Ip();
  if (!silent) appendHardwareFeed(`[ESP-01S] Testando conexão com IP ${ip}...`);

  try {
    const resp = await fetch(`${getApiBase()}/api/esp01/ping?ip=${encodeURIComponent(ip)}`);
    const data = await resp.json();

    const badge = document.getElementById('esp01StatusBadge');
    const text = document.getElementById('esp01StatusText');

    if (data.online) {
      if (badge) badge.className = 'status-indicator online';
      if (text) text.textContent = 'ONLINE';
      if (!silent) {
        playCoinSound();
        appendHardwareFeed(`[ESP-01S OK] Módulo Relé ONLINE no IP ${ip}!`);
      }
      return true;
    } else {
      if (badge) badge.className = 'status-indicator offline';
      if (text) text.textContent = 'OFFLINE';
      if (!silent) appendHardwareFeed(`[ESP-01S OFFLINE] Não respondeu no IP ${ip}.`);
      return false;
    }
  } catch (err) {
    if (!silent) appendHardwareFeed(`[ESP-01S ERRO] ${formatNetworkError(err)}`);
    return false;
  }
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
async function executeSangria(responsavel, observacao) {
  appendHardwareFeed(`[SANGRIA] Realizando fechamento de caixa por ${responsavel}...`);
  try {
    const resp = await fetch(`${getApiBase()}/api/vendas/sangria`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responsavel, observacao })
    });
    const data = await resp.json();
    if (data.success) {
      playSuccessChime();
      appState.sessionCash = 0.00;
      appState.sessionTokens = 0;
      appState.paidTokens = 0;
      appState.courtesyTokens = 0;

      if (data.event) {
        appState.events.unshift(data.event);
      }

      saveLocalState();
      renderAllData();
      appendHardwareFeed(`[SANGRIA CONCLUÍDA] R$ ${formatCurrency(data.valor_recolhido)} recolhido com sucesso!`);
      alert(`Fechamento de Caixa Concluído!\n\nValor recolhido: R$ ${formatCurrency(data.valor_recolhido)}\nFichas encerradas: ${data.fichas_fechadas}`);
      return true;
    } else {
      appendHardwareFeed(`[SANGRIA ERRO] Falha: ${data.error}`);
      return false;
    }
  } catch (err) {
    appendHardwareFeed(`[SANGRIA ERRO] ${formatNetworkError(err)}`);
    return false;
  }
}

async function executeManualSale(fichas, valor, origem) {
  appendHardwareFeed(`[ENTRADA MANUAL] Registrando ${fichas} ficha(s) (R$ ${formatCurrency(valor)})...`);
  try {
    const resp = await fetch(`${getApiBase()}/api/vendas/registrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fichas, valor, origem })
    });
    const data = await resp.json();
    if (data.success) {
      playSuccessChime();
      appState.sessionCash += valor;
      appState.sessionTokens += fichas;
      appState.paidTokens += fichas;
      appState.generalTokens += fichas;
      appState.generalCash += valor;

      if (data.event) {
        appState.events.unshift(data.event);
      }

      saveLocalState();
      renderAllData();
      appendHardwareFeed(`[ENTRADA REGISTRADA] R$ ${formatCurrency(valor)} adicionado ao caixa.`);
      return true;
    }
  } catch (err) {
    appendHardwareFeed(`[REGISTRO ERRO] ${formatNetworkError(err)}`);
    return false;
  }
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
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">Nenhum registro encontrado para este filtro.</td></tr>`;
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

    return `
      <tr>
        <td class="log-time">${evt.hora || '--:--'} <small class="text-muted">${evt.data || ''}</small></td>
        <td><span class="event-badge ${badgeClass}">${badgeLabel}</span></td>
        <td class="log-desc">${escapeHtml(evt.descricao || '')}</td>
        <td class="log-tokens font-mono">${fichasStr}</td>
        <td class="log-value font-mono text-green">${valorStr}</td>
        <td class="log-origin text-muted">${escapeHtml(evt.origem || 'Remoto')}</td>
      </tr>
    `;
  }).join('');
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
    closeModal('sangriaModal');
    await executeSangria(resp, obs);
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

  // 11. Exportar CSV
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
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('open');
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

