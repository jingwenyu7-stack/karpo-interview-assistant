/**
 * Karpo PCM AudioWorklet
 *
 * Receives Float32 audio frames at whatever sampleRate the AudioContext runs at
 * (usually 48000 in Chrome), downsamples to 16000 Hz mono Int16, and posts the
 * raw Int16Array back to the main thread which forwards to the backend WS.
 *
 * Output frame size: 20ms = 320 samples = 640 bytes of Int16.
 * We accumulate input until we have ≥ 20ms of *downsampled* audio, then emit.
 */
class PCMWorklet extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor(options) {
    super();
    this.targetSampleRate = 16000;
    this.inputSampleRate = sampleRate; // global from AudioWorkletGlobalScope
    this.ratio = this.inputSampleRate / this.targetSampleRate;

    // Output frame: 20ms @ 16k = 320 samples
    this.outFrameSize = 320;
    this.outBuffer = new Float32Array(this.outFrameSize);
    this.outIndex = 0;

    // Fractional read pointer into input
    this.readPos = 0;
    this.carry = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mix to mono (input[ch] is a Float32Array per channel)
    const channels = input.length;
    const frames = input[0].length;
    let mono;
    if (channels === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += input[c][i];
        mono[i] = s / channels;
      }
    }

    // Prepend any carry from previous block (since downsampling uses a fractional pointer)
    let buf;
    if (this.carry.length > 0) {
      buf = new Float32Array(this.carry.length + mono.length);
      buf.set(this.carry, 0);
      buf.set(mono, this.carry.length);
    } else {
      buf = mono;
    }

    // Decimate with linear interpolation
    let pos = 0;
    while (pos + 1 < buf.length) {
      const i0 = Math.floor(pos);
      const i1 = i0 + 1;
      const frac = pos - i0;
      const sample = buf[i0] * (1 - frac) + buf[i1] * frac;
      this.outBuffer[this.outIndex++] = sample;

      if (this.outIndex >= this.outFrameSize) {
        // Convert Float32 [-1,1] → Int16
        const i16 = new Int16Array(this.outFrameSize);
        for (let i = 0; i < this.outFrameSize; i++) {
          let s = this.outBuffer[i];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        // Transfer the underlying buffer to avoid copy
        this.port.postMessage(i16.buffer, [i16.buffer]);
        this.outIndex = 0;
      }

      pos += this.ratio;
    }

    // Save the tail samples that we couldn't fully consume
    const consumed = Math.floor(pos);
    this.carry = buf.slice(consumed);
    // Remaining fractional offset is now relative to this.carry, so reset pos
    // (we don't keep a sub-sample offset for simplicity; small phase noise is inaudible for STT)

    return true;
  }
}

registerProcessor("karpo-pcm-worklet", PCMWorklet);
