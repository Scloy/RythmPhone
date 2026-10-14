// RythmPhone - servidor local que retransmite o áudio do PC para o celular.
// O PC (página "/") captura o áudio do sistema e envia PCM via WebSocket;
// o celular (página "/phone") recebe e toca.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const ROUTES = { '/': 'index.html', '/phone': 'phone.html', '/celular': 'phone.html' };

// ---------- Utilitários de rede ----------
function localIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

// ---------- adb reverse (opcional) ----------
// Se o adb estiver instalado e o celular com "Depuração USB" ativa,
// o celular consegue abrir http://localhost:PORT/phone direto pelo cabo.
let adbOk = false;
const adbCandidates = [
  'adb',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
  path.join(__dirname, 'platform-tools', 'adb.exe'),
].filter(Boolean);

function tryAdbReverse() {
  let i = 0;
  const next = () => {
    if (i >= adbCandidates.length) {
      if (adbOk) console.log('[adb] celular desconectado do adb.');
      adbOk = false;
      return;
    }
    const bin = adbCandidates[i++];
    execFile(bin, ['reverse', `tcp:${PORT}`, `tcp:${PORT}`], { timeout: 4000, windowsHide: true }, (err) => {
      if (err) return next();
      if (!adbOk) {
        console.log(`[adb] OK! No celular abra:  http://localhost:${PORT}/phone`);
      }
      adbOk = true;
    });
  };
  next();
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ port: PORT, ips: localIPv4s(), adb: adbOk, listeners: sinks.size, source: !!source }));
    return;
  }

  const rel = ROUTES[url.pathname] || decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end('Proibido');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
let source = null;      // conexão do PC (quem captura)
let lastConfig = null;  // último {type:'config'} enviado pelo PC
const sinks = new Set(); // celulares

function sendJSON(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function notifyListeners() {
  sendJSON(source, { type: 'listeners', count: sinks.size });
}
function notifySinks() {
  for (const s of sinks) sendJSON(s, { type: 'source', online: !!source && !!lastConfig });
}

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://localhost').searchParams.get('role');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  try { ws._socket.setNoDelay(true); } catch {}

  if (role === 'source') {
    if (source && source !== ws) source.close(4000, 'substituído');
    source = ws;
    console.log('[pc] transmissor conectado');
    notifyListeners();

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'config') {
            lastConfig = JSON.stringify(msg);
            for (const s of sinks) if (s.readyState === 1) s.send(lastConfig);
            notifySinks();
          } else if (msg.type === 'stop') {
            lastConfig = null;
            notifySinks();
          }
        } catch {}
        return;
      }
      // Áudio: repassa para todos os celulares. Se algum estiver lento,
      // descarta pacotes para ele em vez de acumular atraso.
      for (const s of sinks) {
        if (s.readyState === 1 && s.bufferedAmount < 192 * 1024) s.send(data, { binary: true });
      }
    });

    ws.on('close', () => {
      if (source === ws) {
        source = null;
        lastConfig = null;
        console.log('[pc] transmissor desconectado');
        notifySinks();
      }
    });
  } else {
    sinks.add(ws);
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    console.log(`[celular] conectado (${ip}) - total: ${sinks.size}`);
    if (lastConfig) ws.send(lastConfig);
    sendJSON(ws, { type: 'source', online: !!source && !!lastConfig });
    notifyListeners();

    ws.on('close', () => {
      sinks.delete(ws);
      console.log(`[celular] desconectado - total: ${sinks.size}`);
      notifyListeners();
    });
  }
});

// Keep-alive: derruba conexões mortas (ex.: cabo desconectado).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 5000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ♪ RythmPhone rodando!');
  console.log('');
  console.log(`  No PC, abra no Chrome/Edge:   http://localhost:${PORT}`);
  console.log('');
  console.log('  No celular (conectado por USB), abra um destes:');
  console.log(`    - via adb reverse:          http://localhost:${PORT}/phone`);
  for (const { name, address } of localIPv4s()) {
    console.log(`    - via ${name.padEnd(22).slice(0, 22)} http://${address}:${PORT}/phone`);
  }
  console.log('');
  tryAdbReverse();
  setInterval(tryAdbReverse, 5000);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. Feche o outro programa ou rode com outra porta: set PORT=3001 && npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
