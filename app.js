// Meeting Notes: type while it listens. Recording, transcription and notes all live on the iPad.
// Claude (Enhance, Ask) and GitHub (sync into the Agentic OS repo) are the only outside calls,
// and each needs a key Matt enters in Settings. Design notes: README.md.

import { InkLayer, groups, render, bounds, PAPER, UNITS } from './ink.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------------------------------------------------------- constants

export const COMPANIES = [
  ['', 'Company'], ['TNC', 'True North Companies'], ['TNK12', 'True North K-12'],
  ['TNH', 'True North Holdings'], ['TP', 'True Places'], ['ELV', 'Elevate'], ['PAMG', 'PAMG'],
  ['AIA', 'American Innovation Academies'], ['GMW', 'GMW'], ['ESS', 'Essentia'],
  ['TMB', 'The Timberley'], ['T3T', 'Twenty3Twenty'], ['WAL', 'West Alley'], ['I61', 'Project i61'],
  ['PERSONAL', 'Personal'],
];

// What each meeting type asks Claude to look for. Granola calls these templates.
export const TEMPLATES = {
  general: ['General meeting', 'Capture what was decided, what is still open, and who owes what.'],
  one: ['One on one', 'Focus on feedback given and received, priorities agreed, blockers, and follow-ups for each person.'],
  client: ['Client or partner call', 'Focus on what the other side wants, their concerns and objections, commitments made by either side, numbers and dates quoted, and the next step.'],
  bank: ['Bank or lender meeting', 'Focus on the lender, the deal, the terms discussed (rate, leverage, term, covenants, recourse), what the lender asked for, documents owed and their dates. Quote every number exactly.'],
  site: ['Site walk', 'Organise by area of the site. Capture conditions observed, issues, who owns each fix, and anything needing a photo or a follow-up visit.'],
  team: ['Internal team', 'Focus on status by project or workstream, decisions, risks and owners.'],
  interview: ['Interview', 'Focus on the candidate: background, strengths, concerns, answers to key questions, and the hiring signal. Stay factual.'],
};

