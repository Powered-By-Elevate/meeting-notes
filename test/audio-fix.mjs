// Unit cases for audio-fix.js: the resampler, the slowed-speech test and the loop filter.
// Run: OUT=<folder with meeting2.wav> node audio-fix.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
const A = await import(new URL('../audio-fix.js', import.meta.url));
const OUT = process.env.OUT || '.';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const raw = (rate) => {
  const f = path.join(OUT, `m${rate}.raw`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, 'meeting2.wav'), '-ar', String(rate), '-ac', '1', '-f', 's16le', f]);
  const b = fs.readFileSync(f);
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
};
const a16 = raw(16000), a48 = raw(48000), a44 = raw(44100);
const snr = (x, y) => { let d = 0, e = 0; for (let i = 200; i < Math.min(x.length, y.length) - 200; i++) { d += (x[i] - y[i]) ** 2; e += y[i] ** 2; } return 10 * Math.log10(e / d); };
const r48 = A.resample(a48, 3);
check('48 kHz resampled to 16 kHz matches ffmpeg', r48.length === a16.length && snr(r48, a16) > 30, `${snr(r48, a16).toFixed(1)} dB`);
const r44 = A.resample(a44, 44100 / 16000);
check('44.1 kHz resampled to 16 kHz matches ffmpeg', Math.abs(r44.length - a16.length) <= 1 && snr(r44, a16) > 25, `${snr(r44, a16).toFixed(1)} dB`);
check('a ratio near 3 snaps to 48 kHz', A.snapRatio(3.005) === 3 && A.snapRatio(2.74) === 2.75625 && A.snapRatio(1.7) === 1.7);
check('normal speech does not look slowed', !A.looksSlowed(A.voiceStats([a16])), JSON.stringify(A.voiceStats([a16])));
check('48 kHz audio labelled 16 kHz looks slowed', A.looksSlowed(A.voiceStats([a48])), JSON.stringify(A.voiceStats([a48])));
const loop = 'I just gotta make sure, make sure. ' + 'I see, '.repeat(200);
check('a long "I see" loop is cut to one saying', (await A.cleanSegment(loop)) === 'I just gotta make sure, make sure. I see,');
check('a segment that is only a loop is dropped', (await A.cleanSegment('Thank you. '.repeat(40))) === null && (await A.cleanSegment('here, '.repeat(100))) === null);
const real = 'Okay thanks everyone, the bank wants the updated construction budget by Friday and the revised proforma.';
check('real speech is kept as it is', (await A.cleanSegment(real)) === real);
check('a short honest repeat is kept', (await A.cleanSegment('yes yes we agree on the rate')) === 'yes yes we agree on the rate');
const p = A.plan([0, 1, 2, 3, 4, 5, 6].map((seq) => ({ seq, startMs: seq * 22000, ms: 22000, rate: 0, final: seq === 6 })), 3);
check('the plan joins three old pieces into one, each new index no higher than its first old one', p.groups.length === 3 && p.groups.every((g, k) => g.seqs[0] >= k), JSON.stringify(p.groups.map((g) => g.seqs)));
console.log(`\n${pass} of ${pass + fail} passed`);
process.exit(fail ? 1 : 0);
