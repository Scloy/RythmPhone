// Página do celular: conecta no PC pelo código e toca o áudio recebido via WebRTC.
const $ = (id) => document.getElementById(id);
const audio = $('audio');

let code = RP.normCode(new URLSearchParams(location.search).get('c') || localStorage.getItem('rp_last') || '');
let peer = null, conn = null, call = null;
let want = false, streaming = false, retryT = null, wakeLock = null;
let latMs = Number(localStorage.getItem('rp_lat2') || 0);
let last = null; // últimas estatísticas (para calcular deltas)

$('codeIn').value = code;

// ---------- Conexão ----------
function connect() {
  clearTimeout(retryT);
  if (!want) return;
  if (!peer || peer.destroyed) {
    status('warn', 'Conectando…');
    peer = new Peer({ debug: 1 });
    peer.on('open', openConn);
    peer.on('call', onCall);
    peer.on('disconnected', () => { if (want && !peer.destroyed) setTimeout(() => peer.disconnected && peer.reconnect(), 1000); });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        status('bad', 'PC não encontrado');
        info('Confira o código e se a página do PC está aberta. Tentando de novo…');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        status('bad', 'Sem internet');
        info('O celular precisa de internet só para encontrar o PC. Tentando de novo…');
      } else {
        console.warn('PeerJS:', err.type, err);
      }
      retry();
    });
  } else if (peer.open) {
    openConn();
  }
}

function openConn() {
  if (!want || (conn && conn.open)) return;
  status('warn', 'Procurando o PC…');
  conn = peer.connect(RP.peerId(code), { reliable: true, metadata: { name: deviceName() } });
  const c = conn;
  c.on('open', () => {
    status('warn', 'Conectado');
    info('Conectado ao PC. Aguardando ele começar a transmitir…');
    setTap('⏳', 'Aguardando PC');
  });
  c.on('data', (d) => {
    if (d && d.type === 'status') {
      streaming = d.streaming;
      if (!streaming) { info('Conectado. O PC parou/ainda não começou a transmitir.'); setTap('⏳', 'Aguardando PC'); }
    }
  });
  c.on('close', () => {
    if (conn !== c) return;
    conn = null;
    if (want) { status('bad', 'Conexão perdida'); info('Reconectando…'); retry(); }
  });
}

function retry() {
  clearTimeout(retryT);
  if (want) retryT = setTimeout(connect, 2500);
}

function onCall(c) {
  try { call && call.close(); } catch {}
  call = c;
  last = null;
  c.answer(undefined, { sdpTransform: RP.hifiOpus });
  c.on('stream', (stream) => {
    audio.srcObject = stream;
    applyLatency();
    applyVolume();
    playAudio();
  });
  c.on('close', () => {
    if (call !== c) return;
    call = null;
    audio.srcObject = null;
    if (want) { setTap('⏳', 'Aguardando PC'); status(conn && conn.open ? 'warn' : 'bad', conn && conn.open ? 'Conectado' : 'Desconectado'); }
  });
}

function playAudio() {
  audio.play().then(() => {
    status('ok', 'Tocando');
    info('Tocando o áudio do PC 🎶');
    setTap('🔊', 'Tocando');
  }).catch(() => {
    // Navegador bloqueou o autoplay: precisa de um toque.
    status('warn', 'Toque para ouvir');
    setTap('▶', 'Toque para ouvir');
  });
}

function applyLatency() {
  const pc = call && call.peerConnection;
  if (!pc) return;
  for (const r of pc.getReceivers()) {
    try { r.jitterBufferTarget = latMs; } catch {}
    try { r.playoutDelayHint = latMs / 1000; } catch {}
  }
}
function applyVolume() {
  audio.volume = Number($('vol').value) / 100;
}

function leave() {
  want = false;
  clearTimeout(retryT);
  try { call && call.close(); } catch {}
  try { conn && conn.close(); } catch {}
  try { peer && peer.destroy(); } catch {}
  call = conn = peer = null;
  audio.srcObject = null;
  releaseWakeLock();
  status('', 'Desconectado');
  $('joinBox').style.display = '';
  $('liveBox').style.display = 'none';
}

