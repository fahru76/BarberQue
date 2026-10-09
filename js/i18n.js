/*
 * Customer-facing language switch (Bahasa Melayu <-> English).
 *
 * Bahasa Melayu is the source language and the default. English is applied by
 * exact-match lookup on visible text (and a few attributes) inside the
 * customer view, the pass dialog and the shared alert/confirm dialogs, so the
 * existing markup and JS keep writing Malay and nothing else has to change.
 * Anything not in the dictionary stays in Malay -- a missing entry degrades
 * to the original text, never to a blank or a key.
 *
 * Not translated (by design, see the PR): staff/admin/barber/TV screens, text
 * stored in the database (service names, announcements, shop tagline), server
 * error messages, and text drawn into the saved pass PNG / calendar file.
 *
 * Exposes window.CustomerI18n = { getLang, setLang, t, apply }.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'uiLang';
    const ROOT_SELECTORS = ['#customer-app', '#customerPassDialog', '#appAlertDialog', '#appConfirmDialog'];
    const ATTRS = ['placeholder', 'aria-label', 'title'];

    // Exact Malay -> English. Keys are trimmed, single-spaced text.
    const EN = {
        'Masa anda berharga. Sertai giliran semasa atau pilih slot yang paling sesuai: jelas, pantas dan tanpa menunggu tanpa kepastian.':
            'Your time matters. Join the live queue or pick the slot that suits you: clear, quick and no guessing how long you will wait.',
        'Pengumuman Kedai': 'Shop Announcement',
        'KEDAI DITUTUP': 'SHOP CLOSED',
        'Maaf, operasi walk-in kedai telah ditutup buat masa ini.': 'Sorry, walk-in service is closed for now.',
        'Tempahan Online untuk tarikh operasi akan datang masih tersedia.': 'Online bookings for upcoming operating dates are still available.',
        'LIHAT TEMPAHAN SAYA': 'VIEW MY BOOKINGS',
        'WAKTU REHAT KEDAI': 'SHOP BREAK TIME',
        'Kedai sedang direhatkan sehingga jam': 'The shop is on a break until',
        'Anda masih boleh mengambil nombor giliran, tetapi servis akan disambung selepas waktu rehat tamat.':
            'You can still take a queue number, but service resumes after the break ends.',
        'Hadir Terus (Walk-in)': 'Walk-in',
        'Tempah Slot (Kalendar)': 'Book a Slot (Calendar)',
        'Sertai Giliran Hari Ini': "Join Today's Queue",
        'Giliran Walk-in semasa': 'Current walk-in queue',
        'Belum dapat dianggarkan': 'Cannot estimate yet',
        'Jika sertai sekarang': 'If you join now',
        'MAAF, GILIRAN WALK-IN PENUH': 'SORRY, THE WALK-IN QUEUE IS FULL',
        'CARI SLOT KOSONG (ONLINE)': 'FIND AN OPEN SLOT (ONLINE)',
        'Kedai Akan Tutup Sebentar Lagi': 'The Shop Closes Soon',
        'Anggaran giliran dan servis anda mungkin tidak sempat diservis hari ini.': 'Your estimated turn and service may not be completed today.',
        'TEMPAH UNTUK ESOK': 'BOOK FOR TOMORROW',
        'Nama Anda:': 'Your name:',
        'Nombor WhatsApp (pilihan):': 'WhatsApp number (optional):',
        'Pilih Servis:': 'Choose a service:',
        'Servis Asas': 'Basic Services',
        'Gaya Potongan': 'Cut Styles',
        'AMBIL NOMBOR SEKARANG': 'TAKE A NUMBER NOW',
        'TIKET WALK-IN ANDA': 'YOUR WALK-IN TICKET',
        'Nama': 'Name',
        'Status:': 'Status:',
        'Menunggu...': 'Waiting...',
        'Pelanggan menunggu di hadapan': 'Customers waiting ahead',
        'Anggaran masa menunggu': 'Estimated wait',
        'SILA KE KERUSI': 'PLEASE GO TO THE CHAIR',
        'GILIRAN TIBA!': 'YOUR TURN!',
        'LIHAT PAS & QR': 'VIEW PASS & QR',
        'BATAL WALK-IN': 'CANCEL WALK-IN',
        'TUKAR KE TEMPAHAN ONLINE': 'SWITCH TO ONLINE BOOKING',
        '← Kembali ke Menu Utama': '← Back to Main Menu',
        'Tempahan Kalendar': 'Calendar Booking',
        'Lokasi Kedai': 'Shop Location',
        'Alamat / Lokasi:': 'Address / Location:',
        'BUKA GOOGLE MAPS': 'OPEN GOOGLE MAPS',
        'Pilih Tarikh:': 'Choose a date:',
        'Masa (Dijana dinamik):': 'Time (generated live):',
        '-- Pilih Tarikh Dahulu --': '-- Choose a date first --',
        'SAHKAN TEMPAHAN': 'CONFIRM BOOKING',
        'BATAL KEMAS KINI': 'CANCEL UPDATE',
        'TEMPAHAN SAYA': 'MY BOOKINGS',
        'Cara mendapatkan giliran': 'How to get a turn',
        'Cth: Haziq': 'e.g. Haziq',
        'Contoh: 012-345 6789': 'Example: 012-345 6789',
        'Nombor telefon Malaysia, contoh: 012-345 6789': 'Malaysian phone number, e.g. 012-345 6789',
        'Sila masukkan nama': 'Please enter a name',
        'Nombor WhatsApp adalah pilihan dan tidak dikongsi dengan pihak ketiga. Anggaran masa boleh berubah mengikut operasi semasa.':
            'The WhatsApp number is optional and is not shared with third parties. Estimated times can change with current operations.',
        'Nombor WhatsApp adalah pilihan dan tidak dikongsi dengan pihak ketiga. Masa tempahan boleh berubah mengikut operasi semasa.':
            'The WhatsApp number is optional and is not shared with third parties. Booking times can change with current operations.',
        'Aha': 'Sun', 'Isn': 'Mon', 'Sel': 'Tue', 'Rab': 'Wed', 'Kha': 'Thu', 'Jum': 'Fri', 'Sab': 'Sat',
        // Pass dialog
        'Pas Anda': 'Your Pass',
        'KONGSI': 'SHARE',
        'SIMPAN IMEJ': 'SAVE IMAGE',
        'TAMBAH KE KALENDAR': 'ADD TO CALENDAR',
        'TUTUP': 'CLOSE',
        'PAS TEMPAHAN': 'BOOKING PASS',
        'PAS WALK-IN': 'WALK-IN PASS',
        'Perkhidmatan': 'Services',
        'Masa tempahan': 'Booking time',
        'Jenis': 'Type',
        'Kerusi / Barber': 'Chair / Barber',
        'Anggaran': 'Estimate',
        'Tunjukkan kod ini kepada barber semasa tiba.': 'Show this code to the barber when you arrive.',
        'Pas disimpan sebagai imej.': 'Pass saved as an image.',
        'Dikongsi.': 'Shared.',
        'Fail kalendar dimuat turun.': 'Calendar file downloaded.',
        'Perkongsian tidak disokong; imej dimuat turun.': 'Sharing is not supported; image downloaded.',
        'Tidak dapat berkongsi. Cuba lagi.': 'Could not share. Please try again.',
        'Tidak dapat menyimpan imej. Cuba lagi.': 'Could not save the image. Please try again.',
        // Shared dialogs
        'Notis': 'Notice',
        'Kedai sedang ditutup.': 'The shop is closed.',
        'Selesai': 'Done'
    };

    // Numeric / templated strings.
    const PATTERNS = [
        [/^(\d+) minit$/, '$1 min'],
        [/^(\d+) jam (\d+) minit$/, '$1 h $2 min'],
        [/^(\d+) jam$/, '$1 h'],
        [/^Kerusi (\d+)$/, 'Chair $1'],
        [/^Sila ke Kerusi (\d+)$/, 'Please go to Chair $1'],
        [/^SILA KE KERUSI (\d+)$/, 'PLEASE GO TO CHAIR $1'],
        [/^Kedai beroperasi dengan (\d+) kerusi serentak\. Kedudukan boleh berubah mengikut operasi semasa\.$/,
            'The shop is running $1 chairs at once. Your position may change with current operations.']
    ];

    let lang = 'ms';
    const applied = new WeakMap(); // node -> { src, out } for text, element -> { attr: { src, out } } for attributes
    let observer = null;
    let working = false;

    function readStored() {
        try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'ms'; } catch (e) { return 'ms'; }
    }
    function persist(value) {
        try { localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* private mode: not persisted */ }
    }

    function normalise(text) { return String(text).replace(/\s+/g, ' ').trim(); }

    function translate(text) {
        const key = normalise(text);
        if (!key) return null;
        if (Object.prototype.hasOwnProperty.call(EN, key)) return EN[key];
        for (const [re, out] of PATTERNS) {
            if (re.test(key)) return key.replace(re, out);
        }
        return null;
    }

    // Public: translate a message for places that build text in JS.
    function t(text) {
        if (lang !== 'en') return text;
        const out = translate(text);
        return out === null ? text : out;
    }

    function textNodeFor(node) {
        const rec = applied.get(node);
        const current = node.data;
        // If the page rewrote the node after we translated it, the new text is the new source.
        const source = rec && current === rec.out ? rec.src : current;
        if (lang === 'en') {
            const out = translate(source);
            if (out === null) { applied.delete(node); return; }
            const lead = source.match(/^\s*/)[0];
            const trail = source.match(/\s*$/)[0];
            const next = lead + out + trail;
            if (node.data !== next) node.data = next;
            applied.set(node, { src: source, out: next });
        } else if (rec && current === rec.out) {
            node.data = rec.src;
            applied.delete(node);
        }
    }

    function attrFor(el, name) {
        const bag = applied.get(el) || {};
        const rec = bag[name];
        const current = el.getAttribute(name);
        if (current === null) return;
        const source = rec && current === rec.out ? rec.src : current;
        if (lang === 'en') {
            const out = translate(source);
            if (out === null) { if (rec) delete bag[name]; return; }
            if (current !== out) el.setAttribute(name, out);
            bag[name] = { src: source, out };
            applied.set(el, bag);
        } else if (rec && current === rec.out) {
            el.setAttribute(name, rec.src);
            delete bag[name];
        }
    }

    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { textNodeFor(root); return; }
        if (root.nodeType !== 1) return;
        const tag = root.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return;
        for (const name of ATTRS) if (root.hasAttribute(name)) attrFor(root, name);
        for (const child of root.childNodes) walk(child);
    }

    function roots() {
        return ROOT_SELECTORS.map(sel => document.querySelector(sel)).filter(Boolean);
    }

    function apply() {
        working = true;
        try {
            roots().forEach(walk);
            document.querySelectorAll('[data-lang-option]').forEach(btn => {
                btn.setAttribute('aria-pressed', btn.dataset.langOption === lang ? 'true' : 'false');
            });
        } finally { working = false; }
    }

    function setLang(next) {
        lang = next === 'en' ? 'en' : 'ms';
        persist(lang);
        document.documentElement.lang = lang === 'en' ? 'en' : 'ms';
        apply();
    }

    function startObserver() {
        if (observer || typeof MutationObserver === 'undefined') return;
        observer = new MutationObserver(records => {
            if (working || lang !== 'en') return;
            working = true;
            try {
                for (const r of records) {
                    if (r.type === 'characterData') textNodeFor(r.target);
                    else if (r.type === 'attributes') attrFor(r.target, r.attributeName);
                    else r.addedNodes.forEach(walk);
                }
            } finally { working = false; }
        });
        roots().forEach(root => observer.observe(root, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ATTRS
        }));
    }

    function init() {
        lang = readStored();
        document.querySelectorAll('[data-lang-option]').forEach(btn => {
            btn.addEventListener('click', () => setLang(btn.dataset.langOption));
        });
        if (lang === 'en') document.documentElement.lang = 'en';
        startObserver();
        apply();
    }

    window.CustomerI18n = { getLang: () => lang, setLang, t, apply };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
