import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../js/styleStudioLink.js', import.meta.url), 'utf8');
test('every contextual link retains the project path and carries language, theme and palette', () => {
    for (const [base, theme, mode] of [
        ['https://c-cutzbarber.my/', 'gold:light', 'gold:light'],
        ['https://fahru76.github.io/BarberQue/', 'teal:dark', 'teal:dark'],
        ['https://c-cutzbarber.my/', 'auto', 'auto'],
    ]) {
        const clicks = [], links = Array.from({length: 3}, (_, index) => ({ addEventListener: (_, handler) => { clicks[index] = handler; } }));
        vm.runInNewContext(source, { URL, document: { baseURI: base, querySelectorAll: () => links, documentElement: { lang: 'ms' } }, window: { CustomerI18n: { getLang: () => 'en' } }, localStorage: { getItem: (key) => key === 'appTheme' ? theme : 'teal' } });
        assert.equal(clicks.length, 3);
        for (const [index, click] of clicks.entries()) {
            click(); const url = new URL(links[index].href);
            assert.equal(url.pathname, new URL('./style-studio/', base).pathname);
            assert.equal(url.searchParams.get('lang'), 'en'); assert.equal(url.searchParams.get('theme'), mode);
            assert.equal(url.searchParams.get('scheme'), 'teal');
        }
    }
});
