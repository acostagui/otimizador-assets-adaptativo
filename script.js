/**
 * Otimizador de Assets Adaptativo
 * Uso da Network Information API (navigator.connection) + Speed Test em tempo real
 * para tomada de decisão dinâmica no carregamento de imagens (4G, 3G, 2G).
 */

const connection =
  navigator.connection ||
  navigator.mozConnection ||
  navigator.webkitConnection ||
  null;

const TOTAL_BASE_BYTES = 1065512;
const dom = {};

/**
 * Retorna dinamicamente o caminho do asset conforme a qualidade da rede (2G / 3G / 4G)
 */
function getAdaptiveAssetPath(baseName, overrideTier) {
  const effectiveType = overrideTier || (connection ? connection.effectiveType : '4g');
  if (!overrideTier && connection?.saveData) return `assets/${baseName}-2g.jpg`;

  if (effectiveType === '2g' || effectiveType === 'slow-2g') {
    return `assets/${baseName}-2g.jpg`;
  } else if (effectiveType === '3g') {
    return `assets/${baseName}-3g.jpg`;
  }

  return `assets/${baseName}-4g.jpg`;
}

const ASSETS = [
  { id: '1', sizes: { '4g': 89064,  '3g': 8150,  '2g': 1275 }, currentTier: '4g' },
  { id: '2', sizes: { '4g': 232729, '3g': 16115, '2g': 1836 }, currentTier: '4g' },
  { id: '3', sizes: { '4g': 227164, '3g': 13279, '2g': 1548 }, currentTier: '4g' },
  { id: '4', sizes: { '4g': 150714, '3g': 15419, '2g': 1746 }, currentTier: '4g' },
  { id: '5', sizes: { '4g': 94878,  '3g': 8282,  '2g': 1282 }, currentTier: '4g' },
  { id: '6', sizes: { '4g': 270963, '3g': 20126, '2g': 2149 }, currentTier: '4g' }
];

const TIERS = {
  '4g': { label: 'Alta Resolução (4G)',  res: '1920×1200 px', badge: '4G · 1920×1200', cls: 'b-4g', color: '#15803d' },
  '3g': { label: 'Média Resolução (3G)', res: '640×400 px',   badge: '3G · 640×400',  cls: 'b-3g', color: '#b45309' },
  '2g': { label: 'Baixa Resolução (2G)', res: '160×100 px',   badge: '2G · 160×100',  cls: 'b-2g', color: '#b91c1c' }
};

const state = {
  mode: 'auto',
  compareMode: '4g-2g',
  selectedId: '1',
  zoom: false,
  customUpload: null,
  liveMbps: connection?.downlink ?? 10,
  livePingMs: connection?.rtt ?? 45,
  isMeasuring: false,
  liveLoop: false
};

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function classifyMbpsToTier(mbps, apiType, respectSaveData = false) {
  if (respectSaveData && connection?.saveData) return '2g';
  if (apiType === 'slow-2g' || apiType === '2g' || mbps < 0.6) return '2g';
  if (apiType === '3g' || mbps < 2.5) return '3g';
  return '4g';
}

/**
 * Desenha o velocímetro SVG de acordo com o valor de Mbps
 */
function setGaugeValue(mbps, tier, statusText) {
  const arc = dom.gaugeArc || document.getElementById('gaugeArc');
  const valEl = dom.valSpeed || document.getElementById('valSpeed');
  const statusEl = dom.speedTestStatus || document.getElementById('speedTestStatus');

  valEl.textContent = Number(mbps).toFixed(1);
  if (statusText) statusEl.textContent = statusText;

  const maxArc = 251.2;
  let ratio = 0;
  if (mbps <= 0.6) {
    ratio = (mbps / 0.6) * 0.22;
  } else if (mbps <= 2.5) {
    ratio = 0.22 + ((mbps - 0.6) / 1.9) * 0.23;
  } else {
    // Escala logarítmica para 4G / fibra (2.5 Mbps até 500+ Mbps)
    const logVal = Math.log10(mbps / 2.5) / Math.log10(500 / 2.5);
    ratio = 0.45 + Math.min(0.55, Math.max(0, logVal) * 0.55);
  }

  const offset = maxArc - maxArc * Math.max(0.03, Math.min(1, ratio));
  arc.style.strokeDashoffset = offset.toFixed(1);
  arc.style.stroke = TIERS[tier].color;

  ['2g', '3g', '4g'].forEach((t) => {
    const pill = dom[`zone_${t}`] || document.getElementById(`zone-${t}`);
    pill.className = `zone-pill ${t === tier ? `active-${t}` : ''}`;
  });
}

