// Pure helpers for repairing audio and transcripts, shared by the app, the Whisper worker and the
// tests. No DOM, no storage: everything here takes arrays and returns arrays.

export const RATE = 16000;

// ---------------------------------------------------------------- resampling

// Windowed-sinc resampler. `ratio` is how many input samples make one output sample (3 turns
// 48 kHz into 16 kHz). The low-pass sits just under the output's Nyquist so nothing folds back
// into the band Whisper listens to. Input and output are Int16Array.
const ZEROS = 8; // zero crossings each side of the kernel
const STEPS = 256; // table resolution per input sample
const tables = new Map();
function kernel(ratio) {
  const key = ratio.toFixed(6);
  if (tables.has(key)) return tables.get(key);
  const fc = 0.47 / Math.max(1, ratio); // cycles per input sample
  const half = ZEROS / (2 * fc); // half width in input samples
  const n = Math.ceil(half * STEPS) + 1;
  const tab = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / STEPS;
    const x = 2 * fc * t;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = t >= half ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half); // Blackman
    tab[i] = sinc * w;
  }
  const k = { tab, half };
  tables.set(key, k);
  return k;
}

export function resample(input, ratio) {
  if (Math.abs(ratio - 1) < 1e-6) return Int16Array.from(input);
  const { tab, half } = kernel(ratio);
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  const last = input.length - 1;
  for (let k = 0; k < outLen; k++) {
    const c = k * ratio;
    const a = Math.max(0, Math.ceil(c - half));
    const b = Math.min(last, Math.floor(c + half));
    let s = 0, w = 0;
    for (let i = a; i <= b; i++) {
      const h = tab[Math.round(Math.abs(i - c) * STEPS)] || 0;
      s += input[i] * h;
      w += h;
    }
    const v = w ? s / w : 0;
    out[k] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }
  return out;
}

// A measured ratio close to a real hardware rate is snapped to it (48 kHz is 3, 44.1 kHz 2.75625).
export function snapRatio(r) {
  for (const hw of [48000, 44100, 32000, 24000, 22050, 16000]) {
    const q = hw / RATE;
    if (Math.abs(r / q - 1) < 0.03) return q;
  }
  return r;
}

// ---------------------------------------------------------------- telling slowed audio apart

// Speech recorded at 48 kHz but saved as 16 kHz plays three times slower: its voice sits a third
// as high and almost nothing is left above 3 kHz. Returns the median pitch (Hz, as labelled) and
// the share of energy above 3 kHz, over the loud frames of the pieces given.
export function voiceStats(pieces, { maxFrames = 240 } = {}) {
  const N = 1024;
  const f0s = [];
  let hi = 0, all = 0, frames = 0;
  const loud = [];
  for (const d of pieces) {
    for (let o = 0; o + N <= d.length; o += N * 4) {
      let e = 0;
      for (let i = 0; i < N; i++) e += (d[o + i] / 32768) ** 2;
      if (Math.sqrt(e / N) > 0.02) loud.push([d, o]);
    }
  }
  const step = Math.max(1, Math.floor(loud.length / maxFrames));
  for (let j = 0; j < loud.length; j += step) {
    const [d, o] = loud[j];
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = d[o + i] / 32768;
    // pitch: normalised autocorrelation, the shortest lag within 85% of the best peak
    const minLag = 32, maxLag = 700;
    const nsdf = new Float32Array(maxLag + 1);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let r = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + lag < N; i++) { r += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
      nsdf[lag] = e1 && e2 ? r / Math.sqrt(e1 * e2) : 0;
      if (nsdf[lag] > best) best = nsdf[lag];
    }
    if (best > 0.5) {
      for (let lag = minLag + 1; lag < maxLag; lag++) {
        if (nsdf[lag] >= 0.85 * best && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) { f0s.push(RATE / lag); break; }
      }
    }
    // energy above 3 kHz: a first difference twice is a crude high-pass, measured against the frame
    let eh = 0, ea = 0;
    for (let i = 2; i < N; i++) { const h = x[i] - 2 * x[i - 1] + x[i - 2]; eh += h * h; ea += x[i] * x[i]; }
    hi += eh; all += ea; frames++;
  }
  f0s.sort((a, b) => a - b);
  return { pitch: f0s.length ? f0s[f0s.length >> 1] : 0, hiShare: all ? hi / all : 0, frames, voiced: f0s.length };
}