// Whisper hears 30 seconds at a time. Each 22-second piece is heard with the 8 seconds before it,
// so every window is one clean 30 seconds and a sentence cut at a seam is caught by the next one.
const CHUNK_SECONDS = 22;
const OVERLAP_SECONDS = 8;
const SAMPLE_RATE = 16000;

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  anthropicKey: '', model: 'claude-sonnet-5-5', githubToken: '',
  repo: 'Powered-By-Elevate/agentic-os@notes-inbox', whisper: 'onnx-community/whisper-base.en',
  liveCaptions: false, deleteAudio: false, pencil: 'ink',
  // company and project names only by default: people's names go in on the iPad, in Settings
  vocab: 'True North, TNK12, Elevate, True Places, PAMG, GMW, Essentia, The Timberley, West Alley, Twenty3Twenty, Project i61, Riverbend, Libertas, Woodruff, Heartwood, proforma, rent roll, draw request, Sage Intacct, Procore, Velixo, Core BI',
};

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('notes.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
let settings = readSettings();
function saveSettings(s) {
  settings = { ...settings, ...s };
  try { localStorage.setItem('notes.settings', JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- storage (IndexedDB)

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('meeting-notes', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('meetings', { keyPath: 'id' });
      const a = d.createObjectStore('audio', { keyPath: 'key' });
      a.createIndex('meeting', 'meeting');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const put = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
const del = (store, k) => tx(store, 'readwrite', (s) => s.delete(k));
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const audioFor = (id) => tx('audio', 'readonly', (s) => s.index('meeting').getAll(id));

// ---------------------------------------------------------------- the meeting model

function newMeeting() {
  const now = Date.now();
  return {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    title: '', company: '', people: '', template: 'general',
    created: now, updated: now,
    lines: [],          // [{text, t}] t = ms into the recording when the line was first typed
    ink: [],            // Pencil strokes, see ink.js: [{id, tool, color, w, t, at, end, pts}]
    durationMs: 0,      // total recorded so far, across every take
    chunks: 0,          // 22-second audio pieces saved
    transcript: [],     // [{t0, t1, text, seq}] from Whisper
    captions: [],       // [{t, text}] Safari's live captions, replaced by Whisper's
    enhanced: null,     // {md, model, at}
    qa: [],             // [{q, a, at}]
    synced: null,       // {at, sha}
  };
}

// Keep each line's first-typed time as the line is edited. Unchanged lines keep their stamp by
// content, a line edited in place keeps the stamp of the line it replaced, a new line gets now.
export function restamp(oldLines, text, now) {
  const lines = text.split('\n');
  const pool = new Map();
  oldLines.forEach((l, i) => {
    const k = l.text.trim();
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(i);
  });
  const used = new Set();
  const out = lines.map((t) => {
    const q = pool.get(t.trim());
    if (q && q.length) { const i = q.shift(); used.add(i); return { text: t, t: oldLines[i].t, i }; }
    return { text: t, t: undefined, i: -1 };
  });
  out.forEach((l, i) => {
    if (l.t !== undefined) return;
    const prev = oldLines[i];
    if (prev && !used.has(i) && prev.t != null && l.text.trim()) { used.add(i); l.t = prev.t; }
    else l.t = l.text.trim() ? now : null;
  });
  return out.map(({ text, t }) => ({ text, t: t ?? null }));
}

export function clock(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
}

export function transcriptText(m) {
  const segs = m.transcript.length ? m.transcript : m.captions.map((c) => ({ t0: c.t, text: c.text }));
  return segs.map((s) => `[${clock(s.t0)}] ${s.text}`).join('\n');
}
export function notesText(m) {
  return m.lines.filter((l) => l.text.trim()).map((l) => (l.t != null ? `[${clock(l.t)}] ` : '') + l.text).join('\n');
}

// ---------------------------------------------------------------- state and UI helpers

const state = { meetings: [], cur: null, tab: 'timeline', view: 'pad', query: '' };
let saveTimer = null;

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function status(text, warn = false) {
  const s = $('#status');
  s.textContent = '';
  if (!text) return;
  const span = document.createElement('span');
  if (warn) span.className = 'warn';
  span.textContent = text;
  s.appendChild(span);
}

function touch(m) {
  m.updated = Date.now();
  // a save at most 400 ms after the first change, so steady writing is saved as it goes
  if (pending && pending !== m) flush();
  pending = m;
  saveTimer ||= setTimeout(flush, 400);
}
// the last edit is written at once when the app is hidden or closed, not lost with the timer
let pending = null;
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const m = pending;
  pending = null;
  if (m) put('meetings', m).then(renderList);
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- the list

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function matches(m, q) {
  if (!q) return true;
  const hay = [m.title, m.people, m.company, ...m.lines.map((l) => l.text), ...m.transcript.map((s) => s.text), m.enhanced?.md || '']
    .join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function renderList() {
  const list = $('#list');
  const ms = state.meetings.filter((m) => matches(m, state.query)).sort((a, b) => b.created - a.created);
  let html = '', last = '';
  for (const m of ms) {
    const day = dayLabel(m.created);
    if (day !== last) { html += `<div class="day">${esc(day)}</div>`; last = day; }
    const dot = rec.meeting === m.id ? 'rec' : (m.synced && m.synced.at >= m.updated ? 'ok' : 'wait');
    const time = new Date(m.created).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    html += `<button class="item${state.cur && state.cur.id === m.id ? ' on' : ''}" data-id="${m.id}">
      <b>${esc(m.title || 'Untitled meeting')}</b>
      <small><span class="dot ${dot}"></span>${esc(time)}${m.company ? ' · ' + esc(m.company) : ''}${m.durationMs ? ' · ' + clock(m.durationMs) : ''}</small></button>`;
  }
  list.innerHTML = html || `<p class="hint" style="padding:8px">${state.query ? 'Nothing matches.' : 'No meetings yet.'}</p>`;
  const unsynced = state.meetings.filter((m) => !m.synced || m.synced.at < m.updated).length;
  $('#syncState').textContent = !settings.githubToken ? 'Sync is off until a GitHub token is in Settings'
    : unsynced ? `${unsynced} meeting${unsynced > 1 ? 's' : ''} waiting to sync` : 'Everything is synced';
  $('#syncState').classList.toggle('good', !!settings.githubToken && !unsynced);
}

// ---------------------------------------------------------------- open a meeting

// A meeting with nothing in it: no title, people, notes, audio or record. These are left behind
// by opening the app or tapping + by mistake, and are never kept or synced.
export function isEmpty(m) {
  return !m.title.trim() && !m.people.trim() && !m.lines.some((l) => l.text.trim()) && !m.ink?.length && !m.chunks && !m.enhanced && !m.qa.length;
}

async function forget(m, { remote = true } = {}) {
  state.meetings = state.meetings.filter((x) => x.id !== m.id);
  for (const p of await audioFor(m.id)) await del('audio', p.key);
  await del('meetings', m.id);
  if (remote && m.synced?.path && settings.githubToken) {
    // best effort: the synced copy goes too, and a failure leaves only a file the OS ignores
    try {
      const [repo, branch = 'notes-inbox'] = settings.repo.split('@');
      const f = await gh(`/repos/${repo}/contents/${m.synced.path}?ref=${branch}`);
      if (f) await gh(`/repos/${repo}/contents/${m.synced.path}`, { method: 'DELETE', body: JSON.stringify({ message: `Notes: delete ${m.title || 'Untitled meeting'}`, sha: f.sha, branch }) });
      if (m.synced.inkPath) await ghDelete(repo, branch, m.synced.inkPath, 'Notes: delete handwriting');
    } catch { /* offline or refused */ }
  }
}

async function dropIfEmpty(m) {
  if (m && rec.meeting !== m.id && isEmpty(m)) await forget(m, { remote: false });
}

function showEmpty() {
  state.cur = null;
  $('#meeting').hidden = true;
  $('#empty').hidden = false;
  renderList();
}

async function removeCurrent() {
  const m = state.cur;
  if (!m) return;
  if (!isEmpty(m) && !confirm(`Delete "${m.title || 'Untitled meeting'}"? Its notes, transcript, audio and synced copy all go.`)) return;
  if (rec.meeting === m.id) await stopRecording();
  work.queue = work.queue.filter((j) => j.meeting !== m.id);
  await forget(m);
  showEmpty();
  toast('Meeting deleted.');
}

// The title wraps instead of running off the page, and each select is as wide as its words.
function fitTitle() {
  const t = $('#title');
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 'px';
}
const ruler = document.createElement('canvas').getContext('2d');
function fitSelect(sel) {
  const cs = getComputedStyle(sel);
  ruler.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const text = sel.options[sel.selectedIndex]?.text || '';
  sel.style.width = Math.ceil(ruler.measureText(text).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2) + 'px';
}

function fitPad() {
  const p = $('#pad');
  p.style.height = 'auto';
  p.style.height = p.scrollHeight + 'px';
}

function open(m) {
  if (state.cur && state.cur !== m) dropIfEmpty(state.cur);
  state.cur = m;
  $('#empty').hidden = true;
  $('#meeting').hidden = false;
  $('#app').classList.remove('list-open');
  $('#title').value = m.title;
  $('#company').value = m.company;
  $('#template').value = m.template;
  fitTitle();
  fitSelect($('#company'));
  fitSelect($('#template'));
  $('#people').value = m.people;
  $('#pad').value = m.lines.map((l) => l.text).join('\n');
  m.ink ||= [];
  fitPad();
  ink.set(m.ink);
  $('#when').textContent = new Date(m.created).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  state.view = 'pad';
  status('');
  renderRec();
  renderList();
  renderPane();
  queueUntranscribed(m);
}

async function create() {
  // an empty meeting already open is reused, so + never stacks up blanks
  if (state.cur && isEmpty(state.cur) && rec.meeting !== state.cur.id) { $('#title').focus(); return; }
  const m = newMeeting();
  state.meetings.push(m);
  // open first, save after: typing straight after Command K must land in the new meeting
  open(m);
  $('#title').focus();
  await put('meetings', m);
}

// ---------------------------------------------------------------- recording

const rec = { meeting: null, ctx: null, stream: null, node: null, buf: [], startedAt: 0, base: 0, wake: null, timer: 0, speech: null, interim: '' };

function elapsed() {
  return rec.meeting ? rec.base + (Date.now() - rec.startedAt) : null;
}

async function startRecording() {
  const m = state.cur;
  if (!m) return;
  if (!navigator.mediaDevices?.getUserMedia) { status('This browser cannot record. Open the app in Safari.', true); return; }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (err) {
    status('The microphone was refused. Allow it in Settings, Safari, Microphone, then try again.', true);
    return;
  }
  // a 16 kHz context lets the browser resample properly. Where it refuses, the worklet does it.
  let ctx, src;
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    src = ctx.createMediaStreamSource(rec.stream);
  } catch {
    try { ctx?.close(); } catch { /* never opened */ }
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(rec.stream);
  }
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  // Safari can open the context paused after the microphone prompt
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  // the live waveform on the record button
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  node.port.onmessage = (e) => onSecond(e.data);
  Object.assign(rec, { meeting: m.id, ctx, node, analyser, buf: [], startedAt: Date.now(), base: m.durationMs });
  document.body.classList.add('listening');
  drawWave();
  try { rec.wake = await navigator.wakeLock?.request('screen'); } catch { /* not offered */ }
  rec.timer = setInterval(renderRec, 500);
  if (settings.liveCaptions) startCaptions();
  renderRec();
  renderList();
  status('Recording. Keep the app open and the screen on while it records.');
}

// Twenty-two bars that follow the voice, smoothed so they glide rather than flicker.
const bars = new Array(22).fill(0);
function drawWave() {
  const c = $('#wave');
  const an = rec.analyser;
  if (!an || !c) return;
  const g = c.getContext('2d');
  const data = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(data);
  const step = Math.floor(data.length / bars.length);
  for (let i = 0; i < bars.length; i++) {
    let s = 0;
    for (let j = 0; j < step; j++) { const v = (data[i * step + j] - 128) / 128; s += v * v; }
    const lvl = Math.min(1, Math.sqrt(s / step) * 5);
    bars[i] += (lvl - bars[i]) * 0.35;
  }
  g.clearRect(0, 0, c.width, c.height);
  const w = c.width / bars.length;
  g.fillStyle = '#ffffff';
  bars.forEach((b, i) => {
    const h = Math.max(4, b * c.height * 0.95);
    const x = i * w + w * 0.22, y = (c.height - h) / 2, bw = w * 0.56;
    g.globalAlpha = 0.55 + b * 0.45;
    g.beginPath();
    g.roundRect ? g.roundRect(x, y, bw, h, bw / 2) : g.rect(x, y, bw, h);
    g.fill();
  });
  requestAnimationFrame(drawWave);
}

function onSecond(int16) {
  rec.buf.push(int16);
  // level of this second of audio
  let sum = 0;
  for (let i = 0; i < int16.length; i += 8) sum += (int16[i] / 32768) ** 2;
  const rms = Math.sqrt(sum / (int16.length / 8));
  rec.peak = Math.max(rec.peak || 0, rms);
  if (rec.buf.length >= CHUNK_SECONDS) flushChunk();
}

async function flushChunk(final = false) {
  const m = state.meetings.find((x) => x.id === rec.meeting);
  if (!m || !rec.buf.length) return;
  const secs = rec.buf.length;
  const data = new Int16Array(secs * SAMPLE_RATE);
  rec.buf.forEach((s, i) => data.set(s, i * SAMPLE_RATE));
  rec.buf = [];
  const seq = m.chunks++;
  // pieces are written in order, so each starts where the last ended, the first at the take's start
  const startMs = m._chunkEnd ?? m.durationMs;
  m._chunkEnd = startMs + secs * 1000;
  const piece = { key: m.id + ':' + seq, meeting: m.id, seq, startMs, ms: secs * 1000, data, transcribed: false, final };
  await put('audio', piece);
  touch(m);
  transcribeLater(m, piece);
}

async function stopRecording() {
  if (!rec.meeting) return;
  const m = state.meetings.find((x) => x.id === rec.meeting);
  rec.node.port.onmessage = null;
  await flushChunk(true);
  rec.stream.getTracks().forEach((t) => t.stop());
  try { await rec.ctx.close(); } catch { /* already closed */ }
  try { await rec.wake?.release(); } catch { /* gone */ }
  stopCaptions();
  clearInterval(rec.timer);
  if (m) { m.durationMs = elapsed(); delete m._chunkEnd; touch(m); }
  rec.meeting = null;
  rec.analyser = null;
  document.body.classList.remove('listening');
  renderRec();
  renderList();
  status(work.queue.length || work.busy ? 'Stopped. Finishing the transcript.' : 'Stopped.');
}

function renderRec() {
  const on = !!rec.meeting && state.cur && rec.meeting === state.cur.id;
  const other = !!rec.meeting && !on;
  $('#recBtn').classList.toggle('on', on);
  $('#recBtn').disabled = other;
  const ms = on ? elapsed() : state.cur?.durationMs || 0;
  $('#recLabel').textContent = on ? 'Stop ' + clock(ms) : other ? 'Recording elsewhere' : ms ? 'Record more · ' + clock(ms) : 'Record';
  $('#wave').hidden = !on;
}

// Safari's own speech recognition: fast captions while Whisper catches up. Unreliable on iPad
// and missing in some home-screen apps, so it is optional and Whisper's transcript replaces it.
function startCaptions() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { status('Live captions are not available here. Whisper still transcribes.', true); return; }
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = 'en-US';
  r.onresult = (e) => {
    const m = state.meetings.find((x) => x.id === rec.meeting);
    if (!m) return;
    rec.interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) { m.captions.push({ t: elapsed(), text: res[0].transcript.trim() }); touch(m); }
      else rec.interim += res[0].transcript;
    }
    if (state.tab === 'timeline') renderPane();
  };
  r.onerror = (e) => { if (e.error === 'not-allowed') rec.speech = null; };
  r.onend = () => { if (rec.speech === r && rec.meeting) setTimeout(() => { try { r.start(); } catch { /* restarting */ } }, 250); };
  rec.speech = r;
  try { r.start(); } catch { rec.speech = null; }
}
function stopCaptions() {
  const r = rec.speech;
  rec.speech = null;
  rec.interim = '';
  try { r?.stop(); } catch { /* stopped */ }
}

// ---------------------------------------------------------------- transcription (Whisper on the iPad)

const work = { worker: null, queue: [], busy: null, ready: false, device: '' };

function worker() {
  if (work.worker) return work.worker;
  const w = new Worker('whisper-worker.js', { type: 'module' });
  w.onmessage = (e) => onWorker(e.data);
  w.onerror = (e) => {
    // the engine could not load (no connection the first time, or a blocked download): keep the
    // piece queued, and a fresh worker retries on the next start or when the meeting reopens
    e.preventDefault?.();
    status('The transcription engine could not load. Check the connection. The audio is saved and transcribes once it can.', true);
    if (work.busy) work.queue.unshift(work.busy);
    work.busy = null;
    work.worker?.terminate();
    work.worker = null;
  };
  work.worker = w;
  return w;
}

function transcribeLater(m, piece) {
  if (piece.transcribed) return;
  if (work.queue.some((p) => p.key === piece.key) || work.busy?.key === piece.key) return;
  work.queue.push({ key: piece.key, meeting: m.id });
  pump();
}

async function queueUntranscribed(m) {
  const pieces = await audioFor(m.id);
  pieces.sort((a, b) => a.seq - b.seq).filter((p) => !p.transcribed).forEach((p) => transcribeLater(m, p));
}

async function pump() {
  if (work.busy || !work.queue.length) return;
  const job = work.queue.shift();
  work.busy = job; // set before any await, so the queue never looks idle between pieces
  const piece = await tx('audio', 'readonly', (s) => s.get(job.key));
  if (!piece) { work.busy = null; return pump(); }
  // skip near-silence: Whisper invents words when there are none
  let sum = 0;
  for (let i = 0; i < piece.data.length; i += 16) sum += (piece.data[i] / 32768) ** 2;
  const rms = Math.sqrt(sum / (piece.data.length / 16));
  if (rms < 0.003) {
    onWorker({ type: 'result', id: job.key, segments: [] });
    return;
  }
  // a sentence spoken across the seam between two pieces would be cut in half, so each piece is
  // heard with the last few seconds of the one before, and repeated words are dropped on return
  const prev = piece.seq > 0 ? await tx('audio', 'readonly', (s) => s.get(piece.meeting + ':' + (piece.seq - 1))) : null;
  const lead = prev && prev.startMs + prev.ms === piece.startMs ? prev.data.subarray(Math.max(0, prev.data.length - OVERLAP_SECONDS * SAMPLE_RATE)) : new Int16Array(0);
  // the last piece of a take gets a second of silence, so its final sentence can close
  const tail = piece.final ? SAMPLE_RATE : 0;
  const audio = new Float32Array(lead.length + piece.data.length + tail);
  for (let i = 0; i < lead.length; i++) audio[i] = lead[i] / 32768;
  for (let i = 0; i < piece.data.length; i++) audio[lead.length + i] = piece.data[i] / 32768;
  const offsetMs = piece.startMs - Math.round((lead.length / SAMPLE_RATE) * 1000);
  worker().postMessage({ type: 'run', id: job.key, audio, offsetMs, model: settings.whisper, loud: rms > 0.01 }, [audio.buffer]);
  showWork();
}

function showWork() {
  if (!state.cur) return;
  const mine = work.queue.filter((j) => j.meeting === state.cur.id).length + (work.busy?.meeting === state.cur.id ? 1 : 0);
  if (!mine) return;
  if (!work.ready) status('Getting the transcription model ready. The first time downloads it, then it stays on this iPad.');
  else if (!rec.meeting) status(`Transcribing, ${mine} piece${mine > 1 ? 's' : ''} to go.`);
}

async function onWorker(msg) {
  if (msg.type === 'progress') {
    // the model comes as several files: count the big ones together so the number only climbs
    work.dl = work.dl || {};
    work.dl[msg.file] = [msg.loaded, msg.total];
    const parts = Object.values(work.dl).filter(([, tot]) => tot > 5e6);
    const got = parts.reduce((n, [l]) => n + l, 0), all = parts.reduce((n, [, tot]) => n + tot, 0);
    if (all && state.cur) status(`Setting up transcription on this iPad, ${Math.round(got / 1e6)} of ${Math.round(all / 1e6)} MB. This happens once.`);
    return;
  }
  if (msg.type === 'ready') { work.ready = true; work.device = msg.device; return; }
  const job = work.busy;
  work.busy = null;
  if (msg.type === 'error') {
    status('Transcription stopped: ' + msg.message, true);
    if (job) work.queue.unshift(job);
    return; // the next start, or reopening the meeting, retries
  }
  work.ready = true;
  const piece = await tx('audio', 'readonly', (s) => s.get(msg.id));
  const m = state.meetings.find((x) => x.id === job?.meeting);
  if (piece && m) {
    // a segment that ends before the piece before it did is a repeat from the overlap, so it goes
    const earlier = m.transcript.filter((s) => s.seq < piece.seq);
    const before = earlier.reduce((n, s) => Math.max(n, s.t1), -Infinity);
    const tailText = earlier.slice(-4).map((s) => s.text).join(' ');
    const fresh = msg.segments.filter((s) => s.t1 > before + 500)
      .map((s) => (s.t0 < before ? { ...s, text: trimRepeat(tailText, s.text) } : s))
      .filter((s) => s.text);
    m.transcript = m.transcript.filter((s) => s.seq !== piece.seq)
      .concat(fresh.map((s) => ({ ...s, seq: piece.seq })))
      .sort((a, b) => a.t0 - b.t0);
    // Whisper's text replaces the live captions it covers
    const end = piece.startMs + piece.ms;
    m.captions = m.captions.filter((c) => c.t > end);
    piece.transcribed = true;
    if (settings.deleteAudio) await del('audio', piece.key);
    else await put('audio', piece);
    touch(m);
    if (state.cur?.id === m.id && state.tab === 'timeline') renderPane();
  }
  if (!work.queue.length && !rec.meeting && state.cur?.id === m?.id) status('Transcript is up to date.');
  pump();
}

// Words a segment repeats from the end of the transcript before it (heard twice in the overlap).
export function trimRepeat(prev, next) {
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9%]/g, '');
  const p = prev.split(/\s+/).filter(Boolean).slice(-40).map(norm);
  const words = next.split(/\s+/).filter(Boolean);
  const n = words.map(norm);
  // the same word heard twice can come back spelled two ways ("Timberley", "timberly")
  const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && dist(a, b) <= 2);
  const runAt = (i, k) => { for (let j = 0; j < k; j++) if (!same(p[i + j], n[j])) return false; return true; };
  // the longest run that starts this segment and also appears in the last words before it
  let best = 0;
  for (let k = Math.min(n.length, p.length); k >= 3 && !best; k--) {
    for (let i = 0; i + k <= p.length; i++) if (runAt(i, k)) { best = k; break; }
  }
  return words.slice(best).join(' ');
}

