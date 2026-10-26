// The meeting list's long press, delete with Undo, and the key checks in Settings, in headless
// Chromium with GitHub mocked. Run: serve the repo root on 127.0.0.1:8765, then node list-probe.js.
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8765/';
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const GOOD = 'github_pat_' + 'A'.repeat(82);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://api.github.com/**', (route) => {
    const auth = route.request().headers().authorization;
    const json = (status, body) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (auth !== 'Bearer ' + GOOD) return json(401, { message: 'Bad credentials' });
    if (route.request().url().endsWith('/user')) return json(200, { login: 'Powered-By-Elevate' });
    if (route.request().url().includes('/repos/Powered-By-Elevate/agentic-os')) return json(200, { full_name: 'Powered-By-Elevate/agentic-os' });
    return json(404, {});
  });

  await page.goto(URL);
  await page.waitForFunction(() => window.__notes);
  for (const t of ['Keep me', 'Delete me', 'Delete me too']) {
    await page.keyboard.press('Control+k');
    await page.fill('#title', t);
    await page.waitForTimeout(500);
  }
  const count = () => page.evaluate(() => window.__notes.state.meetings.length);
  const item = (t) => page.locator('.item', { has: page.locator('b', { hasText: new RegExp(`^${t}$`) }) });

  // a long press opens the menu and does not open the meeting
  await page.click('.item >> text=Keep me');
  const b = await item('Delete me').boundingBox();
  await page.mouse.move(b.x + 40, b.y + 15);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  check('a long press opens the menu', await page.isVisible('#itemMenu'));
  check('the menu names the meeting', (await page.textContent('#menuTitle')) === 'Delete me');
  check('the long press does not open that meeting', (await page.inputValue('#title')) === 'Keep me');
  await page.screenshot({ path: (process.env.OUT || '.') + '/list-menu.png' });

  // a short tap still opens it, and a tap elsewhere closes the menu
  await page.mouse.click(600, 600);
  check('a tap elsewhere closes the menu', !(await page.isVisible('#itemMenu')));
  await item('Delete me').click();
  check('a short tap opens the meeting', (await page.inputValue('#title')) === 'Delete me');
  await item('Keep me').click();

  // delete, then Undo
  await item('Delete me').click({ button: 'right' });
  check('a right-click opens the menu too', await page.isVisible('#itemMenu'));
  const n = await count();
  await page.click('#menuDelete');
  check('delete takes the meeting off the list at once', (await count()) === n - 1 && !(await page.isVisible('.item >> text="Delete me"')));
  check('an Undo shows', await page.isVisible('.toast button'));
  await page.click('.toast button');
  check('Undo brings it back', (await count()) === n && (await item('Delete me').isVisible()));
  await page.waitForTimeout(5400);
  check('an undone delete never happens', (await page.evaluate(async () => (await new Promise((r) => { const q = indexedDB.open('meeting-notes'); q.onsuccess = () => { const g = q.result.transaction('meetings').objectStore('meetings').getAll(); g.onsuccess = () => r(g.result); }; })).length)) === n);

  // delete the open meeting for good
  await item('Delete me too').click();
  await item('Delete me too').click({ button: 'right' });
  await page.click('#menuDelete');
  check('deleting the open meeting shows the empty page', await page.isVisible('#empty'));
  await page.waitForTimeout(5400);
  const stored = await page.evaluate(async () => (await new Promise((r) => { const q = indexedDB.open('meeting-notes'); q.onsuccess = () => { const g = q.result.transaction('meetings').objectStore('meetings').getAll(); g.onsuccess = () => r(g.result.map((m) => m.title)); }; })));
  check('after five seconds it is gone from the iPad', !stored.includes('Delete me too') && stored.includes('Keep me'), stored.join(', '));

  // a real finger: a long press by touch
  await item('Keep me').click();
  const kb = await item('Delete me').boundingBox();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: kb.x + 40, y: kb.y + 15 }] });
  await page.waitForTimeout(650);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  check('a finger long press opens the menu', await page.isVisible('#itemMenu'));
  check('and leaves the open meeting alone', (await page.inputValue('#title')) === 'Keep me');
  await page.mouse.click(600, 600);

  // Settings: the key's length shows, a short one is flagged, Check GitHub says what is wrong
  await page.click('#settingsBtn');
  await page.fill('[name=githubToken]', GOOD.slice(0, 60));
  const info = await page.textContent('.keyinfo[data-key=githubToken]');
  check('a token cut short is flagged by its length', /60 characters[\s\S]*93/.test(info), info);
  await page.click('#ghCheck');
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#ghCheckOut').textContent));
  check('Check GitHub says a bad token is not recognised', /does not recognise/.test(await page.textContent('#ghCheckOut')));
  await page.fill('[name=githubToken]', ' ' + GOOD.slice(0, 40) + '\n' + GOOD.slice(40) + ' ');
  await page.click('#ghCheck');
  await page.waitForFunction(() => /Works|not/.test(document.querySelector('#ghCheckOut').textContent));
  check('a good token checks out, spaces and line breaks ignored', /Works\. Signed in as Powered-By-Elevate/.test(await page.textContent('#ghCheckOut')), await page.textContent('#ghCheckOut'));
  check('the key field is not a password field (no Keychain autofill)', (await page.getAttribute('[name=githubToken]', 'type')) === 'text' && (await page.getAttribute('[name=githubToken]', 'autocapitalize')) === 'off');
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.querySelector('#settings').open);
  await page.waitForTimeout(100);
  check('the saved token has no spaces in it', (await page.evaluate(() => window.__notes.settings().githubToken)) === GOOD);
  await page.screenshot({ path: (process.env.OUT || '.') + '/list-after.png' });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails} of ${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
