// Roda na thread de áudio do PC: converte Float32 -> Int16 intercalado (estéreo)
// e envia pacotes pequenos para a thread principal.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frames = (options.processorOptions && options.processorOptions.chunkFrames) || 480;
    this.buf = new Int16Array(this.frames * 2);
    this.pos = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const L = input[0];
    const R = input[1] || input[0];

    for (let i = 0; i < L.length; i++) {
      let l = L[i];
      let r = R[i];
      const a = l < 0 ? -l : l;
      const b = r < 0 ? -r : r;
      if (a > this.peak) this.peak = a;
      if (b > this.peak) this.peak = b;
      if (l > 1) l = 1; else if (l < -1) l = -1;
      if (r > 1) r = 1; else if (r < -1) r = -1;
      this.buf[this.pos++] = l < 0 ? l * 0x8000 : l * 0x7fff;
      this.buf[this.pos++] = r < 0 ? r * 0x8000 : r * 0x7fff;

      if (this.pos >= this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer, peak: this.peak }, [this.buf.buffer]);
        this.buf = new Int16Array(this.frames * 2);
        this.pos = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
