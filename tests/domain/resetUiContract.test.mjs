import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const ok = (name, condition) => {
    if (!condition) throw new Error(`FAIL ${name}`);
    console.log(`  pass  ${name}`);
};

console.log('\nGlobal reset UI contract');
ok('navigation reset button uses global reset handler', /id="appResetBtn"[^>]*onclick="resetSystem\(\)"/.test(html));
ok('navigation reset still routes to global scope', /async function resetSystem\(\) \{ openOperationalResetDialog\('global'\); \}/.test(html));
ok('typed RESET remains required', /input\.value !== 'RESET'/.test(html) && /input\.oninput = \(\) => \{ button\.disabled = input\.value !== 'RESET'; \}/.test(html));
ok('admin panel has no duplicate global reset button', !/id="adminGlobalResetBtn"/.test(html));
ok('section reset controls remain available', ['shop','announcement','closedDates','services','hours','seats'].every(scope => html.includes(`openOperationalResetDialog('${scope}')`)));
console.log('\n5 passed');
