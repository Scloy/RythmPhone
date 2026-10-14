// Página do PC: captura o áudio do sistema e envia ao servidor.
const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 48000;
const CHUNK_FRAMES = 480; // 10 ms por pacote

let ws = null;
let ctx = null;
let stream = null;
let node = null;
let peak = 0;

// ---------- WebSocket ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=source`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    setPill('srv', 'ok', 'Servidor conectado');
    if (ctx) sendConfig();
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'listeners') {
        setPill('lis', m.count > 0 ? 'ok' : '', `${m.count} celular${m.count === 1 ? '' : 'es'} ouvindo`);
      }
    } catch {}
  };
  ws.onclose = () => {
    setPill('srv', 'bad', 'Servidor desconectado');
    setTimeout(connectWS, 1000);
  };
}

function sendConfig() {
  if (ws && ws.readyState === 1 && ctx) {
    ws.send(JSON.stringify({ type: 'config', sampleRate: ctx.sampleRate, channels: 2 }));
  }
}

function setPill(prefix, state, text) {
  $(prefix + 'Dot').className = 'dot ' + (state || '');
  $(prefix + 'Txt').textContent = text;
}

function showError(text) {
  const el = $('err');
  el.innerHTML = text;
  el.classList.toggle('show', !!text);
}

// ---------- Captura ----------
async function start() {
  showError('');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showError('Este navegador não suporta captura de áudio. Use o <b>Chrome</b> ou <b>Edge</b> e abra pelo endereço <code>http://localhost:3000</code>.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: 320, height: 180 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: SAMPLE_RATE,
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'include',
    });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') showError('Compartilhamento cancelado.');
    else showError('Erro ao capturar: ' + (err && err.message));
    return;
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    showError('Nenhum áudio foi compartilhado. Clique de novo, escolha <b>“Tela inteira”</b> e <b>marque “Compartilhar áudio do sistema”</b>.');
    return;
  }

  // Se o usuário clicar em "Parar compartilhamento" na barra do Chrome.
  stream.getTracks().forEach((t) => (t.onended = stop));

  ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('capture-worklet.js');

  const src = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  node = new AudioWorkletNode(ctx, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { chunkFrames: CHUNK_FRAMES },
  });
  // Saída silenciosa só para manter o grafo de áudio "puxando" o worklet.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);

  node.port.onmessage = (e) => {
    const { pcm, peak: p } = e.data;
    if (p > peak) peak = p;
    // Se a rede travar, descarta em vez de acumular atraso.
    if (ws && ws.readyState === 1 && ws.bufferedAmount < 64 * 1024) ws.send(pcm);
  };

  sendConfig();
  $('startBtn').style.display = 'none';
  $('stopBtn').style.display = '';
  $('hint').classList.remove('show');
}

function stop() {
  if (stream) stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  stream = null;
  if (node) node.port.onmessage = null;
  node = null;
  if (ctx) ctx.close();
  ctx = null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  $('startBtn').style.display = '';
  $('stopBtn').style.display = 'none';
  $('hint').classList.add('show');
}

// ---------- Medidor ----------
function drawMeter() {
  const db = peak > 0 ? 20 * Math.log10(peak) : -100;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('meter').style.width = pct + '%';
  peak *= 0.85;
  requestAnimationFrame(drawMeter);
}

// ---------- Endereços para o celular ----------
async function refreshInfo() {
  try {
    const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
    const box = $('urls');
    box.innerHTML = '';
    const ips = info.ips || [];
    if (ips.length === 0) {
      box.innerHTML = '<div class="muted">Nenhuma rede encontrada. Ative o tethering USB no celular e clique em Atualizar.</div>';
    }
    for (const { name, address } of ips) {
      const url = `http://${address}:${info.port}/phone`;
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = `<small></small><span class="url"></span><button class="btn ghost" style="padding:8px 12px;font-size:13px">Copiar</button>`;
      item.querySelector('small').textContent = name;
      item.querySelector('.url').textContent = url;
      item.querySelector('button').onclick = () => navigator.clipboard && navigator.clipboard.writeText(url);
      box.appendChild(item);
    }
    $('adbUrl').textContent = `http://localhost:${info.port}/phone`;
    $('adbStatus').textContent = info.adb ? '✅ conectado — abra o endereço acima no celular' : 'não detectado (adb não encontrado ou celular sem depuração USB)';
  } catch {}
}

// ---------- Abas ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab));
  };
});

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('refreshBtn').onclick = refreshInfo;

connectWS();
refreshInfo();
setInterval(refreshInfo, 5000);
drawMeter();
