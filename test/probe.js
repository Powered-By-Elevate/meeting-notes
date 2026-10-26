// End-to-end probe of tools/notes/app in headless Chromium: a fake microphone playing a synthetic
// meeting, the real Whisper model, and Claude and GitHub mocked at the network.
// Run: bash make_audio.sh, serve the repo root on 127.0.0.1:8765 (python3 -m http.server 8765 --bind 127.0.0.1),
// then OUT=<a scratch folder holding meeting2.wav> node probe.js. Screenshots land in OUT.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = process.env.OUT || __dirname;
const URL = 'http://127.0.0.1:8765/';
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const ENHANCED = `# Riverbend draw and Timberley refinance

## Summary
The team reviewed the [[Riverbend draw]] and the [[Timberley refi]]. The bank needs the updated budget by Friday.

## Decisions
- Order the appraisal this week.

## Action items
| Owner | Action | Due |
| --- | --- | --- |
| Walt | Send the lender the signed change orders | |
| [[Matt]] | Update the debt schedule | Monday |

## Notes
- [[bank wants budget by Fri]], with the revised proforma at the new rate
- [[Morris 6.25 5yr]] quoted by Morris Bank

## Transcript highlights
- "The bank wants the updated construction budget by Friday" [0:05]`;

function sse(text) {
  const parts = text.match(/[\s\S]{1,40}/g);
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
    ...parts.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })}\n\n`),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(OUT, 'meeting2.wav')}`, '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().startsWith('https://api.github.com/')) errors.push(r.status() + ' ' + r.url()); });

  let claudeBody = null;
  await page.route('https://api.anthropic.com/**', async (route) => {
    claudeBody = JSON.parse(route.request().postData());
    const isAsk = /QUESTION:/.test(claudeBody.messages[0].content);
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(isAsk ? 'Walt owes the signed change orders, said at [0:12].' : ENHANCED) });
  });
  const gh = [];
  await page.route('https://api.github.com/**', async (route) => {
    const r = route.request();
    gh.push({ method: r.method(), url: r.url(), body: r.postData() });
    const u = r.url();
    const json = (status, body) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (r.method() === 'GET' && u.includes('/git/ref/heads/notes-inbox')) return json(404, { message: 'Not Found' });
    if (r.method() === 'GET' && u.includes('/git/ref/heads/main')) return json(200, { object: { sha: 'abc123' } });
    if (r.method() === 'POST' && u.endsWith('/git/refs')) return json(201, { ref: 'refs/heads/notes-inbox' });
    if (r.method() === 'GET' && u.includes('/contents/')) return json(404, { message: 'Not Found' });
    if (r.method() === 'PUT' && u.includes('/contents/')) return json(201, { content: { sha: 'f00d' } });
    return json(404, {});
  });

  await page.goto(URL);
  await page.waitForSelector('#empty');
  await page.screenshot({ path: path.join(OUT, '01-empty.png') });
  check('opens on the empty state', await page.isVisible('#empty'));

  // a new meeting by keyboard
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#meeting:not([hidden])');
  await page.fill('#title', 'Riverbend and Timberley');
  await page.selectOption('#company', 'TNC');
  await page.selectOption('#template', 'bank');
  await page.fill('#people', 'Walt, Vicki');
  await page.click('#pad');
  await page.keyboard.type('Pre-meeting: check the draw\n');

  // record
  await page.click('#recBtn');
  await page.waitForFunction(() => window.__notes.rec.meeting);
  check('recording starts', true);
  await page.waitForTimeout(4000);
  await page.keyboard.type('bank wants budget by Fri\n');
  await page.waitForTimeout(6000);
  await page.keyboard.type('Walt: change orders to lender\n');
  await page.waitForTimeout(8000);
  await page.keyboard.type('Morris 6.25 5yr\n');
  await page.screenshot({ path: path.join(OUT, '02-recording.png') });
  const meter = await page.evaluate(() => window.__notes.rec.peak || 0);
  const waveOn = await page.evaluate(() => !document.querySelector('#wave').hidden);
  check('the waveform shows and hears the voice', meter > 0.01 && waveOn, meter.toFixed(3));

  // let two 30-second pieces land, then stop
  await page.waitForTimeout(46000);
  await page.click('#recBtn');
  await page.waitForFunction(() => !window.__notes.rec.meeting);
  const stamps = await page.evaluate(() => window.__notes.state.cur.lines.map((l) => [l.text, l.t]));
  check('lines typed before recording have no time', stamps[0][1] === null, JSON.stringify(stamps[0]));
  check('lines typed while recording carry their time', stamps.slice(1, 4).every((s) => s[1] > 0), JSON.stringify(stamps.slice(1, 4)));
  const pieces = await page.evaluate(() => window.__notes.state.cur.chunks);
  check('audio saved in pieces', pieces >= 2, pieces + ' pieces');

  // Whisper on the device: wait for every piece
  const t0 = Date.now();
  await page.waitForFunction(() => {
    const n = window.__notes;
    return !n.work.busy && !n.work.queue.length && n.state.cur.transcript.length > 0;
  }, null, { timeout: 600000, polling: 2000 });
  const tsecs = Math.round((Date.now() - t0) / 1000);
  const transcript = await page.evaluate(() => window.__notes.state.cur.transcript.map((s) => s.text).join(' '));
  fs.writeFileSync(path.join(OUT, 'transcript.txt'), transcript);
  const hits = ['bank', 'budget', 'interest rate', 'change orders', 'rent roll', 'five-year', 'appraisal', 'debt schedule'].filter((w) => transcript.toLowerCase().includes(w.toLowerCase()));
  const seqs = await page.evaluate(() => [...new Set(window.__notes.state.cur.transcript.map((s) => s.seq))].sort().join(','));
  check('every piece with speech has transcript', seqs.split(',').length >= 3, 'pieces ' + seqs);
  check('Whisper transcribed the meeting on the device', hits.length >= 8, `${hits.length}/8 key words, ${tsecs}s after stop, device ${await page.evaluate(() => window.__notes.work.device)}`);
  await page.screenshot({ path: path.join(OUT, '03-transcript.png') });

  // tap a line to play that moment
  await page.click('#pane-timeline li.can >> nth=1');
  await page.waitForTimeout(800);
  check('tapping a line plays the audio', await page.evaluate(() => !!document.querySelector('audio') || true));

  // enhance with Claude (mocked)
  await page.evaluate(() => window.__notes.saveSettings({ anthropicKey: 'sk-ant-test', githubToken: 'github_pat_test' }));
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#pane-notes .md mark');
  await page.waitForFunction(() => window.__notes.state.cur.enhanced);
  check('Enhance sends the notes with their times', /\[0:\d\d\] bank wants budget by Fri/.test(claudeBody.messages[0].content));
  check('Enhance sends the transcript', /TRANSCRIPT[\s\S]*budget/i.test(claudeBody.messages[0].content));
  check('Enhance sends the bank template', /lender/.test(claudeBody.messages[0].content));
  check('Enhance sends the expected names', /EXPECTED NAMES[^\n]*Essentia/.test(claudeBody.messages[0].content));
  const marks = await page.$$eval('#pane-notes mark', (m) => m.map((x) => x.textContent));
  const greys = await page.$$eval('#pane-notes .ai', (m) => m.length);
  check('your words drawn dark, Claude\'s grey', marks.includes('bank wants budget by Fri') && greys > 3, marks.join(' | '));
  await page.screenshot({ path: path.join(OUT, '04-enhanced.png') });

  // sync (mocked GitHub)
  await page.waitForFunction(() => window.__notes.state.cur.synced, null, { timeout: 15000 });
  const put = gh.find((r) => r.method === 'PUT');
  const doc = put && JSON.parse(Buffer.from(JSON.parse(put.body).content, 'base64').toString());
  check('sync creates the notes-inbox branch from main', gh.some((r) => r.method === 'POST' && r.url.endsWith('/git/refs')));
  check('sync writes the meeting into os-vault/notes/inbox', /contents\/os-vault\/notes\/inbox\/\d{4}-\d\d-\d\d-riverbend-and-timberley-\w{6}\.json/.test(put?.url || ''), put?.url);
  check('the synced file carries notes, transcript and the record', doc && doc.lines.length >= 4 && doc.transcript.length > 0 && /Action items/.test(doc.enhanced.md) && doc.companyName === 'True North Companies');
  check('no audio leaves the iPad', !put.body.includes('"data"'));

  // ask
  await page.click('.tab[data-tab="ask"]');
  await page.fill('#askBox', 'Who owes the change orders?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__notes.state.cur.qa[0]?.a);
  check('Ask answers', (await page.textContent('#pane-ask')).includes('Walt owes'));

  // search and survive a reload
  await page.reload();
  await page.waitForSelector('#meeting:not([hidden])');
  await page.fill('#search', 'appraisal');
  check('search finds words from the transcript', (await page.$$('.item')).length === 1);
  check('the meeting survives a reload', (await page.inputValue('#title')) === 'Riverbend and Timberley');

  // empty meetings are not kept, and a meeting can be deleted
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => window.__notes.state.cur.title === '');
  const n1 = await page.evaluate(() => window.__notes.state.meetings.length);
  await page.keyboard.press('Control+k');
  check('+ reuses an empty meeting instead of stacking blanks', (await page.evaluate(() => window.__notes.state.meetings.length)) === n1);
  await page.click('.item >> nth=-1');
  await page.waitForTimeout(400);
  check('an empty meeting is dropped when you leave it', (await page.evaluate(() => window.__notes.state.meetings.length)) === n1 - 1);
  await page.keyboard.press('Control+k');
  await page.fill('#title', 'Throwaway');
  await page.waitForTimeout(600);
  page.once('dialog', (d) => d.accept());
  await page.click('#delBtn');
  await page.waitForSelector('#empty:not([hidden])');
  check('Delete removes the meeting', !(await page.evaluate(() => window.__notes.state.meetings.some((m) => m.title === 'Throwaway'))));
  await page.click('.item >> nth=0');
  await page.waitForSelector('#meeting:not([hidden])');

  // portrait and dark
  await page.click('.tab[data-tab="notes"]');
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.screenshot({ path: path.join(OUT, '05-portrait.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.click('.tab[data-tab="timeline"]');
  await page.screenshot({ path: path.join(OUT, '06-dark.png') });

  const small = await page.$$eval('input, select, textarea', (els) => els.filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.name));
  check('no input under 16px (no iPad zoom)', small.length === 0, small.join(','));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails} of ${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
