// Apple Pencil ink on the notes page.
//
// The Pencil always writes and a finger still scrolls and types, the way Apple Notes behaves:
// Safari reports the Pencil as pointerType "pen" (and its touches as touchType "stylus"), so only
// those are taken, and a palm resting on the glass while writing cannot scroll the page. Without a
// Pencil, tapping a tool lets a finger or mouse draw until the tool is tapped again.
//
// Strokes are stored in page units: x and y in thousandths of the page width, so the ink keeps its
// place and shape when the iPad turns. Each stroke carries t, the ms into the recording when it was
// started (null when not recording), exactly like a typed line, so handwriting lands on the
// meeting's clock.

export const UNITS = 1000;
const ERASE_R = 14;           // eraser reach, in page units
const GROUP_GAP_MS = 3000;    // a pause this long starts a new handwritten note
const GROUP_GAP_Y = 70;       // and so does writing this far above or below the last one

let seq = 0;
const newId = () => Date.now().toString(36) + (seq++).toString(36);

// ---------------------------------------------------------------- drawing

const COLORS = { ink: '--ink', blue: '--accent', red: '--rec' };
function colorOf(stroke, css) {
  if (stroke.tool === 'highlight') return css.highlight;
  return css[stroke.color] || css.ink;
}
export function themeColors(el = document.documentElement) {
  const cs = getComputedStyle(el);
  const out = {};
  for (const [k, v] of Object.entries(COLORS)) out[k] = cs.getPropertyValue(v).trim() || '#111';
  out.highlight = cs.getPropertyValue('--highlight').trim() || 'rgba(250, 204, 21, .4)';
  return out;
}

// One stroke onto a 2D context already scaled to page units. Pen strokes are drawn segment by
// segment so the width follows the Pencil's pressure; a highlighter is one flat path.
export function drawStroke(ctx, s, css) {
  const p = s.pts;
  if (!p.length) return;
  ctx.strokeStyle = ctx.fillStyle = colorOf(s, css);
  ctx.lineCap = ctx.lineJoin = 'round';
  if (s.tool === 'highlight') {
    ctx.save();
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i], p[i + 1]);
    if (p.length === 3) ctx.lineTo(p[0] + 0.1, p[1]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const width = (pr) => s.w * (0.45 + 0.9 * pr);
  if (p.length === 3) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], width(p[2]) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // midpoint quadratics smooth the line between samples: each piece runs from the middle of one
  // gap to the middle of the next, bending through the sample between them
  const n = p.length / 3;
  let sx = p[0], sy = p[1];
  for (let i = 1; i < n; i++) {
    const last = i === n - 1;
    const ex = last ? p[i * 3] : (p[i * 3] + p[i * 3 + 3]) / 2;
    const ey = last ? p[i * 3 + 1] : (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
    ctx.lineWidth = width(p[i * 3 + 2]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    if (last) ctx.lineTo(ex, ey);
    else ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], ex, ey);
    ctx.stroke();
    sx = ex; sy = ey;
  }
}

export function bounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const r = s.w;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1];
      if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r;
      if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r;
    }
  }
  return { x0, y0, x1, y1 };
}

// Strokes as a picture: for Claude (black on white), for the transcript (theme ink, clear), or
// the whole page for the repo. box is in page units, scale is pixels per page unit.
export function render(strokes, { box = bounds(strokes), scale = 1, pad = 12, bg = null, css = themeColors(), maxPx = 4096 } = {}) {
  const w = box.x1 - box.x0 + pad * 2, h = box.y1 - box.y0 + pad * 2;
  scale = Math.min(scale, maxPx / w, maxPx / h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * scale));
  c.height = Math.max(1, Math.ceil(h * scale));
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.setTransform(scale, 0, 0, scale, (pad - box.x0) * scale, (pad - box.y0) * scale);
  for (const s of strokes) if (s.tool === 'highlight') drawStroke(ctx, s, css);
  for (const s of strokes) if (s.tool !== 'highlight') drawStroke(ctx, s, css);
  return c;
}

export const PAPER = { ink: '#111111', blue: '#3b5bdb', red: '#e03131', highlight: 'rgba(250, 204, 21, .45)' };

// ---------------------------------------------------------------- handwritten notes

// Strokes written together become one note: a new note starts after a pause or when the Pencil
// moves to another part of the page. Highlighting is markup on the page, not a note.
export function groups(strokes) {
  const out = [];
  let g = null;
  for (const s of [...strokes].filter((x) => x.tool !== 'highlight').sort((a, b) => a.at - b.at)) {
    const b = bounds([s]);
    if (!g || s.at - g.end > GROUP_GAP_MS || b.y0 > g.box.y1 + GROUP_GAP_Y || b.y1 < g.box.y0 - GROUP_GAP_Y) {
      g = { id: s.id, t: s.t, at: s.at, end: s.end || s.at, strokes: [], box: b };
      out.push(g);
    }
    g.strokes.push(s);
    g.end = Math.max(g.end, s.end || s.at);
    if (g.t == null && s.t != null) g.t = s.t;
    g.box = { x0: Math.min(g.box.x0, b.x0), y0: Math.min(g.box.y0, b.y0), x1: Math.max(g.box.x1, b.x1), y1: Math.max(g.box.y1, b.y1) };
  }
  return out;
}

// ---------------------------------------------------------------- the layer on the page