function dist(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

// ---------------------------------------------------------------- playback: tap a line to hear it

let player = null;
async function playFrom(m, ms) {
  const pieces = (await audioFor(m.id)).sort((a, b) => a.seq - b.seq);
  const from = pieces.findIndex((p) => p.startMs + p.ms > ms);
  if (from < 0) { toast(pieces.length ? 'No audio at that moment.' : 'The audio for this meeting was deleted.'); return; }
  const take = pieces.slice(from, from + 27); // about ten minutes
  const skip = Math.max(0, Math.floor(((ms - take[0].startMs) / 1000) * SAMPLE_RATE) - SAMPLE_RATE * 2);
  const total = take.reduce((n, p) => n + p.data.length, 0) - skip;
  const pcm = new Int16Array(total);
  let o = 0;
  take.forEach((p, i) => { const d = i === 0 ? p.data.subarray(skip) : p.data; pcm.set(d, o); o += d.length; });
  if (player) { player.pause(); URL.revokeObjectURL(player.src); }
  player = new Audio(URL.createObjectURL(wav(pcm)));
  player.play().catch(() => toast('Tap again to play.'));
}

function wav(pcm) {
  const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
  const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(b, 44).set(pcm);
  return new Blob([b], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- the right-hand panes

function renderPane() {
  const m = state.cur;
  if (!m) return;
  // the page shows your notes or Claude's, the drawer the transcript or Ask
  $$('.view').forEach((v) => { v.classList.toggle('on', v.dataset.view === state.view); v.classList.toggle('has', v.dataset.view === 'notes' && !!m.enhanced); });
  $('#write').hidden = state.view !== 'pad';
  $('#tools').hidden = state.view !== 'pad';
  if (state.view === 'pad') { fitPad(); ink.fit(); }
  $('#pane-notes').hidden = state.view !== 'notes';
  if (state.view === 'notes') renderNotes(m);
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === state.tab));
  ['timeline', 'ask'].forEach((t) => { $('#pane-' + t).hidden = t !== state.tab; });
  if (state.tab === 'timeline') renderTimeline(m);
  if (state.tab === 'ask') renderAsk(m);
}

// Your lines and the transcript on one clock, the way Granola shows them.
function renderTimeline(m) {
  const items = [];
  m.lines.forEach((l) => { if (l.text.trim()) items.push({ t: l.t, kind: 'mine', text: l.text }); });
  m.transcript.forEach((s) => items.push({ t: s.t0, kind: 'theirs', text: s.text }));
  m.captions.forEach((c) => items.push({ t: c.t, kind: 'live', text: c.text }));
  groups(m.ink || []).forEach((g) => items.push({ t: g.t, kind: 'ink', img: inkThumb(g) }));
  // lines typed before the recording started have no time and come first
  items.sort((a, b) => (a.t ?? -1) - (b.t ?? -1));
  const pane = $('#pane-timeline');
  if (!items.length) {
    pane.innerHTML = `<p class="hint">Hit Record and type in the notepad. Your lines show here in bold on the meeting's clock, with the transcript between them. Tap any line to hear that moment.</p>`;
    return;
  }
  const live = rec.interim && rec.meeting === m.id ? `<li><time>${clock(elapsed())}</time><span class="live">${esc(rec.interim)}</span></li>` : '';
  pane.innerHTML = `<ul class="tl">${items.map((x) => `<li class="${x.t != null ? 'can' : ''}" data-t="${x.t ?? ''}"><time>${clock(x.t)}</time><span class="${x.kind}">${x.img ? `<img src="${x.img}" alt="Handwritten note">` : esc(x.text)}</span></li>`).join('')}${live}</ul>`;
}

// A handwritten note as a small picture for the transcript, drawn once per version of the note.
const thumbs = new Map();
function inkThumb(g) {
  const key = `${g.id}:${g.strokes.length}:${matchMedia('(prefers-color-scheme: dark)').matches}`;
  if (!thumbs.has(key)) thumbs.set(key, render(g.strokes, { scale: 1, pad: 6, maxPx: 900 }).toDataURL('image/png'));
  return thumbs.get(key);
}

function renderNotes(m) {
  const pane = $('#pane-notes');
  const actions = `<div class="pane-actions">
    <button class="btn primary" id="enhanceBtn">${m.enhanced ? 'Enhance again' : 'Enhance notes'}<kbd>⌘E</kbd></button>
    ${m.enhanced ? '<button class="btn" id="copyBtn">Copy</button><button class="btn" id="shareBtn">Share</button>' : ''}
    <button class="btn" id="syncBtn">Sync now</button></div>`;
  const body = m.enhanced
    ? `<div class="md">${md(m.enhanced.md)}</div><p class="hint">Dark text is yours. Grey is Claude's. Written by ${esc(m.enhanced.model)}, ${new Date(m.enhanced.at).toLocaleString()}.</p>`
    : `<p class="hint">Enhance turns your notes and the transcript into the full record: summary, decisions, action items with owners, your notes filled out, and the moments worth quoting.${settings.anthropicKey ? '' : ' Add an Anthropic API key in Settings first, or leave it to the morning run, which writes the same note into the OS.'}</p>`;
  pane.innerHTML = actions + body;
}

function renderAsk(m) {
  const pane = $('#pane-ask');
  pane.innerHTML = `${m.qa.map((x) => `<div class="qa"><div class="q">${esc(x.q)}</div><div class="md">${md(x.a)}</div></div>`).join('')}
    <div class="ask"><textarea id="askBox" rows="2" placeholder="Ask about this meeting, or start with “all:” to ask across every meeting"></textarea>
    <button class="btn primary" id="askBtn">Ask</button></div>`;
}

// A small Markdown renderer: headings, lists, tables, bold, and [[your words]].
export function md(src) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  // [[your words]] stay dark, everything else in body text is Claude's and drawn grey
  const wrap = (s) => s.split(/(\[\[.+?\]\])/g).map((p) => {
    if (/^\[\[.+\]\]$/.test(p)) return '<mark>' + inline(p.slice(2, -2)) + '</mark>';
    return p.trim() ? '<span class="ai">' + inline(p) + '</span>' : esc(p);
  }).join('');
  const out = [];
  const lines = src.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3} /.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.slice(n + 1).replace(/\[\[|\]\]/g, ''))}</h${n}>`); continue; }
    if (/^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${wrap(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*] /.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ''));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${wrap(x)}</li>`).join('')}</ul>`);
      continue;
    }
    if (l.trim()) out.push(`<p>${wrap(l)}</p>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------- Claude