// True when the stats look like speech slowed about three times.
export function looksSlowed(st) {
  if (st.frames < 20) return false;
  if (!st.pitch) return false;
  return st.pitch < 75 || (st.pitch < 100 && st.hiShare < 0.01);
}

// ---------------------------------------------------------------- hallucinated loops

const words = (t) => t.toLowerCase().replace(/[^a-z0-9'%\s]/g, ' ').split(/\s+/).filter(Boolean);

// The share of a text's words taken by its most repeated short phrase (one to four words).
export function loopShare(text) {
  const w = words(text);
  if (w.length < 6) return 0;
  let best = 0;
  for (let n = 1; n <= 4; n++) {
    const counts = new Map();
    for (let i = 0; i + n <= w.length; i++) {
      const g = w.slice(i, i + n).join(' ');
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    for (const c of counts.values()) if (c >= 3) best = Math.max(best, (c * n) / w.length);
  }
  return Math.min(1, best);
}

// A phrase said three or more times in a row is cut to one saying ("I see, I see, I see" to "I see,").
export function collapseRepeats(text) {
  let toks = text.split(/\s+/).filter(Boolean);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9'%]/g, '');
  for (let n = 1; n <= 6; n++) {
    const out = [];
    let i = 0;
    while (i < toks.length) {
      let reps = 1;
      while (i + (reps + 1) * n <= toks.length) {
        let same = true;
        for (let j = 0; j < n; j++) if (norm(toks[i + j]) !== norm(toks[i + reps * n + j])) { same = false; break; }
        if (!same) break;
        reps++;
      }
      if (reps >= 3) { out.push(...toks.slice(i, i + n)); i += reps * n; }
      else { out.push(toks[i]); i++; }
    }
    toks = out;
  }
  return toks.join(' ');
}

// Whisper's own test: text that compresses very well is a loop. Needs CompressionStream.
export async function gzipRatio(text) {
  if (typeof CompressionStream === 'undefined' || text.length < 60) return 1;
  const bytes = new TextEncoder().encode(text);
  const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const z = await new Response(cs).arrayBuffer();
  return bytes.length / Math.max(1, z.byteLength - 18);
}

// What to keep of one Whisper segment: null drops it.
export async function cleanSegment(text) {
  const t = text.trim();
  if (!t) return null;
  const share = loopShare(t);
  const c = collapseRepeats(t);
  if (share > 0.5) {
    // mostly one phrase: keep what is left only if it still says something on its own
    if (words(c).length < 8 || loopShare(c) > 0.5) return null;
  }
  if ((await gzipRatio(c)) > 2.4) return null;
  return c;
}

// ---------------------------------------------------------------- the repair plan

// Pieces saved before the fix carry no `rate`. Each group of `g` touching old pieces becomes one
// new piece, and every new piece keeps an index no higher than the first old piece it reads, so
// the repair can write in place, in order, and pick up where it stopped.
export function plan(meta, ratio) {
  const fix = Math.abs(ratio - 1) > 0.02;
  const g = fix ? Math.max(1, Math.floor(ratio + 0.02)) : 1;
  const groups = [];
  let cur = null, prev = null;
  for (const p of meta) {
    const legacy = fix && !p.rate;
    const touching = prev && prev.startMs + prev.ms === p.startMs;
    if (cur && legacy && cur.legacy && touching && cur.seqs.length < g && !prev.final) cur.seqs.push(p.seq);
    else { cur = { seqs: [p.seq], legacy, oldStart: p.startMs, joined: !!touching }; groups.push(cur); }
    if (p.final) cur.final = true;
    prev = p;
  }
  return { ratio: fix ? ratio : 1, g, groups };
}
