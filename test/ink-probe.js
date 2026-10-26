// The Apple Pencil, in headless Chromium. Chrome's DevTools protocol can send pointer events as a
// pen with pressure, which is what Safari reports for the Pencil. Claude and GitHub are mocked.
// Run: serve the repo root on 127.0.0.1:8765, then OUT=<a scratch folder holding meeting2.wav>
// node ink-probe.js. Screenshots land in OUT.
const { chromium } = require('playwright');
const path = require('path');

const OUT = process.env.OUT || __dirname;
const URL = 'http://127.0.0.1:8765/';
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

// handwriting-ish: a run of joined loops, like cursive e's, with the pressure rising and falling
function word(x, y, letters, size = 13) {
  const pts = [];
  for (let i = 0; i <= letters * 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    pts.push([x + i * size / 14 * 0.9 + Math.cos(a) * size * 0.35, y - Math.sin(a) * size * 0.55 - size * 0.4, Math.min(1, Math.max(0.1, 0.5 + 0.35 * Math.sin(i / 9)))]);
  }
  return pts;
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(OUT, 'meeting2.wav')}`, '--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });

  let claudeBody = null;
  await page.route('https://api.anthropic.com/**', async (route) => {
    claudeBody = JSON.parse(route.request().postData());
    const body = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Draw review\\n\\n## Notes\\n- [[check the draw]]"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body });
  });
  const gh = [];
  await page.route('https://api.github.com/**', async (route) => {
    const r = route.request();
    gh.push({ method: r.method(), url: r.url(), body: r.postData() });
    const json = (status, body) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (r.method() === 'GET' && r.url().includes('/git/ref/heads/')) return json(200, { object: { sha: 'abc' } });
    if (r.method() === 'GET') return json(404, {});
    if (r.method() === 'PUT') return json(201, { content: { sha: 'f00d' } });
    return json(200, {});
  });

  const pen = async (pts, type = 'pen') => {
    const send = (t, [x, y, p]) => cdp.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', buttons: t === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: type, force: p });
    await send('mousePressed', pts[0]);
    for (const p of pts.slice(1)) await send('mouseMoved', p);
    await send('mouseReleased', pts[pts.length - 1]);
  };
  const strokes = () => page.evaluate(() => window.__notes.state.cur.ink.length);

  await page.goto(URL);
  await page.waitForFunction(() => window.__notes);
  await page.keyboard.press('Control+k');
  await page.fill('#title', 'Draw review');
  await page.fill('#people', 'Walt');
  check('the Pencil tools show on My notes', await page.isVisible('#tools'));

  const box = await page.$eval('#write', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });

  // a mouse with no tool picked selects text, it does not draw
  await page.mouse.move(box.x + 40, box.y + 200);
  await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 220); await page.mouse.up();
  check('a finger or mouse does not draw until a tool is picked', (await strokes()) === 0);

  // the Pencil writes straight away, no tool to pick
  await page.click('#recBtn');
  await page.waitForFunction(() => window.__notes.rec.meeting);
  await page.waitForTimeout(2200);
  await pen(word(box.x + 30, box.y + 60, 6));
  await pen(word(box.x + 140, box.y + 60, 4));
  const s1 = await page.evaluate(() => window.__notes.state.cur.ink.map((s) => ({ t: s.t, n: s.pts.length / 3, w: s.w, x: s.pts[0], p: s.pts[2] })));
  check('the Pencil writes without picking a tool', s1.length === 2, JSON.stringify(s1));
  check('each stroke carries its recording time', s1.every((s) => s.t > 1500), s1.map((s) => s.t).join(','));
  check('strokes are stored in page units with pressure', s1[0].x > 0 && s1[0].x < 1000 && s1[0].p > 0 && s1[0].p < 1);
  check('the app remembers a Pencil was used', await page.evaluate(() => localStorage.getItem('penSeen') === '1'));
  const notFocused = await page.evaluate(() => document.activeElement?.id !== 'pad');
  check('writing does not pop the keyboard (the notepad is not focused)', notFocused);

  // a pause, then another note lower down
  await page.waitForTimeout(3200);
  await pen(word(box.x + 30, box.y + 150, 8));
  await pen(word(box.x + 30, box.y + 210, 5));
  const gs = await page.evaluate(() => window.__notes.groups(window.__notes.state.cur.ink).map((g) => [g.strokes.length, g.t]));
  check('strokes written together become one handwritten note', gs.length === 3 && gs[0][0] === 2, JSON.stringify(gs));

  // highlighter marks the page but is not a note
  await page.click('.tool[data-tool="highlight"]');
  await pen([[box.x + 20, box.y + 145, 0.5], [box.x + 260, box.y + 145, 0.5]]);
  const hl = await page.evaluate(() => window.__notes.state.cur.ink.filter((s) => s.tool === 'highlight').length);
  check('the highlighter draws and is left out of the notes', hl === 1 && (await page.evaluate(() => window.__notes.groups(window.__notes.state.cur.ink).length)) === 3);

  // the eraser takes whole strokes, and undo brings them back
  await page.click('.tool[data-tool="erase"]');
  const before = await strokes();
  await pen([[box.x + 30, box.y + 205, 0.5], [box.x + 120, box.y + 205, 0.5]]);
  const afterErase = await strokes();
  if (process.env.DEBUG) console.log('erase', await page.evaluate(() => window.__notes.state.cur.ink.map((s) => s.tool + ':' + s.id)));
  await page.click('#inkUndo');
  check('the eraser removes what it touches', afterErase < before, `${before} -> ${afterErase}`);
  check('undo brings it back', (await strokes()) === before);
  await page.click('.tool[data-tool="pen"]');

  // finger drawing, for when there is no Pencil: the app forgets the Pencil, a tool arms the mouse
  await page.evaluate(() => localStorage.removeItem('penSeen'));
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#meeting:not([hidden])');
  if (process.env.DEBUG) console.log('after reload', before, await page.evaluate(() => window.__notes.state.cur.ink.map((s) => s.tool + ':' + s.id)));
  await page.click('.tool[data-tool="pen"]');
  check('without a Pencil, tapping a tool lets a finger draw', await page.$eval('#tools', (e) => e.classList.contains('armed')));
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down(); await page.mouse.move(box.x + 360, box.y + 330, { steps: 6 }); await page.mouse.up();
  const n2 = await strokes();
  await page.click('#inkUndo');
  await page.click('.tool[data-tool="pen"]');
  check('tapping the tool again goes back to typing', n2 === before + 1 && !(await page.$eval('#tools', (e) => e.classList.contains('armed'))));

  // the ink survives a reload and is drawn
  const inked = await page.evaluate(() => { const c = document.querySelector('#inkBase'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  check('the ink survives a reload and is redrawn', (await strokes()) === before && inked > 500, inked + ' inked pixels');

  // the transcript shows each handwritten note at its time
  await page.click('.tab[data-tab="timeline"]');
  const imgs = await page.$$eval('#pane-timeline .ink img', (i) => i.length);
  check('handwritten notes show in the transcript at their time', imgs === 3, imgs + ' pictures');
  await page.screenshot({ path: path.join(OUT, 'ink-1-light.png') });

  // Enhance sends the handwriting to Claude as pictures with their times
  await page.evaluate(() => window.__notes.saveSettings({ anthropicKey: 'sk-ant-test', githubToken: 'github_pat_test' }));
  await page.click('#recBtn');
  await page.waitForFunction(() => !window.__notes.rec.meeting);
  await page.keyboard.press('Control+e');
  await page.waitForFunction(() => window.__notes.state.cur.enhanced);
  const content = claudeBody.messages[0].content;
  const pics = Array.isArray(content) ? content.filter((c) => c.type === 'image') : [];
  check('Enhance sends one picture per handwritten note', pics.length === 3 && pics.every((p) => p.source.media_type === 'image/png' && p.source.data.length > 500), pics.length + ' pictures');
  check('each picture is labelled with when it was written', Array.isArray(content) && content.filter((c) => c.type === 'text' && /^Written at \[0:0\d\]/.test(c.text)).length === 3);
  check('Claude is told to read the handwriting as my notes', Array.isArray(content) && /MY HANDWRITING[\s\S]*double brackets/.test(content.map((c) => c.text || '').join('\n')));

  // sync puts a picture of the page beside the meeting's file
  await page.waitForFunction(() => window.__notes.state.cur.synced?.inkPath, null, { timeout: 15000 });
  const putPng = gh.find((r) => r.method === 'PUT' && /\.ink\.png$/.test(r.url));
  const putJson = gh.find((r) => r.method === 'PUT' && /\.json$/.test(r.url));
  const doc = putJson && JSON.parse(Buffer.from(JSON.parse(putJson.body).content, 'base64').toString());
  check('sync writes the page as a picture', !!putPng && Buffer.from(JSON.parse(putPng.body).content, 'base64').slice(1, 4).toString() === 'PNG', putPng?.url);
  check('the synced meeting names its picture and keeps the strokes', doc?.inkImage?.endsWith('.ink.png') && doc.ink.length === before);

  // Scribble: with the setting on, the Pencil is left to Apple's handwriting-to-text
  await page.evaluate(() => window.__notes.saveSettings({ pencil: 'scribble' }));
  await page.click('.view[data-view="pad"]');
  await pen(word(box.x + 30, box.y + 330, 3));
  check('with Scribble chosen, the Pencil draws no ink', (await strokes()) === before);
  await page.evaluate(() => window.__notes.saveSettings({ pencil: 'ink' }));

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'ink-2-dark.png') });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(400);
  const turned = await page.evaluate(() => window.__notes.state.cur.ink[0].pts[0]);
  check('the ink keeps its page units when the iPad turns', turned === s1[0].x);
  await page.screenshot({ path: path.join(OUT, 'ink-3-portrait.png') });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails} of ${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