const NOTE_FORMAT = `Write the meeting record in Markdown, in exactly this shape:

# <a short title for the meeting>

## Summary
Two to five sentences. Lead with the outcome or decision.

## Decisions
- One line per decision. Write "None recorded." if there were none.

## Action items
| Owner | Action | Due |
| --- | --- | --- |
One row per commitment. Owner as the person was named. Due only if a date was said, else blank.

## Notes
The user's notes, filled out with what the transcript adds, grouped by topic, as bullets.

## Transcript highlights
Up to six moments worth keeping, each a short exact quote with its [m:ss] time.

Rules:
- Wrap every word or phrase that comes from MY NOTES in [[double brackets]], so I can tell my words from yours. Everything else is yours.
- Never invent a name, number, date or commitment. If the transcript is unclear, write [?].
- The transcript has no speaker labels. Do not guess who said what unless the words make it plain.
- The transcript is machine-made and mishears names. If a word in it is plainly a mishearing of one of the EXPECTED NAMES, write the expected name. Correct nothing else.
- Never use em dashes or semicolons.`;

async function claude(messages, { system, onText, maxTokens = 4000 } = {}) {
  if (!settings.anthropicKey) throw new Error('Add an Anthropic API key in Settings.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: settings.model, max_tokens: maxTokens, system, messages, stream: true }),
  });
  if (!res.ok) {
    let msg = res.status + '';
    try { msg = (await res.json()).error?.message || msg; } catch { /* not json */ }
    throw new Error('Claude said: ' + msg);
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = ev.split('\n').find((x) => x.startsWith('data: '));
      if (!line) continue;
      const d = JSON.parse(line.slice(6));
      if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') { out += d.delta.text; onText?.(out); }
      if (d.type === 'error') throw new Error('Claude said: ' + d.error?.message);
    }
  }
  return out;
}

