// The 2026-11-16 failure and its repair, in headless Chromium with the real Whisper model.
//  A. The iPad lie: the context says 16 kHz while the microphone arrives at 48 kHz. The clock check
//     must catch it, so the pieces, the transcript and its clock come out at the true speed.
//  B. Re-transcribe: a meeting whose pieces were saved at 3x (48 kHz labelled 16 kHz) is repaired,
//     heard again, and its audio downloads as one true-speed WAV. Enhance refuses a broken
//     transcript and never saves an empty write-up.
// Run: bash make_audio.sh, serve the repo root on 127.0.0.1:8765, then OUT=<folder with meeting2.wav> node rate-probe.js
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUT = process.env.OUT || __dirname;
const URL = 'http://127.0.0.1:8765/';
const WORDS = ['bank', 'budget', 'interest rate', 'change orders', 'rent roll', 'five-year', 'appraisal', 'debt schedule'];
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const hits = (t) => WORDS.filter((w) => t.toLowerCase().includes(w));

const wav = path.join(OUT, 'meeting2.wav');
const raw48 = path.join(OUT, 'm48.raw');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ar', '48000', '-ac', '1', '-f', 's16le', raw48]);
const realMs = Math.round((fs.statSync(raw48).size / 2 / 48000) * 1000);

async function newPage(browser, { lie }) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['microphone'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
  if (lie) {
    // the iPad: every context claims 16 kHz, and the worklet believes it, while the samples come at the real rate
    await page.addInitScript(() => {
      const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'sampleRate').get;
      window.__realRate = () => real.call(window.__lastCtx);
      const AC = window.AudioContext;
      window.AudioContext = class extends AC { constructor(o) { super(o); window.__lastCtx = this; } };
      Object.defineProperty(BaseAudioContext.prototype, 'sampleRate', { get() { return 16000; } });
    });
    // the worklet believes it too (a worklet module load is not seen by page.route, so it is wrapped here)
    await page.addInitScript(() => {
      const add = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = async function (url, o) {
        const src = await (await fetch(url)).text();
        const blob = URL.createObjectURL(new Blob(['const sampleRate = 16000;\n' + src], { type: 'text/javascript' }));
        return add.call(this, blob, o);
      };
    });
  }
  await page.route('**/__m48.raw', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(raw48) }));
  return { page, errors };
}

