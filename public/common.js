// Utilidades compartilhadas entre a página do PC e a do celular.
window.RP = {
  PREFIX: 'rythmphone-v2-',
  ALPH: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  BITRATE: 256000,

  newCode(n = 6) {
    const a = crypto.getRandomValues(new Uint32Array(n));
    let s = '';
    for (const x of a) s += RP.ALPH[x % RP.ALPH.length];
    return s;
  },

  normCode(c) {
    return (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  peerId(code) {
    return RP.PREFIX + code;
  },

  // Deixa o Opus em estéreo e com bitrate alto (padrão do WebRTC é mono ~32 kbps, feito para voz).
  hifiOpus(sdp) {
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!m) return sdp;
    const pt = m[1];
    const extra = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=' + RP.BITRATE, 'useinbandfec=1', 'usedtx=0', 'cbr=0'];
    const re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
    if (re.test(sdp)) {
      return sdp.replace(re, (_, p) => {
        const params = p.split(';').map((s) => s.trim())
          .filter((s) => s && !/^(stereo|sprop-stereo|maxaveragebitrate|useinbandfec|usedtx|cbr)=/i.test(s));
        return 'a=fmtp:' + pt + ' ' + params.concat(extra).join(';');
      });
    }
    return sdp.replace(m[0], m[0] + '\r\na=fmtp:' + pt + ' ' + extra.join(';'));
  },

  setPill(prefix, state, text) {
    const d = document.getElementById(prefix + 'Dot');
    const t = document.getElementById(prefix + 'Txt');
    if (d) d.className = 'dot ' + (state || '');
    if (t) t.textContent = text;
  },

  isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  },
};
