import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const match = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n        \\}`));
    assert.ok(match, `Missing customer helper ${name}`);
    return match[0];
}

test('customer name validation matches the 60-character backend boundary', () => {
    const context = vm.createContext({});
    vm.runInContext(source('getCustomerNameError'), context);
    const validate = context.getCustomerNameError;
    assert.equal(validate('   '), 'Masukkan nama pelanggan.');
    assert.equal(validate('Aleksandra Wiśniewska-Kowalczyk'), '');
    assert.equal(validate('王'.repeat(60)), '');
    assert.equal(validate('👩'.repeat(60)), ''); // SQL length counts code points, not UTF-16 units.
    assert.equal(validate('A'.repeat(61)), 'Nama pelanggan mesti tidak melebihi 60 aksara.');
    assert.equal(validate('  Jo  '), '');
});

test('announcement fallback, rich content, explicit clears and cache invalidation', () => {
    const stored = new Map([['shopAnnouncementHtml', '']]);
    let plain = 'Walk-in dibuka <hari ini> & esok';
    const context = vm.createContext({
        localStorage: { getItem: key => stored.has(key) ? stored.get(key) : null },
        getShopAnnouncement: () => plain.trim(),
        // The sanitizer is an independent boundary. These fixtures are its safe outputs.
        sanitizeAnnouncementHTML: value => value,
        escapeHTML: value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        document: { createElement: () => ({
            innerHTML: '',
            get textContent() { return this.innerHTML.replace(/<[^>]*>/g, '').replaceAll('&nbsp;', ' '); },
            querySelector(tag) { return tag === 'img' && /<img\b/i.test(this.innerHTML) ? {} : null; }
        }) },
        announcementCache: { initialized: false, version: 0 }
    });
    vm.runInContext(source('getAnnouncementRenderState'), context);
    const read = context.getAnnouncementRenderState;
    let state = read();
    assert.equal(state.visible, true);
    assert.equal(state.html, 'Walk-in dibuka &lt;hari ini&gt; &amp; esok');
    const firstVersion = state.version;
    plain = 'Pengumuman baharu';
    state = read();
    assert.equal(state.html, plain);
    assert.ok(state.version > firstVersion);
    assert.equal(read(), state, 'unchanged inputs reuse the render cache');
    stored.set('shopAnnouncementHtml', '<p><br></p>');
    assert.equal(read().html, plain, 'blank editor markup falls back to plain content');
    stored.set('shopAnnouncementHtml', '<p>Kandungan kaya</p>');
    plain = '';
    assert.equal(read().html, '<p>Kandungan kaya</p>');
    assert.equal(read().visible, true, 'valid rich content needs no redundant plain field');
    stored.set('shopAnnouncementHtml', '<img src="data:image/png;base64,AAAA">');
    assert.equal(read().visible, true);
    stored.set('shopAnnouncementHtml', '');
    assert.equal(read().visible, false, 'clearing both fields still hides the announcement');
    stored.delete('shopAnnouncementHtml');
    plain = 'Legacy\nannouncement';
    assert.equal(read().html, 'Legacy<br>announcement');
});
