import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../js/styleStudioLink.js', import.meta.url), 'utf8');
test('customer entry retains custom-domain or GitHub project path and carries language/theme', () => {
    for (const [base, theme, mode] of [
        ['https://c-cutzbarber.my/', 'gold:light', 'gold:light'],
        ['https://fahru76.github.io/BarberQue/', 'teal:dark', 'teal:dark'],
        ['https://c-cutzbarber.my/', 'auto', 'auto'],
    ]) {
        let click;
        const link = { addEventListener: (_, handler) => { click = handler; } };
        vm.runInNewContext(source, { URL, document: { baseURI: base, getElementById: () => link, documentElement: { lang: 'ms' } }, window: { CustomerI18n: { getLang: () => 'en' } }, localStorage: { getItem: () => theme } });
        click(); const url = new URL(link.href);
        assert.equal(url.pathname, new URL('./style-studio/', base).pathname);
        assert.equal(url.searchParams.get('lang'), 'en'); assert.equal(url.searchParams.get('theme'), mode);
    }
});