let activeMeasureAbort = null;

/**
 * Mede a latência real (Ping/RTT) após aquecer a conexão TLS/HTTP2
 */
async function measureRealPing(signal) {
  const pingUrl = () => `https://speed.cloudflare.com/__down?bytes=0&t=${Date.now()}-${Math.random()}`;
  // Warm-up para eliminar custo de DNS/TLS da medição de ping
  await fetch(pingUrl(), { cache: 'no-store', signal });

  let bestPing = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await fetch(pingUrl(), { cache: 'no-store', signal });
    const dt = performance.now() - t0;
    if (dt < bestPing) bestPing = dt;
  }
  return Math.max(1, Math.round(bestPing));
}

/**
 * Baixa um fluxo em streaming acumulando bytes em tempo real
 */
async function streamDownload(bytes, signal, onChunk) {
  const url = `https://speed.cloudflare.com/__down?bytes=${bytes}&t=${Date.now()}-${Math.random()}`;
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) onChunk(value.byteLength);
    }
  } else {
    const buf = await res.arrayBuffer();
    onChunk(buf.byteLength);
  }
}

/**
 * Executa Speed Test real multi-stream (Cloudflare) com atualização ao vivo no velocímetro
 */
async function measureRealInternetSpeed(isCompact = false) {
  if (state.isMeasuring) return;
  state.isMeasuring = true;

  const btn = document.getElementById('btnMeasureNow');
  btn.disabled = true;
  btn.textContent = 'Medindo...';

  const controller = new AbortController();
  activeMeasureAbort = controller;

  let measuredMbps = connection?.downlink ?? 10;
  let measuredPing = connection?.rtt ?? 45;

  try {
    setGaugeValue(state.liveMbps || 0, classifyMbpsToTier(state.liveMbps || 10, '4g'), 'Medindo ping...');
    measuredPing = await measureRealPing(controller.signal);
    state.livePingMs = measuredPing;
    document.getElementById('valPing').textContent = `${measuredPing} ms`;

    // 1) Sonda rápida (250 KB) para detectar se a rede é lenta (2G/3G) ou rápida (4G/Fibra)
    let probeBytes = 0;
    const probeStart = performance.now();
    const probeCtrl = new AbortController();
    const probeTimer = setTimeout(() => probeCtrl.abort(), 2200);
    const onAbortAll = () => probeCtrl.abort();
    controller.signal.addEventListener('abort', onAbortAll, { once: true });

    try {
      await streamDownload(250_000, probeCtrl.signal, (n) => {
        probeBytes += n;
        const sec = Math.max(0.05, (performance.now() - probeStart) / 1000);
        const live = (probeBytes * 8) / (sec * 1_000_000);
        setGaugeValue(live, classifyMbpsToTier(live, '4g'), 'Medindo...');
      });
    } catch (err) {
      if (controller.signal.aborted) throw err;
    } finally {
      clearTimeout(probeTimer);
      controller.signal.removeEventListener('abort', onAbortAll);
    }

    const probeSec = Math.max(0.01, (performance.now() - probeStart) / 1000);
    const probeMbps = probeBytes > 0 ? (probeBytes * 8) / (probeSec * 1_000_000) : measuredMbps;

    if (probeMbps < 1.2 && probeSec >= 1.5) {
      // Rede muito lenta (2G/3G real ou throttling): sonda já dá leitura precisa sem travar
      measuredMbps = Number(Math.max(0.1, probeMbps).toFixed(2));
    } else {
      // 2) Teste sustentado com múltiplos fluxos paralelos (satura TCP como Speedtest real)
      const streams = probeMbps > 15 ? 4 : 2;
      const bytesPerStream = probeMbps > 30 ? 12_000_000 : probeMbps > 8 ? 4_000_000 : 1_500_000;
      const maxDurationMs = isCompact ? 1500 : 2800;
      const warmupMs = 300;

      let totalBytes = 0;
      let steadyBytes = 0;
      let steadyStart = null;
      const testStart = performance.now();

      const testCtrl = new AbortController();
      const testTimer = setTimeout(() => testCtrl.abort(), maxDurationMs);
      const onParentAbort = () => testCtrl.abort();
      controller.signal.addEventListener('abort', onParentAbort, { once: true });

      let lastUiUpdate = 0;
      const handleChunk = (n) => {
        const now = performance.now();
        totalBytes += n;
        const elapsed = now - testStart;

        if (elapsed >= warmupMs) {
          if (steadyStart === null) steadyStart = now;
          steadyBytes += n;
        }

        if (now - lastUiUpdate >= 90) {
          lastUiUpdate = now;
          const useSteady = steadyStart !== null && now - steadyStart >= 250;
          const b = useSteady ? steadyBytes : totalBytes;
          const s = Math.max(0.05, (useSteady ? now - steadyStart : elapsed) / 1000);
          const curMbps = (b * 8) / (s * 1_000_000);
          setGaugeValue(curMbps, classifyMbpsToTier(curMbps, '4g'), 'Medindo...');
        }
      };

      const tasks = Array.from({ length: streams }, () =>
        streamDownload(bytesPerStream, testCtrl.signal, handleChunk).catch(() => {})
      );
      await Promise.all(tasks);

      clearTimeout(testTimer);
      controller.signal.removeEventListener('abort', onParentAbort);
      if (controller.signal.aborted) throw new Error('Aborted');

      const endNow = performance.now();
      const useSteady = steadyStart !== null && endNow - steadyStart >= 300 && steadyBytes > 0;
      const finalBytes = useSteady ? steadyBytes : totalBytes;
      const finalSec = Math.max(0.05, (useSteady ? endNow - steadyStart : endNow - testStart) / 1000);

      if (finalBytes > 0) {
        const rawMbps = (finalBytes * 8) / (finalSec * 1_000_000);
        measuredMbps = Number(Math.max(0.1, rawMbps).toFixed(1));
      } else {
        measuredMbps = Number(Math.max(0.1, probeMbps).toFixed(1));
      }
    }

    state.liveMbps = measuredMbps;
    state.livePingMs = measuredPing;
  } catch (err) {
    if (!controller.signal.aborted) {
      state.liveMbps = connection?.downlink ?? 10;
      state.livePingMs = connection?.rtt ?? 50;
    }
  } finally {
    if (activeMeasureAbort === controller) activeMeasureAbort = null;
    state.isMeasuring = false;
    btn.disabled = false;
    btn.textContent = 'Medir Velocidade Real';
    if (!controller.signal.aborted) {
      applyNetworkToAll();
    }
  }
}

