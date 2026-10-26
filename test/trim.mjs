// Unit cases for trimRepeat, the seam de-duplication. Run: node trim.mjs
const src = (await import('fs')).readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('export function trimRepeat'), src.indexOf('// ----', src.indexOf('export function trimRepeat'))).replace('export ', '');
const ds = src.slice(src.indexOf('function dist'), src.indexOf('// ----', src.indexOf('function dist')));
const trimRepeat = new Function(ds + fn + '; return trimRepeat;')();
const cases = [
  ['Okay. Thanks everyone. The bank wants', 'The bank wants the updated construction budget by Friday', 'the updated construction budget by Friday'],
  ['Morris Bank quoted 6.25% on a five-year term. Next item, the Timberley refinance.', 'Next item, the timberly refinance. More than We need the appraisal', 'More than We need the appraisal'],
  ['We need the appraisal', 'Matt will update the debt schedule', 'Matt will update the debt schedule'],
  ['yes yes', 'yes yes we agree', 'yes yes we agree'],
];
for (const [a, b, want] of cases) { const got = trimRepeat(a, b); console.log(got === want ? 'PASS' : 'FAIL', JSON.stringify(got)); }