const idle = (page) => page.waitForFunction(() => {
  const n = window.__notes;
  return !n.work.busy && !n.work.queue.length && !n.state.cur.fix && n.state.cur.transcript.length > 0;
}, null, { timeout: 600000, polling: 2000 });

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
  });

  // ------------------------------------------------------------ A. the iPad lie
  if (!process.env.ONLY_B) {
    const { page, errors } = await newPage(browser, { lie: true });
    await page.goto(URL);
    await page.waitForSelector('#empty');
    await page.keyboard.press('Control+k');
    await page.fill('#title', 'Lying microphone');
    await page.click('#recBtn');
    await page.waitForFunction(() => window.__notes.rec.meeting);
    const told = await page.evaluate(() => window.__notes.rec.ctx.sampleRate);
    const real = await page.evaluate(() => window.__realRate());
    check('the context says 16 kHz while it runs faster (the iPad lie)', told === 16000 && real > 16000, `says ${told}, runs ${real}`);
    const t0 = Date.now();
    await page.waitForTimeout(8000);
    const warned = await page.textContent('#status');
    await page.waitForTimeout(32000);
    await page.click('#recBtn');
    await page.waitForFunction(() => !window.__notes.rec.meeting);
    const wall = Date.now() - t0;
    const fixed = await page.evaluate(() => window.__notes.rec.clock.fixed);
    check('the clock check found the true rate', Math.abs(fixed - real) < real * 0.03, `${fixed} Hz`);
    check('it says so in the status line', /was sending 44\.1 kHz while saying 16\.0 kHz/.test(warned) || /was sending 48\.0 kHz/.test(warned), warned.slice(0, 120));
    const meta = await page.evaluate(() => window.__notes.pieceMeta(window.__notes.state.cur.id));
    const savedMs = meta.reduce((a, p) => a + p.ms, 0);
    check('the saved audio is as long as the recording, not three times', Math.abs(savedMs - wall) < wall * 0.06, `${savedMs} ms saved over ${wall} ms`);
    check('each piece holds 16,000 samples a second', meta.every((p) => Math.abs(p.n / 16 - p.ms) <= 2 && p.rate === 16000), meta.map((p) => p.n).join(','));
    await idle(page);
    const tr = await page.evaluate(() => window.__notes.state.cur.transcript);
    const text = tr.map((s) => s.text).join(' ');
    fs.writeFileSync(path.join(OUT, 'transcript-lie.txt'), text);
    check('Whisper hears the meeting at the true speed', hits(text).length >= 7, `${hits(text).length}/8: ${text.slice(0, 100)}`);
    const maxT = Math.max(...tr.map((s) => s.t1));
    check('the transcript clock runs at the true speed', maxT <= wall + 2000, `last word at ${maxT} ms of ${wall} ms`);
    check('no page errors (lie)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.context().close();
  }

  // ------------------------------------------------------------ B. Re-transcribe a meeting saved at 3x
  {
    const { page, errors } = await newPage(browser, { lie: false });
    let claudeReply = '';
    let claudeCalls = 0;
    await page.route('https://api.anthropic.com/**', async (route) => {
      claudeCalls++;
      const body = claudeReply ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: claudeReply } })}\n\n` : '';
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
        body: 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n' + body + 'event: message_stop\ndata: {"type":"message_stop"}\n\n' });
    });
    await page.goto(URL);
    await page.waitForSelector('#empty');
    // the broken meeting as the old app saved it: 48 kHz audio cut into "22 second" pieces of 352,000 samples
    const made = await page.evaluate(async (realMs) => {
      const buf = await (await fetch('/__m48.raw')).arrayBuffer();
      const all = new Int16Array(buf);
      const n = window.__notes;
      const id = 'legacy' + Date.now().toString(36);
      const per = 22 * 16000;
      let seq = 0, start = 0;
      const junk = [];
      for (let o = 0; o < all.length; o += per) {
        const data = all.slice(o, o + per);
        const ms = Math.round(data.length / 16);
        const final = o + per >= all.length;
        await n.put('audio', { key: id + ':' + seq, meeting: id, seq, startMs: start, ms, data, transcribed: true, final });
        junk.push({ t0: start, t1: start + ms, seq, text: 'I see, '.repeat(40) });
        start += ms; seq++;
      }
      const now = Date.now();
      await n.put('meetings', { id, title: 'Sync meeting saved at 3x', company: '', people: 'Joseph and Matt', template: 'one', created: now, updated: now,
        lines: [{ text: 'quote from the bank', t: 5000 }], ink: [], durationMs: realMs, chunks: seq, transcript: junk, captions: [],
        enhanced: { md: '', model: 'claude-sonnet-5-5', at: now }, qa: [], synced: null });
      return { id, pieces: seq, labelled: start };
    }, realMs);
    check('a meeting saved at 3x is set up', made.labelled > realMs * 2.9, `${made.pieces} pieces labelled ${made.labelled} ms for ${realMs} ms of sound`);
    await page.reload();
    await page.waitForSelector('#meeting:not([hidden])');
    const afterBoot = await page.evaluate(() => window.__notes.state.cur);
    check('opening the app does not stretch its length to the 3x labels', afterBoot.durationMs === realMs, `${afterBoot.durationMs}`);
    check('an empty write-up from before is cleared', afterBoot.enhanced === null);

    // Enhance refuses a transcript that cannot be real speech
    await page.evaluate(() => { const m = window.__notes.state.cur; m.transcript = [{ t0: 0, t1: 1, seq: 0, text: 'here, '.repeat(40000) }]; window.__notes.saveSettings({ anthropicKey: 'sk-ant-test' }); });
    await page.keyboard.press('Control+e');
    await page.waitForTimeout(500);
    check('Enhance refuses a 240k-character transcript and sends nothing', claudeCalls === 0 && /too long/.test(await page.textContent('#status')), (await page.textContent('#status')).slice(0, 100));

    // Re-transcribe: the prompt offers the true length, found from the recorded length
    let promptText = '', promptDefault = '';
    page.once('dialog', async (d) => { promptText = d.message(); promptDefault = d.defaultValue(); await d.accept(d.defaultValue()); });
    await page.click('.tab[data-tab="timeline"]');
    await page.click('#retxBtn');
    await page.waitForFunction(() => !window.__notes.state.cur.transcript.some((x) => x.text.startsWith('here,')), null, { timeout: 30000 });
    await idle(page);
    const wantMin = (realMs / 60000).toFixed(1);
    check('Re-transcribe finds the true length from the recorded length', promptDefault === wantMin && /48\.0 kHz/.test(promptText), `${promptDefault} min offered, ${promptText.split('\n')[0].slice(0, 140)}`);
    const m = await page.evaluate(() => window.__notes.state.cur);
    const meta = await page.evaluate(() => window.__notes.pieceMeta(window.__notes.state.cur.id));
    const savedMs = meta.reduce((a, p) => a + p.ms, 0);
    check('the pieces are resampled to their true length', Math.abs(savedMs - realMs) < 50 && Math.abs(m.durationMs - realMs) < 50, `${savedMs} ms in ${meta.length} pieces, meeting ${m.durationMs} ms`);
    check('three old pieces became one, renumbered from 0', meta.length === Math.ceil(made.pieces / 3) && meta.every((p, i) => p.seq === i && p.rate === 16000) && m.chunks === meta.length, meta.map((p) => `${p.seq}:${p.ms}`).join(','));
    check('the pieces follow on without gaps', meta.every((p, i) => i === 0 ? p.startMs === 0 : p.startMs === meta[i - 1].startMs + meta[i - 1].ms));
    const text = m.transcript.map((s) => s.text).join(' ');
    fs.writeFileSync(path.join(OUT, 'transcript-retranscribed.txt'), text);
    check('the old looping transcript is gone', !/I see, I see/.test(text));
    check('Whisper hears the repaired audio', hits(text).length >= 7, `${hits(text).length}/8: ${text.slice(0, 100)}`);
    const maxT = Math.max(...m.transcript.map((s) => s.t1));
    check('the transcript clock is the true one', maxT <= realMs + 1500, `last word at ${maxT} ms of ${realMs} ms`);

    // Download audio: one WAV at 16 kHz, the true length
    await page.click('#dlBtn');
    await page.waitForSelector('.toast button', { timeout: 20000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.toast button')]);
    const file = path.join(OUT, 'download.wav');
    await dl.saveAs(file);
    const b = fs.readFileSync(file);
    const rate = b.readUInt32LE(24), samples = b.readUInt32LE(40) / 2;
    check('Download audio saves one true-speed 16 kHz WAV', b.toString('ascii', 0, 4) === 'RIFF' && rate === 16000 && Math.abs(samples / 16 - realMs) < 50 && b.length === 44 + samples * 2, `${dl.suggestedFilename()}, ${rate} Hz, ${Math.round(samples / 16)} ms`);

    // Enhance fails out loud on an empty answer, and saves a real one
    claudeReply = '';
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => /empty write-up/.test(document.querySelector('#status').textContent), null, { timeout: 15000 });
    check('an empty answer from Claude is an error, and nothing is saved', (await page.evaluate(() => window.__notes.state.cur.enhanced)) === null);
    claudeReply = '# Sync\n\n## Summary\nThe bank wants the budget.';
    await page.click('#enhanceBtn');
    await page.waitForFunction(() => window.__notes.state.cur.enhanced);
    check('a real answer is saved', /bank wants/.test(await page.evaluate(() => window.__notes.state.cur.enhanced.md)));

    // the fallback: the length was already stretched by the old app, so the voices decide
    const second = await page.evaluate(async () => {
      const n = window.__notes;
      const src = n.state.cur;
      const buf = await (await fetch('/__m48.raw')).arrayBuffer();
      const all = new Int16Array(buf);
      const id = 'stretched' + Date.now().toString(36);
      const per = 22 * 16000;
      let seq = 0, start = 0;
      for (let o = 0; o < all.length; o += per) {
        const data = all.slice(o, o + per);
        const ms = Math.round(data.length / 16);
        await n.put('audio', { key: id + ':' + seq, meeting: id, seq, startMs: start, ms, data, transcribed: true, final: o + per >= all.length });
        start += ms; seq++;
      }
      const m = { ...src, id, title: 'Stretched', durationMs: start, wallMs: 0, chunks: seq, transcript: [], enhanced: null, synced: null };
      await n.put('meetings', m);
      n.state.meetings.push(m);
      n.open(m);
      return start;
    });
    let fbDefault = '';
    page.once('dialog', async (d) => { fbDefault = d.defaultValue(); await d.dismiss(); });
    await page.click('#retxBtn');
    await page.waitForTimeout(3000);
    check('with the length already stretched, the voices still give the true length', Math.abs(parseFloat(fbDefault) - second / 3 / 60000) < 0.06, `${fbDefault} min offered for ${(second / 60000).toFixed(2)} labelled`);
    check('no page errors (re-transcribe)', errors.length === 0, errors.slice(0, 3).join(' | '));
  }

  await browser.close();
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails} of ${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