function meetingContext(m) {
  const t = TEMPLATES[m.template] || TEMPLATES.general;
  return `Meeting: ${m.title || 'Untitled'}
Date: ${new Date(m.created).toLocaleString()}
Company: ${COMPANIES.find((c) => c[0] === m.company)?.[1] || 'not set'}
People: ${m.people || 'not listed'}
Type: ${t[0]}. ${t[1]}

MY NOTES (typed during the meeting, [m:ss] is when I typed each line):
${notesText(m) || '(none)'}

EXPECTED NAMES (people, companies, projects and terms that come up): ${settings.vocab || 'none given'}

TRANSCRIPT ([m:ss] from the start of the recording):
${transcriptText(m) || '(no recording)'}`;
}

// The Pencil notes go to Claude as pictures, one per handwritten note with the time it was
// written, so Claude reads the handwriting itself. A page with a great many notes goes as
// slices of the whole page instead.
const png = (c) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.toDataURL('image/png').split(',')[1] } });
export function inkContent(m) {
  const gs = groups(m.ink || []);
  if (!gs.length) return [];
  const out = [{ type: 'text', text: 'MY HANDWRITING: notes I wrote with the Apple Pencil, as pictures. They are part of MY NOTES: read them and treat their words exactly like typed notes, in [[double brackets]]. Write [?] for a word you cannot read.' }];
  if (gs.length <= 24) {
    for (const g of gs) {
      out.push({ type: 'text', text: g.t != null ? `Written at [${clock(g.t)}]:` : 'Written before the recording started:' });
      out.push(png(render(g.strokes, { scale: 1.3, bg: '#fff', css: PAPER, maxPx: 1568 })));
    }
  } else {
    const all = m.ink.filter((x) => x.tool !== 'highlight');
    const b = bounds(all);
    for (let y = Math.max(0, b.y0); y < b.y1; y += 1200) {
      out.push({ type: 'text', text: `The page, from ${Math.round(y)} down:` });
      out.push(png(render(all, { box: { x0: 0, y0: y, x1: UNITS, y1: Math.min(b.y1, y + 1200) }, scale: 1.2, bg: '#fff', css: PAPER, maxPx: 1568 })));
    }
  }
  return out;
}
function withInk(m, text, after = '') {
  const ink = inkContent(m);
  if (!ink.length) return text + after;
  return [{ type: 'text', text }, ...ink, ...(after ? [{ type: 'text', text: after.trim() }] : [])];
}

