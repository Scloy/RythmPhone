// Página do celular: recebe PCM 16-bit pelo WebSocket e toca com Web Audio.
// Usa ScriptProcessorNode porque ele funciona mesmo em http:// (sem HTTPS),
// que é o caso ao acessar o PC pelo IP do tethering USB.
const $ = (id) => document.getElementById(id);
const AC = window.AudioContext || window.webkitAudioContext;

let ws = null;
let ctx = null;
let proc = null;
let gain = null;
let playing = false;
let wakeLock = null;

// Formato vindo do PC
let srcRate = 48000;
let srcCh = 2;
let sourceOnline = false;

// Ring buffer (estéreo), na taxa do AudioContext do celular
const CAP = 48000 * 4;
const ringL = new Float32Array(CAP);
const ringR = new Float32Array(CAP);
let rIdx = 0, wIdx = 0, count = 0;
let primed = false;
let underruns = 0;
let peak = 0;

// Reamostragem linear (se o celular não aceitar 48 kHz)
let resPos = 0, prevL = 0, prevR = 0;

let targetMs = Number(localStorage.getItem('rp_lat') || 80);
let blockSize = Number(localStorage.getItem('rp_blk') || 2048);
let volume = Number(localStorage.getItem('rp_vol') || 100);

// ---------- WebSocket ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=sink`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => updateStatus();
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'config') {
          srcRate = m.sampleRate || 48000;
          srcCh = m.channels || 2;
          resetRing();
          $('sRate').textContent = (srcRate / 1000).toFixed(1) + 'k';
        } else if (m.type === 'source') {
          sourceOnline = m.online;
          if (!m.online) resetRing();
        }
        updateStatus();
      } catch {}
      return;
    }
    if (playing) pushPCM(e.data);
  };
  ws.onclose = () => {
    sourceOnline = false;
    updateStatus();
    setTimeout(connectWS, 1000);
  };
}

function updateStatus() {
  const connected = ws && ws.readyState === 1;
  let state = 'bad', text = 'Sem conexão';
  if (connected && sourceOnline) { state = 'ok'; text = 'PC transmitindo'; }
  else if (connected) { state = 'warn'; text = 'Conectado'; }
  $('stDot').className = 'dot ' + state;
  $('stTxt').textContent = text;
  $('srcInfo').textContent = !connected
    ? 'Sem conexão com o PC. Confira o cabo e o endereço.'
    : sourceOnline
      ? (playing ? 'Tocando o áudio do PC 🎶' : 'O PC está transmitindo. Toque em “Tocar”.')
      : 'Aguardando o PC começar a transmitir…';
}

// ---------- Buffer ----------
function resetRing() {
  rIdx = wIdx = count = 0;
  primed = false;
  resPos = 0;
  prevL = prevR = 0;
}

function write(l, r) {
  ringL[wIdx] = l;
  ringR[wIdx] = r;
  wIdx = (wIdx + 1) % CAP;
  if (count < CAP) count++;
  else rIdx = (rIdx + 1) % CAP; // cheio: descarta o mais antigo
}

function pushPCM(ab) {
  const s = new Int16Array(ab);
  const ch = srcCh;
  const n = (s.length / ch) | 0;
  if (n === 0) return;
  const rOff = ch > 1 ? 1 : 0;
  const outRate = ctx ? ctx.sampleRate : srcRate;

  if (outRate === srcRate) {
    for (let i = 0; i < n; i++) {
      write(s[i * ch] / 32768, s[i * ch + rOff] / 32768);
    }
    return;
  }

  // Reamostragem linear com continuidade entre pacotes.
  // Índice virtual: 0 = última amostra do pacote anterior, k = s[k-1].
  const step = srcRate / outRate;
  let pos = resPos;
  while (pos < n) {
    const i = pos | 0;
    const f = pos - i;
    const aL = i === 0 ? prevL : s[(i - 1) * ch] / 32768;
    const aR = i === 0 ? prevR : s[(i - 1) * ch + rOff] / 32768;
    const bL = s[i * ch] / 32768;
    const bR = s[i * ch + rOff] / 32768;
    write(aL + (bL - aL) * f, aR + (bR - aR) * f);
    pos += step;
  }
  resPos = pos - n;
  prevL = s[(n - 1) * ch] / 32768;
  prevR = s[(n - 1) * ch + rOff] / 32768;
}