function getNetworkDecision() {
  const apiEffectiveType = connection?.effectiveType || '4g';
  let downlink = state.liveMbps;
  let ping = state.livePingMs;
  let tier = '4g';

  if (state.mode !== 'auto') {
    tier = state.mode;
    if (state.mode === '4g') { downlink = 24.5; ping = 28; }
    if (state.mode === '3g') { downlink = 1.4;  ping = 210; }
    if (state.mode === '2g') { downlink = 0.25; ping = 780; }
  } else {
    tier = classifyMbpsToTier(downlink, apiEffectiveType, true);
  }

  return {
    apiEffectiveType,
    downlink,
    ping,
    tier,
    info: TIERS[tier]
  };
}

function updateDashboardUI() {
  const net = getNetworkDecision();
  const totalBase = TOTAL_BASE_BYTES;
  const totalCurrent = ASSETS.reduce((acc, a) => acc + a.sizes[a.currentTier], 0);
  const savedBytes = Math.max(0, totalBase - totalCurrent);
  const savedPct = Math.round((savedBytes / totalBase) * 100);
  const usedPct = Math.max(2, Math.round((totalCurrent / totalBase) * 100));

  setGaugeValue(
    net.downlink,
    net.tier,
    state.mode === 'auto' ? 'Rede Real' : `Simulando ${net.tier.toUpperCase()}`
  );

  dom.valApiType.textContent =
    state.mode === 'auto'
      ? `effectiveType: ${net.apiEffectiveType}${connection?.saveData ? ' · Save-Data' : ''}`
      : `Forçado: ${net.tier}`;
  dom.valPing.textContent = `${net.ping} ms`;

  dom.valDecision.textContent = net.info.label;
  dom.valResolution.textContent = net.info.res;

  dom.valConsumption.textContent = formatKB(totalCurrent);
  dom.valBaseRef.textContent = `Sem otimizador (4G): ${formatKB(totalBase)}`;

  dom.valSavings.textContent = savedPct > 0 ? `-${savedPct}%` : '0%';
  dom.valSavedKB.textContent =
    savedBytes > 0 ? `${formatKB(savedBytes)} economizados` : 'Qualidade máxima ativa';

  dom.valBarRatio.textContent =
    `${100 - savedPct}% (${formatKB(totalCurrent)} de ${formatKB(totalBase)})`;
  dom.compBarFill.style.width = `${usedPct}%`;
  dom.compBarFill.style.backgroundColor = TIERS[net.tier].color;
}