async function enhance() {
  const m = state.cur;
  if (!m) return;
  if (!m.lines.some((l) => l.text.trim()) && !m.ink?.length && !m.transcript.length && !m.captions.length) { toast('Write some notes or record first.'); return; }
  if (work.queue.some((j) => j.meeting === m.id) || work.busy?.meeting === m.id) toast('The transcript is still finishing. Enhancing with what is done so far.');
  state.view = 'notes';
  renderPane();
  const btn = $('#enhanceBtn');
  btn.disabled = true;
  btn.innerHTML = 'Writing<span class="writing"><i></i><i></i><i></i></span>';
  const pane = $('#pane-notes');
  const live = document.createElement('div');
  live.className = 'md';
  pane.appendChild(live);
  try {
    const out = await claude([{ role: 'user', content: withInk(m, meetingContext(m)) }], {
      system: 'You write meeting records for Matt Knowles, a financial analyst at True North Companies. ' + NOTE_FORMAT,
      onText: (t) => { live.innerHTML = md(t); },
    });
    m.enhanced = { md: out, model: settings.model, at: Date.now() };
    if (!m.title) { const h = out.match(/^# (.+)$/m); if (h) { m.title = h[1].replace(/\[\[|\]\]/g, '').trim(); $('#title').value = m.title; } }
    touch(m);
    renderPane();
    sync(m).catch(() => {});
  } catch (err) {
    live.remove();
    btn.disabled = false;
    btn.textContent = 'Enhance notes';
    toast(err.message, 5000);
  }
}

async function ask() {
  const m = state.cur;
  const box = $('#askBox');
  let q = box.value.trim();
  if (!q) return;
  const all = /^all:/i.test(q);
  if (all) q = q.replace(/^all:\s*/i, '');
  const context = all
    ? state.meetings.sort((a, b) => b.created - a.created).slice(0, 40).map((x) =>
      `=== ${x.title || 'Untitled'} (${new Date(x.created).toLocaleDateString()}, ${x.company || 'no company'})\n${(x.enhanced?.md || notesText(x) + '\n' + transcriptText(x)).slice(0, 4000)}`).join('\n\n')
    : meetingContext(m) + (m.enhanced ? '\n\nTHE WRITTEN RECORD:\n' + m.enhanced.md : '');
  const entry = { q: (all ? 'All meetings: ' : '') + q, a: '', at: Date.now() };
  m.qa.push(entry);
  renderPane();
  const last = $$('#pane-ask .qa .md').pop();
  try {
    entry.a = await claude([{ role: 'user', content: all ? context + '\n\nQUESTION: ' + q : withInk(m, context, '\n\nQUESTION: ' + q) }], {
      system: 'Answer from the meeting material only. Quote exact words where they matter and give the [m:ss] time. If it is not in the material, say so. Be brief. Never use em dashes or semicolons.',
      maxTokens: 1500,
      onText: (t) => { if (last) last.innerHTML = md(t); },
    });
  } catch (err) {
    entry.a = err.message;
  }
  touch(m);
  renderPane();
  $('#askBox')?.focus();
}

// ---------------------------------------------------------------- sync into the Agentic OS repo

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gh(path, init = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: { authorization: 'Bearer ' + settings.githubToken, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers || {}) },
  });
  if (res.status === 404 && (!init.method || init.method === 'GET')) return null;
  if (!res.ok) throw new Error('GitHub said ' + res.status + ': ' + ((await res.json().catch(() => ({}))).message || ''));
  return res.json();
}

