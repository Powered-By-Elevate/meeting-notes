// Whisper on the device, in its own thread so typing never stalls.
// The model downloads once from Hugging Face and the library keeps it in the browser's cache.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { cleanSegment } from './audio-fix.js';

env.allowLocalModels = false;

let asr = null;
let loaded = '';

async function load(model) {
  if (asr && loaded === model) return;
  // a browser can offer WebGPU with no usable GPU behind it, so ask for an adapter first
  let webgpu = false;
  try { webgpu = !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())); } catch { webgpu = false; }
  const opts = {
    device: webgpu ? 'webgpu' : 'wasm',
    // measured 2026-10-26: the 8-bit model returned nothing for whole pieces of clear speech, the
    // full-precision encoder with the 4-bit decoder transcribed them and heard names better
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    progress_callback: (p) => {
      if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  };
  let device = opts.device;
  try {
    asr = await pipeline('automatic-speech-recognition', model, opts);
  } catch (err) {
    if (!webgpu) throw err;
    // some iPads advertise WebGPU and then fail to compile the model: fall back to the CPU
    device = 'wasm';
    asr = await pipeline('automatic-speech-recognition', model, { ...opts, device });
  }
  loaded = model;
  self.postMessage({ type: 'ready', model, device });
}

// Whisper invents words over silence and music. These are its usual inventions.
const NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|thank you\.?|thanks for watching\.?|you|\.+)\s*$/i;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load(m.model);
    } else if (m.type === 'run') {
      await load(m.model);
      const secs = m.audio.length / 16000;
      // a segment that is mostly one word or phrase said over and over is Whisper looping, not
      // speech: the repeats are cut, and a segment that was nothing but the loop is dropped
      const keep = async (cs) => {
        const out = [];
        for (const c of cs) {
          if (!c.text || NOISE.test(c.text)) continue;
          const text = await cleanSegment(c.text);
          if (!text || NOISE.test(text)) continue;
          out.push({
            t0: Math.round(m.offsetMs + 1000 * (c.timestamp?.[0] ?? 0)),
            t1: Math.round(m.offsetMs + 1000 * (c.timestamp?.[1] ?? secs)),
            text,
          });
        }
        return out;
      };
      // one window of at most 30 seconds: no long-form chunking, which lost text in testing
      const out = await asr(m.audio, { return_timestamps: true });
      let segments = await keep(out.chunks || []);
      if (!segments.length && m.loud) {
        // Whisper sometimes stops at once when asked for timestamps. A piece with real sound in it
        // gets a second try without them, as one segment spanning the piece.
        const plain = await asr(m.audio, {});
        segments = await keep([{ text: plain.text, timestamp: [0, secs] }]);
      }
      self.postMessage({ type: 'result', id: m.id, segments });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
