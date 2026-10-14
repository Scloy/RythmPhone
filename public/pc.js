// Página do PC: captura o áudio e envia por WebRTC (PeerJS) direto para os celulares.
const $ = (id) => document.getElementById(id);

let code = RP.normCode(localStorage.getItem('rp_code')) || RP.newCode();
localStorage.setItem('rp_code', code);

let peer = null;
const phones = new Map(); // peerId -> { conn, call, name }
let capture = null;       // stream original (tela/dispositivo)
let outStream = null;     // só as faixas de áudio
let actx = null, analyser = null, meterData = null;

// ---------- Código / QR ----------
function phoneUrl() {
  return new URL('/phone?c=' + code, location.href).href;
}
function renderCode() {
  $('code').textContent = code;
  const url = phoneUrl();
  $('phoneLink').textContent = new URL('/phone', location.href).href.replace(/^https?:\/\//, '');
  $('phoneLink').href = url;
  $('qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=' + encodeURIComponent(url);
}

// ---------- Sinalização (PeerJS) ----------
function initPeer() {
  RP.setPill('srv', 'warn', 'Conectando…');
  peer = new Peer(RP.peerId(code), { debug: 1 });

  peer.on('open', () => RP.setPill('srv', 'ok', 'Online'));
  peer.on('connection', onPhoneConn);
  peer.on('disconnected', () => {
    RP.setPill('srv', 'warn', 'Reconectando…');
    setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      // Outra aba com o mesmo código aberta: gera outro.
      peer.destroy();
      code = RP.newCode();
      localStorage.setItem('rp_code', code);
      renderCode();
      initPeer();
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      RP.setPill('srv', 'bad', 'Sem conexão — verifique a internet');
    } else if (err.type !== 'peer-unavailable') {
      console.warn('PeerJS:', err.type, err);
    }
  });
}

function onPhoneConn(conn) {
  conn.on('open', () => {
    phones.set(conn.peer, { conn, call: null, name: (conn.metadata && conn.metadata.name) || 'Celular' });
    sendStatus(conn);
    if (outStream) callPhone(conn.peer);
    renderPhones();
  });
  conn.on('close', () => removePhone(conn.peer));
  conn.on('error', () => removePhone(conn.peer));
}

function removePhone(id) {
  const p = phones.get(id);
  if (!p) return;
  try { p.call && p.call.close(); } catch {}
  phones.delete(id);
  renderPhones();
}

function sendStatus(conn) {
  try { conn.open && conn.send({ type: 'status', streaming: !!outStream }); } catch {}
}
function broadcastStatus() {
  for (const p of phones.values()) sendStatus(p.conn);
}

function callPhone(id) {
  const p = phones.get(id);
  if (!p || !outStream) return;
  try { p.call && p.call.close(); } catch {}
  const call = peer.call(id, outStream, { sdpTransform: RP.hifiOpus });
  p.call = call;
  const watch = () => {
    const pc = call.peerConnection;
    if (!pc) return setTimeout(watch, 50);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') tuneSenders(pc);
      renderPhones();
    });
  };
  watch();
  const done = () => { if (p.call === call) p.call = null; renderPhones(); };
  call.on('close', done);
  call.on('error', done);
  renderPhones();
}

function tuneSenders(pc) {
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'audio') continue;
    try {
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = RP.BITRATE;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      s.setParameters(params).catch(() => {});
    } catch {}
  }
}

function renderPhones() {
  const n = phones.size;
  RP.setPill('lis', n ? 'ok' : '', `${n} celular${n === 1 ? '' : 'es'}`);
  const box = $('phones');
  box.innerHTML = '';
  for (const p of phones.values()) {
    const st = p.call && p.call.peerConnection ? p.call.peerConnection.connectionState : null;
    const label = !outStream ? 'conectado · aguardando transmissão'
      : st === 'connected' ? '🔊 recebendo áudio'
      : st === 'failed' ? '❌ falhou (tente outra rede)'
      : 'conectando áudio…';
    const el = document.createElement('div');
    el.className = 'phone-item';
    el.innerHTML = '<span>📱</span><b></b><span class="muted"></span>';
    el.querySelector('b').textContent = p.name;
    el.querySelector('.muted').textContent = label;
    box.appendChild(el);
  }
}

// ---------- Captura ----------
const NO_PROC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 };

async function getSource() {
  if ($('mode').value === 'device') {
    const id = $('device').value;
    return navigator.mediaDevices.getUserMedia({ audio: { ...NO_PROC, ...(id ? { deviceId: { exact: id } } : {}) } });
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('Seu navegador não suporta captura de tela/áudio. Use o Chrome ou Edge no computador.');
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1, width: { max: 640 }, height: { max: 360 } },
    audio: { ...NO_PROC, suppressLocalAudioPlayback: false },
    systemAudio: 'include',
    windowAudio: 'window', // Chrome recente: tenta capturar áudio da janela, se suportado
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
}