export function slug(m) {
  const d = new Date(m.created);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const words = (m.title || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  return `${day}-${words || 'meeting'}-${m.id.slice(-6)}`;
}

async function ghDelete(repo, branch, path, message) {
  const f = await gh(`/repos/${repo}/contents/${path}?ref=${branch}`);
  if (f) await gh(`/repos/${repo}/contents/${path}`, { method: 'DELETE', body: JSON.stringify({ message, sha: f.sha, branch }) });
}

// The whole Pencil page as one picture beside the meeting's file, so the note in the OS shows it.
async function syncInk(m, repo, branch, base) {
  const path = base.replace(/\.json$/, '.ink.png');
  const had = m.synced?.inkPath;
  if (had && had !== path) await ghDelete(repo, branch, had, 'Notes: rename handwriting');
  if (!m.ink?.length) {
    if (had === path) await ghDelete(repo, branch, path, 'Notes: handwriting removed');
    return {};
  }
  if (had === path && m.synced.inkAt >= (m.inkUpdated || 0)) return { inkPath: path, inkAt: m.synced.inkAt };
  const b = bounds(m.ink);
  const pic = render(m.ink, { box: { x0: 0, y0: 0, x1: UNITS, y1: Math.max(b.y1, 400) }, scale: 1.2, pad: 24, bg: '#fff', css: PAPER });
  const existing = await gh(`/repos/${repo}/contents/${path}?ref=${branch}`);
  await gh(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `Notes: handwriting for ${m.title || 'Untitled meeting'}`, content: pic.toDataURL('image/png').split(',')[1], branch, ...(existing ? { sha: existing.sha } : {}) }),
  });
  return { inkPath: path, inkAt: Date.now() };
}