// ---------- Estatísticas ----------
async function stats() {
  const pc = call && call.peerConnection;
  if (!pc) return;
  const rep = await pc.getStats();
  let inb = null, pair = null;
  rep.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') inb = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = rep.get(r.selectedCandidatePairId);
  });
  if (!pair) rep.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });

  if (pair) {
    const loc = rep.get(pair.localCandidateId) || {};
    const rem = rep.get(pair.remoteCandidateId) || {};
    const t = loc.candidateType === 'relay' || rem.candidateType === 'relay' ? 'relay'
      : loc.candidateType === 'host' && rem.candidateType === 'host' ? 'host' : 'p2p';
    $('sConn').textContent = t === 'host' ? 'Local' : t === 'relay' ? 'Servidor' : 'Internet';
    $('sConn').title = t === 'host' ? 'Direto pela rede local (cabo USB/Wi-Fi)' : '';
    if (pair.currentRoundTripTime != null) $('sRtt').textContent = Math.round(pair.currentRoundTripTime * 1000) + ' ms';
  }
  if (inb) {
    if (last) {
      const dt = (inb.timestamp - last.timestamp) / 1000;
      if (dt > 0) $('sKbps').textContent = Math.round(((inb.bytesReceived - last.bytesReceived) * 8) / dt / 1000) + ' kbps';
      const de = inb.jitterBufferEmittedCount - last.jitterBufferEmittedCount;
      if (de > 0) $('sBuf').textContent = Math.round(((inb.jitterBufferDelay - last.jitterBufferDelay) / de) * 1000) + ' ms';
      const lost = inb.packetsLost - last.packetsLost;
      const got = inb.packetsReceived - last.packetsReceived;
      if (got + lost > 0) $('sLoss').textContent = ((lost / (got + lost)) * 100).toFixed(1) + '%';
    }
    last = inb;
  }
}

// ---------- UI ----------
function status(state, text) { RP.setPill('st', state, text); }
function info(t) { $('info').textContent = t; }
function setTap(ico, txt) { $('tapIco').textContent = ico; $('tapTxt').textContent = txt; }
function showError(t) { $('err').textContent = t; $('err').classList.toggle('show', !!t); }
function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].replace(/Build.*/, '').trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return 'Celular';
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && want) {
    requestWakeLock();
    if (audio.srcObject && audio.paused) playAudio();
    if (!conn || !conn.open) connect();
  }
});

$('connectBtn').onclick = () => {
  code = RP.normCode($('codeIn').value);
  if (code.length < 4) { showError('Digite o código que aparece na tela do PC.'); return; }
  showError('');
  localStorage.setItem('rp_last', code);
  history.replaceState(null, '', '?c=' + code);
  audio.play().catch(() => {}); // aproveita o toque para liberar o áudio
  $('joinBox').style.display = 'none';
  $('liveBox').style.display = '';
  setTap('♪', 'Conectando…');
  want = true;
  requestWakeLock();
  connect();
};
$('codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connectBtn').click(); });
$('tapBtn').onclick = () => { if (audio.srcObject) playAudio(); };
$('leaveBtn').onclick = leave;

$('vol').value = localStorage.getItem('rp_vol2') || 100;
$('volVal').textContent = $('vol').value + '%';
$('vol').oninput = () => {
  $('volVal').textContent = $('vol').value + '%';
  localStorage.setItem('rp_vol2', $('vol').value);
  applyVolume();
};
$('lat').value = latMs;
$('latVal').textContent = latMs + ' ms';
$('lat').oninput = () => {
  latMs = Number($('lat').value);
  $('latVal').textContent = latMs + ' ms';
  localStorage.setItem('rp_lat2', latMs);
  applyLatency();
};

setInterval(stats, 1000);