async function start() {
  showError('');
  let s;
  try {
    s = await getSource();
  } catch (err) {
    if (err && err.name === 'NotAllowedError') showError('Compartilhamento cancelado ou bloqueado.');
    else if (err && err.name === 'OverconstrainedError') showError('Dispositivo não encontrado. Clique em “Listar dispositivos” de novo.');
    else showError((err && err.message) || String(err));
    return;
  }

  const audio = s.getAudioTracks();
  if (!audio.length) {
    const surface = s.getVideoTracks()[0]?.getSettings?.().displaySurface;
    s.getTracks().forEach((t) => t.stop());
    showError(surface === 'window'
      ? 'Você escolheu uma <b>Janela</b> — o Chrome/Edge não captura áudio de janelas. Escolha <b>“Tela inteira”</b> + <b>“Compartilhar áudio do sistema”</b>, ou uma <b>Guia</b> + <b>“Compartilhar áudio da guia”</b>.'
      : 'Nenhum áudio foi compartilhado. Ative a opção <b>“Compartilhar áudio do sistema”</b> (Tela inteira) ou <b>“Compartilhar áudio da guia”</b> (Guia).');
    return;
  }

  audio.forEach((t) => { try { t.contentHint = 'music'; } catch {} });
  capture = s;
  outStream = new MediaStream(audio);
  s.getTracks().forEach((t) => (t.onended = stop));

  // Medidor de nível
  try {
    actx = new AudioContext();
    analyser = actx.createAnalyser();
    analyser.fftSize = 1024;
    meterData = new Float32Array(analyser.fftSize);
    actx.createMediaStreamSource(outStream).connect(analyser);
  } catch {}

  for (const id of phones.keys()) callPhone(id);
  broadcastStatus();
  $('startBtn').style.display = 'none';
  $('stopBtn').style.display = '';
  $('mode').disabled = true;
  renderPhones();
}

function stop() {
  for (const p of phones.values()) { try { p.call && p.call.close(); } catch {} p.call = null; }
  if (capture) capture.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  capture = null;
  outStream = null;
  if (actx) actx.close().catch(() => {});
  actx = analyser = null;
  broadcastStatus();
  $('startBtn').style.display = '';
  $('stopBtn').style.display = 'none';
  $('mode').disabled = false;
  renderPhones();
}

// ---------- Dispositivos ----------
async function listDevices() {
  showError('');
  try {
    // Precisa de permissão para ver os nomes dos dispositivos.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch {
    showError('Permissão de áudio negada. Libere o microfone para este site nas configurações do navegador.');
    return;
  }
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = $('device');
  sel.innerHTML = '';
  const loop = /stereo mix|mixagem|cable output|voicemeeter|loopback|what u hear|wave out/i;
  let pick = null;
  for (const d of devs) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = (loop.test(d.label) ? '⭐ ' : '') + (d.label || 'Dispositivo');
    if (!pick && loop.test(d.label)) pick = d.deviceId;
    sel.appendChild(o);
  }
  if (pick) sel.value = pick;
  if (!pick) showError('Nenhum dispositivo de “loopback” encontrado. Ative a <b>Mixagem estéreo</b> (Painel de Som → Gravação → clique direito → Mostrar dispositivos desabilitados) ou instale o <a href="https://vb-audio.com/Cable/" target="_blank">VB-CABLE</a>. Microfones também aparecem na lista.');
}

// ---------- UI ----------
function showError(html) {
  $('err').innerHTML = html;
  $('err').classList.toggle('show', !!html);
}

function drawMeter() {
  let pct = 0;
  if (analyser) {
    analyser.getFloatTimeDomainData(meterData);
    let peak = 0;
    for (let i = 0; i < meterData.length; i++) { const a = Math.abs(meterData[i]); if (a > peak) peak = a; }
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  }
  $('meter').style.width = pct + '%';
  requestAnimationFrame(drawMeter);
}

$('mode').onchange = () => { $('deviceBox').style.display = $('mode').value === 'device' ? '' : 'none'; };
$('listBtn').onclick = listDevices;
$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('newCodeBtn').onclick = () => {
  if (outStream) stop();
  for (const id of [...phones.keys()]) { try { phones.get(id).conn.close(); } catch {} removePhone(id); }
  if (peer) peer.destroy();
  code = RP.newCode();
  localStorage.setItem('rp_code', code);
  renderCode();
  initPeer();
};
if (RP.isMobile()) $('mobileBanner').classList.add('show');
setInterval(renderPhones, 2000);

renderCode();
initPeer();
drawMeter();