async function sync(m, quiet = true) {
  if (!settings.githubToken) { if (!quiet) toast('Add a GitHub token in Settings to sync.'); return; }
  const [repo, branch = 'notes-inbox'] = settings.repo.split('@');
  // the branch is made from main the first time
  if (!(await gh(`/repos/${repo}/git/ref/heads/${branch}`))) {
    const main = await gh(`/repos/${repo}/git/ref/heads/main`);
    await gh(`/repos/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: main.object.sha }) });
  }
  const path = `os-vault/notes/inbox/${slug(m)}.json`;
  if (m.synced?.path && m.synced.path !== path) {
    // the title changed: the old file goes
    const old = await gh(`/repos/${repo}/contents/${m.synced.path}?ref=${branch}`);
    if (old) await gh(`/repos/${repo}/contents/${m.synced.path}`, { method: 'DELETE', body: JSON.stringify({ message: `Notes: rename ${m.synced.path}`, sha: old.sha, branch }) });
  }
  const inkFile = await syncInk(m, repo, branch, path);
  const existing = await gh(`/repos/${repo}/contents/${path}?ref=${branch}`);
  const { _chunkEnd, ...doc } = m;
  const body = JSON.stringify({ schema: 1, ...doc, inkImage: inkFile.inkPath || null, companyName: COMPANIES.find((c) => c[0] === m.company)?.[1] || '' }, null, 2) + '\n';
  const at = Date.now();
  const r = await gh(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `Notes: ${m.title || 'Untitled meeting'}`, content: b64(body), branch, ...(existing ? { sha: existing.sha } : {}) }),
  });
  m.synced = { at, sha: r.content.sha, path, ...inkFile };
  await put('meetings', m);
  renderList();
  if (!quiet) toast('Synced to ' + branch + '.');
}

async function syncAll() {
  if (!settings.githubToken || !navigator.onLine) return;
  for (const m of state.meetings) {
    if (rec.meeting === m.id || isEmpty(m)) continue;
    if (!m.synced || m.synced.at < m.updated) {
      try { await sync(m); } catch (err) { $('#syncState').textContent = err.message; return; }
    }
  }
}

// ---------------------------------------------------------------- wiring

function fillSelects() {
  $('#company').innerHTML = COMPANIES.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('');
  $('#template').innerHTML = Object.entries(TEMPLATES).map(([k, [n]]) => `<option value="${k}">${esc(n)}</option>`).join('');
}

// ---------------------------------------------------------------- the Pencil

let ink = null;
let penSeen = false;
try { penSeen = localStorage.getItem('penSeen') === '1'; } catch { /* private mode */ }

function paintTools() {
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('sel', b.dataset.tool === ink.tool));
  $('#tools').classList.toggle('armed', ink.armed);
  $('#tools').classList.toggle('pen', penSeen && settings.pencil !== 'scribble');
  $('#write').classList.toggle('armed', ink.armed);
  $('#inkColor .swatch').className = 'swatch ' + ink.color;
}

function makeInk() {
  ink = new InkLayer($('#write'), {
    now: () => (state.cur && rec.meeting === state.cur.id ? elapsed() : null),
    mode: () => settings.pencil,
    onPen: () => {
      // once a Pencil has written here, tools only change what it draws and a finger never draws
      if (penSeen) return;
      penSeen = true;
      try { localStorage.setItem('penSeen', '1'); } catch { /* private mode */ }
      ink.armed = false;
      paintTools();
    },
    onChange: (strokes) => {
      const m = state.cur;
      if (!m) return;
      m.ink = strokes;
      m.inkUpdated = Date.now();
      touch(m);
      if (state.tab === 'timeline') renderTimeline(m);
    },
  });
}

function bindInk() {
  $$('.tool[data-tool]').forEach((b) => {
    b.onclick = () => {
      const same = ink.tool === b.dataset.tool;
      ink.tool = b.dataset.tool;
      // without a Pencil, a tool lets a finger or the mouse draw, and tapping it again stops
      if (!penSeen || settings.pencil === 'scribble') ink.armed = same ? !ink.armed : true;
      paintTools();
    };
  });
  $('#inkColor').onclick = () => {
    const order = ['ink', 'blue', 'red'];
    ink.color = order[(order.indexOf(ink.color) + 1) % order.length];
    if (ink.tool !== 'pen') ink.tool = 'pen';
    paintTools();
  };
  $('#inkUndo').onclick = () => { if (!ink.undo()) toast('Nothing to undo.'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ink.armed) { ink.armed = false; paintTools(); } });
  addEventListener('resize', () => { if (state.cur) fitPad(); });
  // the handwriting pictures in the transcript are drawn in the theme's ink
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.cur) renderPane(); });
  paintTools();
}

function bind() {
  $('#newBtn').onclick = create;
  $('#emptyNew').onclick = create;
  $('#listBtn').onclick = () => $('#app').classList.toggle('list-open');
  $('#delBtn').onclick = removeCurrent;
  $('#search').oninput = (e) => { state.query = e.target.value; renderList(); };
  $('#list').onclick = (e) => {
    const b = e.target.closest('.item');
    if (b) open(state.meetings.find((m) => m.id === b.dataset.id));
  };
  $('#title').oninput = (e) => { state.cur.title = e.target.value.replace(/\n/g, ' '); touch(state.cur); fitTitle(); };
  // Return in the title moves on to the notes, as it would in a one-line field
  $('#title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pad').focus(); } };
  addEventListener('resize', () => { if (state.cur) fitTitle(); });
  document.fonts?.ready.then(() => { if (state.cur) { fitTitle(); fitSelect($('#company')); fitSelect($('#template')); } });
  $('#people').oninput = (e) => { state.cur.people = e.target.value; touch(state.cur); };
  $('#company').onchange = (e) => { state.cur.company = e.target.value; touch(state.cur); fitSelect(e.target); };
  $('#template').onchange = (e) => { state.cur.template = e.target.value; touch(state.cur); fitSelect(e.target); };
  $('#pad').oninput = (e) => {
    fitPad();
    const m = state.cur;
    m.lines = restamp(m.lines, e.target.value, rec.meeting === m.id ? elapsed() : null);
    touch(m);
    if (state.tab === 'timeline') renderPane();
  };
  $('#recBtn').onclick = async () => {
    await (rec.meeting ? stopRecording() : startRecording());
    // back to typing: Return on a focused button would toggle the recording again
    $('#pad').focus();
  };
  $$('.tab').forEach((t) => { t.onclick = () => { state.tab = t.dataset.tab; renderPane(); }; });
  bindInk();
  $$('.view').forEach((v) => { v.onclick = () => { state.view = v.dataset.view; renderPane(); if (state.view === 'pad') $('#pad').focus(); }; });
  const drawer = (open) => {
    $('#stage').classList.toggle('closed', !open);
    $('#drawerBtn').classList.toggle('on', open);
    try { localStorage.setItem('drawer', open ? '1' : '0'); } catch {}
  };
  let saved = null;
  try { saved = localStorage.getItem('drawer'); } catch {}
  // on a narrow screen the drawer slides over the page, so it starts shut
  drawer(innerWidth > 1100 && saved !== '0');
  $('#drawerBtn').onclick = () => drawer($('#stage').classList.contains('closed'));
  $('#pane-timeline').onclick = (e) => {
    const li = e.target.closest('li.can');
    if (li && li.dataset.t !== '') playFrom(state.cur, +li.dataset.t);
  };
  $('#pane-notes').onclick = (e) => {
    const id = e.target.closest('button')?.id;
    const m = state.cur;
    if (id === 'enhanceBtn') enhance();
    if (id === 'copyBtn') navigator.clipboard.writeText(m.enhanced.md.replace(/\[\[|\]\]/g, '')).then(() => toast('Copied.'));
    if (id === 'shareBtn') navigator.share?.({ title: m.title, text: m.enhanced.md.replace(/\[\[|\]\]/g, '') }).catch(() => {});
    if (id === 'syncBtn') sync(m, false).catch((err) => toast(err.message, 5000));
  };
  $('#pane-ask').onclick = (e) => { if (e.target.id === 'askBtn') ask(); };
  $('#pane-ask').onkeydown = (e) => { if (e.target.id === 'askBox' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };

  $('#settingsBtn').onclick = () => {
    const f = $('#settingsForm');
    for (const [k, v] of Object.entries(settings)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
    $('#settings').showModal();
  };
  $('#settings').onclose = () => {
    if ($('#settings').returnValue !== 'save') return;
    const f = $('#settingsForm'), s = {};
    for (const k of Object.keys(DEFAULTS)) {
      const el = f.elements[k];
      if (el) s[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    saveSettings(s);
    renderList();
    if (state.cur) renderPane();
    syncAll();
  };

  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); create(); }
    else if (k === 'j' && state.cur) { e.preventDefault(); rec.meeting ? stopRecording() : startRecording(); }
    else if (k === 'e' && state.cur) { e.preventDefault(); enhance(); }
  });

  // a recording must not be lost when the iPad backgrounds the app
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && rec.meeting) flushChunk();
    if (!document.hidden) syncAll();
  });
  window.addEventListener('online', syncAll);
}

async function boot() {
  fillSelects();
  makeInk();
  bind();
  state.meetings = await getAll('meetings');
  // a recording cut off by a crash or a closed tab: its pieces are saved, the clock is not
  for (const m of state.meetings) {
    const pieces = await audioFor(m.id);
    const end = pieces.reduce((n, p) => Math.max(n, p.startMs + p.ms), 0);
    if (end > m.durationMs) { m.durationMs = end; await put('meetings', m); }
  }
  for (const m of [...state.meetings]) await dropIfEmpty(m);
  renderList();
  const last = state.meetings.sort((a, b) => b.updated - a.updated)[0];
  if (last && Date.now() - last.updated < 6 * 3600 * 1000) open(last);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  syncAll();
  window.__notes = { state, rec, work, settings: () => settings, saveSettings, restamp, md, slug, sync, enhance, isEmpty, removeCurrent, render: () => { renderList(); renderPane(); }, open, ink: () => ink, groups, inkContent };
}

boot();