// ---------- Reprodução ----------
function onAudio(e) {
  const outL = e.outputBuffer.getChannelData(0);
  const outR = e.outputBuffer.numberOfChannels > 1 ? e.outputBuffer.getChannelData(1) : null;
  const N = outL.length;
  const rate = ctx.sampleRate;
  const target = Math.round((targetMs / 1000) * rate);

  // Pré-carrega até ter o atraso desejado.
  if (!primed) {
    if (count >= target + N) primed = true;
    else { outL.fill(0); if (outR) outR.fill(0); return; }
  }

  // Se acumulou atraso demais (ex.: travada na rede), pula para o alvo.
  const maxAllowed = target + N + Math.max(target, Math.round(0.06 * rate));
  if (count > maxAllowed) {
    const drop = count - (target + N);
    rIdx = (rIdx + drop) % CAP;
    count -= drop;
  }

  let p = 0;
  const avail = Math.min(N, count);
  for (let i = 0; i < avail; i++) {
    const l = ringL[rIdx], r = ringR[rIdx];
    outL[i] = l;
    if (outR) outR[i] = r;
    const a = l < 0 ? -l : l; if (a > p) p = a;
    rIdx = (rIdx + 1) % CAP;
  }
  count -= avail;
  if (avail < N) {
    // Faltou áudio: completa com silêncio e volta a pré-carregar.
    for (let i = avail; i < N; i++) { outL[i] = 0; if (outR) outR[i] = 0; }
    if (sourceOnline) underruns++;
    primed = false;
  }
  if (p > peak) peak = p;
}

function buildGraph() {
  if (proc) { proc.disconnect(); proc.onaudioprocess = null; }
  proc = ctx.createScriptProcessor(blockSize, 0, 2);
  proc.onaudioprocess = onAudio;
  proc.connect(gain);
}

async function play() {
  if (!ctx) {
    try { ctx = new AC({ sampleRate: srcRate, latencyHint: 'interactive' }); }
    catch { ctx = new AC(); }
    gain = ctx.createGain();
    gain.gain.value = volume / 100;
    gain.connect(ctx.destination);
    buildGraph();
  }
  await ctx.resume();
  resetRing();
  playing = true;
  requestWakeLock();
  setPlayUI();
  updateStatus();
}

function pause() {
  playing = false;
  if (ctx) ctx.suspend();
  resetRing();
  releaseWakeLock();
  setPlayUI();
  updateStatus();
}

function setPlayUI() {
  $('playIco').textContent = playing ? '❚❚' : '▶';
  $('playTxt').textContent = playing ? 'Pausar' : 'Tocar';
  $('playBtn').classList.toggle('stop', playing);
}

// ---------- Manter a tela ligada ----------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing) {
    requestWakeLock();
    if (ctx && ctx.state !== 'running') ctx.resume();
  }
});

// ---------- UI ----------
function tick() {
  const rate = ctx ? ctx.sampleRate : srcRate;
  $('sBuf').textContent = Math.round((count / rate) * 1000) + ' ms';
  $('sUnder').textContent = underruns;
  const db = peak > 0 ? 20 * Math.log10(peak) : -100;
  $('meter').style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
  peak *= 0.85;
  requestAnimationFrame(tick);
}

$('playBtn').onclick = () => (playing ? pause() : play());

$('vol').value = volume;
$('volVal').textContent = volume + '%';
$('vol').oninput = (e) => {
  volume = Number(e.target.value);
  $('volVal').textContent = volume + '%';
  if (gain) gain.gain.value = volume / 100;
  localStorage.setItem('rp_vol', volume);
};

$('lat').value = targetMs;
$('latVal').textContent = targetMs + ' ms';
$('lat').oninput = (e) => {
  targetMs = Number(e.target.value);
  $('latVal').textContent = targetMs + ' ms';
  localStorage.setItem('rp_lat', targetMs);
};

$('blk').value = String(blockSize);
$('blk').onchange = (e) => {
  blockSize = Number(e.target.value);
  localStorage.setItem('rp_blk', blockSize);
  if (ctx) { buildGraph(); resetRing(); }
};

connectWS();
tick();