function applyCardTier(asset, tier) {
  asset.currentTier = tier;
  const info = TIERS[tier];

  const img = document.getElementById(`img-${asset.id}`);
  const badge = document.getElementById(`badge-${asset.id}`);
  const meta = document.getElementById(`meta-${asset.id}`);
  const btn = document.querySelector(`.btn-upgrade-hd[data-id="${asset.id}"]`);

  if (img.dataset.loadedTier !== tier) {
    img.src = getAdaptiveAssetPath(`foto-${asset.id}`, tier);
    img.dataset.loadedTier = tier;
  }
  badge.textContent = info.badge;
  badge.className = `badge ${info.cls}`;

  const cur = asset.sizes[tier];
  const base = asset.sizes['4g'];
  const pct = Math.round(((base - cur) / base) * 100);

  meta.textContent =
    tier === '4g' ? `${formatKB(cur)} (Original)` : `${formatKB(cur)} (-${pct}%)`;

  btn.disabled = tier === '4g';
  btn.textContent = tier === '4g' ? 'Em 4G' : 'Ver 4G';
}

function renderComparator() {
  const grid = document.getElementById('compareGrid');
  let tiers = ['4g', '2g'];
  if (state.compareMode === '4g-3g') tiers = ['4g', '3g'];
  else if (state.compareMode === '3g-2g') tiers = ['3g', '2g'];
  else if (state.compareMode === 'all') tiers = ['4g', '3g', '2g'];

  grid.className = `compare-grid cols-${tiers.length}`;

  const isCustom = state.selectedId === 'custom' && state.customUpload;
  const asset = ASSETS.find((a) => a.id === state.selectedId) || ASSETS[0];
  const baseBytes = isCustom ? state.customUpload['4g'].bytes : asset.sizes['4g'];

  grid.innerHTML = tiers
    .map((tier) => {
      const info = TIERS[tier];
      const src = isCustom ? state.customUpload[tier].url : `assets/foto-${asset.id}-${tier}.jpg`;
      const bytes = isCustom ? state.customUpload[tier].bytes : asset.sizes[tier];
      const pct = Math.round(((baseBytes - bytes) / baseBytes) * 100);
      const sizeText = tier === '4g' ? formatKB(bytes) : `${formatKB(bytes)} (-${pct}%)`;

      return `
        <div class="compare-item">
          <div class="compare-head">
            <strong>${tier.toUpperCase()} · ${info.res}</strong>
            <span>${sizeText}</span>
          </div>
          <div class="compare-img ${state.zoom ? 'zoomed' : ''}">
            <img src="${src}" alt="${info.label}" decoding="async" />
          </div>
        </div>
      `;
    })
    .join('');
}

function applyNetworkToAll() {
  const net = getNetworkDecision();
  ASSETS.forEach((asset) => applyCardTier(asset, net.tier));
  updateDashboardUI();
  renderComparator();
}

function handleUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = async () => {
      const encode = (w, h, q) =>
        new Promise((resolve) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          c.toBlob((b) => resolve({ url: URL.createObjectURL(b), bytes: b.size }), 'image/jpeg', q);
        });

      if (state.customUpload) {
        Object.values(state.customUpload).forEach((item) => URL.revokeObjectURL(item.url));
      }
      state.customUpload = {
        '4g': await encode(1920, 1200, 0.9),
        '3g': await encode(640, 400, 0.55),
        '2g': await encode(160, 100, 0.25)
      };

      const sel = document.getElementById('selectCompareAsset');
      let opt = sel.querySelector('option[value="custom"]');
      if (!opt) {
        opt = document.createElement('option');
        opt.value = 'custom';
        sel.prepend(opt);
      }
      opt.textContent = `Foto enviada (${file.name})`;
      sel.value = 'custom';
      state.selectedId = 'custom';

      document.querySelectorAll('.asset-card').forEach((c) => c.classList.remove('active-card'));
      renderComparator();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function cacheDomRefs() {
  [
    'gaugeArc',
    'valSpeed',
    'speedTestStatus',
    'valApiType',
    'valPing',
    'valDecision',
    'valResolution',
    'valConsumption',
    'valBaseRef',
    'valSavings',
    'valSavedKB',
    'valBarRatio',
    'compBarFill'
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
  ['2g', '3g', '4g'].forEach((t) => {
    dom[`zone_${t}`] = document.getElementById(`zone-${t}`);
  });
}

function init() {
  cacheDomRefs();
  applyNetworkToAll();
  measureRealInternetSpeed();

  setInterval(() => {
    if (state.mode === 'auto' && state.liveLoop && !document.hidden) {
      measureRealInternetSpeed(true);
    }
  }, 5000);

  document.getElementById('btnMeasureNow').addEventListener('click', () => {
    if (state.mode !== 'auto') {
      document.querySelectorAll('#modeButtons .seg-btn').forEach((b) => b.classList.remove('active'));
      document.querySelector('#modeButtons .seg-btn[data-mode="auto"]').classList.add('active');
      state.mode = 'auto';
    }
    measureRealInternetSpeed(false);
  });

  document.getElementById('chkLiveLoop').addEventListener('change', (e) => {
    state.liveLoop = e.target.checked;
    if (state.liveLoop && state.mode === 'auto') {
      measureRealInternetSpeed(true);
    }
  });

  document.querySelectorAll('#modeButtons .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#modeButtons .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.getAttribute('data-mode');
      if (state.mode === 'auto') {
        measureRealInternetSpeed(false);
      } else {
        if (activeMeasureAbort) activeMeasureAbort.abort();
        applyNetworkToAll();
      }
    });
  });

  document.querySelectorAll('#compareModeButtons .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#compareModeButtons .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.compareMode = btn.getAttribute('data-comp');
      renderComparator();
    });
  });

  document.getElementById('selectCompareAsset').addEventListener('change', (e) => {
    state.selectedId = e.target.value;
    document.querySelectorAll('.asset-card').forEach((card) => {
      card.classList.toggle('active-card', card.getAttribute('data-id') === state.selectedId);
    });
    renderComparator();
  });

  document.getElementById('chkZoomCompare').addEventListener('change', (e) => {
    state.zoom = e.target.checked;
    renderComparator();
  });

  document.getElementById('fileUploadInput').addEventListener('change', (e) => {
    handleUpload(e.target.files[0]);
  });

  document.querySelectorAll('.asset-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-upgrade-hd')) return;
      const id = card.getAttribute('data-id');
      state.selectedId = id;
      document.getElementById('selectCompareAsset').value = id;
      document.querySelectorAll('.asset-card').forEach((c) => c.classList.remove('active-card'));
      card.classList.add('active-card');
      renderComparator();
    });
  });

  document.querySelectorAll('.btn-upgrade-hd').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const asset = ASSETS.find((a) => a.id === id);
      if (!asset) return;
      applyCardTier(asset, '4g');
      updateDashboardUI();
    });
  });

  if (connection && typeof connection.addEventListener === 'function') {
    connection.addEventListener('change', () => {
      if (state.mode === 'auto') measureRealInternetSpeed();
    });
  }

  initPWA();
  initBottomNav();
}

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btnInstall = document.getElementById('btnInstallApp');
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (!isStandalone && btnInstall) {
    btnInstall.hidden = false;
  }
});

/**
 * Configura recursos de PWA (Service Worker + botão de instalar como App)
 */
function initPWA() {
  const isSecureContextForSW =
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';

  if ('serviceWorker' in navigator && isSecureContextForSW) {
    const registerSW = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (document.readyState === 'complete') {
      registerSW();
    } else {
      window.addEventListener('load', registerSW);
    }
  }

  const btnInstall = document.getElementById('btnInstallApp');
  const modal = document.getElementById('installModal');
  const modalText = document.getElementById('installModalText');
  const btnClose = document.getElementById('btnCloseInstallModal');
  const btnOk = document.getElementById('btnOkInstallModal');

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (!isStandalone && (isIOS || deferredInstallPrompt) && btnInstall) {
    btnInstall.hidden = false;
  }

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (btnInstall) btnInstall.hidden = true;
  });

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        btnInstall.hidden = true;
      } else if (modal) {
        if (isIOS && modalText) {
          modalText.innerHTML =
            'No Safari (iPhone/iPad), toque no botão <strong>Compartilhar</strong> na barra inferior e escolha <strong>Adicionar à Tela de Início</strong>.';
        }
        modal.hidden = false;
      }
    });
  }

  const closeModal = () => {
    if (modal) modal.hidden = true;
  };
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnOk) btnOk.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }
}

/**
 * Navegação inferior estilo aplicativo em telas móveis
 */
function initBottomNav() {
  const navButtons = Array.from(document.querySelectorAll('.bottom-nav-btn'));
  if (!navButtons.length) return;

  const setActive = (targetId) => {
    navButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-target') === targetId);
    });
  };

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const section = document.getElementById(targetId);
      setActive(targetId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  if ('IntersectionObserver' in window) {
    const sections = ['sec-monitor', 'sec-comparador', 'sec-galeria']
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-25% 0px -55% 0px', threshold: [0.1, 0.35, 0.6] }
    );

    sections.forEach((sec) => observer.observe(sec));
  }
}

document.addEventListener('DOMContentLoaded', init);