export class InkLayer {
  // host holds the notepad; two canvases sit over it, one for finished strokes and one for the
  // stroke being written. now() gives the recording time, onChange(strokes) saves.
  constructor(host, { now, onChange, onPen, mode }) {
    this.host = host;
    this.now = now;
    this.onChange = onChange;
    this.onPen = onPen;
    this.mode = mode;               // () => 'ink' | 'scribble'
    this.strokes = [];
    this.undoStack = [];
    this.tool = 'pen';
    this.color = 'ink';
    this.armed = false;             // a finger or mouse draws too
    this.cur = null;
    this.base = host.querySelector('canvas.ink-base');
    this.live = host.querySelector('canvas.ink-live');
    this.css = themeColors();
    this.scale = 1;
    new ResizeObserver(() => this.fit()).observe(host);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.css = themeColors(); this.redraw(); });
    this.bind();
  }

  set(strokes) {
    this.strokes = strokes;
    this.undoStack = [];
    this.cur = null;
    this.grow();
    this.fit();
  }

  // the page keeps room below the lowest ink to go on writing
  grow() {
    const b = this.strokes.length ? bounds(this.strokes).y1 : 0;
    const w = this.host.clientWidth || 1;
    this.host.style.minHeight = Math.max(innerHeight * 0.55, b * (w / UNITS) + innerHeight * 0.5) + 'px';
  }

  fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    // iPad Safari refuses a canvas over about 16 million pixels
    const dpr = Math.min(devicePixelRatio || 1, Math.sqrt(16e6 / (w * h)));
    for (const c of [this.base, this.live]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.scale = (w / UNITS) * dpr;
    this.redraw();
  }

  redraw() {
    const ctx = this.base.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    for (const s of this.strokes) if (s.tool === 'highlight') drawStroke(ctx, s, this.css);
    for (const s of this.strokes) if (s.tool !== 'highlight') drawStroke(ctx, s, this.css);
    this.drawLive();
  }

  drawLive() {
    const ctx = this.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (!this.cur || this.cur.tool === 'erase') return;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    drawStroke(ctx, this.cur, this.css);
  }

  point(e) {
    const r = this.host.getBoundingClientRect();
    const k = UNITS / r.width;
    const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    return [Math.round((e.clientX - r.left) * k * 10) / 10, Math.round((e.clientY - r.top) * k * 10) / 10, Math.round(pr * 100) / 100];
  }

  takes(e) {
    if (e.pointerType === 'pen') return this.mode() !== 'scribble';
    return this.armed && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);
  }

  bind() {
    const h = this.host;
    h.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen') this.onPen?.();
      if (!this.takes(e) || this.cur) return;
      e.preventDefault();
      h.setPointerCapture?.(e.pointerId);
      document.activeElement?.blur?.();
      const tool = this.tool;
      this.cur = { id: newId(), tool, color: this.color, w: tool === 'highlight' ? 22 : 2.6, t: this.now(), at: Date.now(), pts: [], pointer: e.pointerId };
      this.add(e);
    });
    h.addEventListener('pointermove', (e) => {
      if (!this.cur || e.pointerId !== this.cur.pointer) return;
      e.preventDefault();
      for (const ev of e.getCoalescedEvents?.() || [e]) this.add(ev);
    });
    const end = (e) => {
      if (!this.cur || e.pointerId !== this.cur.pointer) return;
      const s = this.cur;
      this.cur = null;
      if (s.tool === 'erase') {
        if (s.erased?.length) { this.undoStack.push({ erased: s.erased }); this.changed(); }
      } else {
        delete s.pointer;
        s.end = Date.now();
        this.strokes.push(s);
        this.undoStack.push({ added: s.id });
        const ctx = this.base.getContext('2d');
        ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
        drawStroke(ctx, s, this.css);
        this.changed();
      }
      this.drawLive();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    // A Pencil touch must not scroll the page, focus the notepad or start Scribble, and a palm
    // resting on the glass mid-stroke must not scroll it either. Fingers otherwise scroll as usual.
    const block = (e) => {
      const stylus = [...e.touches].some((t) => t.touchType === 'stylus');
      if ((stylus && this.mode() !== 'scribble') || this.cur || (this.armed && e.touches.length === 1)) e.preventDefault();
    };
    h.addEventListener('touchstart', block, { passive: false });
    h.addEventListener('touchmove', block, { passive: false });
  }

  add(e) {
    const s = this.cur;
    const [x, y, pr] = this.point(e);
    if (s.tool === 'erase') {
      // the stroke eraser: whatever the Pencil touches goes, whole
      const hit = this.strokes.filter((st) => {
        for (let i = 0; i < st.pts.length; i += 3) {
          if (Math.hypot(st.pts[i] - x, st.pts[i + 1] - y) < ERASE_R + st.w / 2) return true;
        }
        return false;
      });
      if (hit.length) {
        s.erased = (s.erased || []).concat(hit.map((st) => ({ stroke: st, index: this.strokes.indexOf(st) })));
        this.strokes = this.strokes.filter((st) => !hit.includes(st));
        this.redraw();
      }
      return;
    }
    const n = s.pts.length;
    if (n && Math.hypot(s.pts[n - 3] - x, s.pts[n - 2] - y) < 0.6) return;
    s.pts.push(x, y, pr);
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.drawLive(); });
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return false;
    if (a.added) this.strokes = this.strokes.filter((s) => s.id !== a.added);
    if (a.erased) for (const { stroke, index } of [...a.erased].sort((x, y) => x.index - y.index)) this.strokes.splice(Math.min(index, this.strokes.length), 0, stroke);
    this.redraw();
    this.changed();
    return true;
  }

  changed() {
    this.grow();
    this.onChange(this.strokes);
  }
}
