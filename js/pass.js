/* Customer pass: a shareable, QR-bearing card for a walk-in ticket or an online booking.
 *
 * Privacy: the QR encodes only the PUBLIC record reference (e.g. "PG01-20261009"),
 * never the private claim token. Anyone holding the image can look the record up
 * for check-in but cannot cancel or reschedule it.
 *
 * Classic script (no modules). Depends on the vendored global `qrcode`.
 * Exposes window.CustomerPass.
 */
(function () {
    'use strict';

    const TZ = 'Asia/Kuala_Lumpur';

    function pick(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && String(value).trim() !== '') return value;
        }
        return '';
    }

    function displayRef(id) {
        return String(id || '').replace(/-\d{8}$/, '');
    }

    /** Normalise a queue ticket or appointment into what the pass shows. */
    function buildPassModel(record, kind, shopName) {
        const isBooking = kind === 'booking';
        const id = String(record.id || '');
        const origin = (window.location.origin && window.location.origin !== 'null') ? window.location.origin : '';
        const qrText = `${origin}${window.location.pathname}?ref=${encodeURIComponent(id)}`;
        const price = Number(pick(record.priceRm, record.price, 0));
        const duration = Number(pick(record.durationMinutes, record.duration, 0));
        return {
            kind: isBooking ? 'booking' : 'walkin',
            id,
            ref: displayRef(id),
            name: String(record.name || ''),
            service: String(pick(record.service, record.services, '')),
            durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : 0,
            priceRm: Number.isFinite(price) && price > 0 ? price : 0,
            date: isBooking ? String(record.date || '') : '',
            time: isBooking ? String(record.time || '') : '',
            seat: String(pick(record.seat, '')),
            barber: String(pick(record.barberName, record.barber, '')),
            shopName: String(shopName || ''),
            qrText
        };
    }

    function createQr(text) {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return qr;
    }

    /** Returns an SVG string. Modules are drawn as one path; quiet zone of 4 modules. */
    function qrSvg(text, dark, light, label) {
        const qr = createQr(text);
        const count = qr.getModuleCount();
        const quiet = 4;
        const size = count + quiet * 2;
        let path = '';
        for (let r = 0; r < count; r++) {
            for (let c = 0; c < count; c++) {
                if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
            }
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${String(label || 'Kod QR').replace(/[^A-Za-z0-9 _.-]/g, '')}"><rect width="${size}" height="${size}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
    }

    function formatRm(value) {
        return value ? `RM ${value.toFixed(2)}` : '';
    }

    function whenLabel(model) {
        if (model.kind === 'booking' && model.date) return `${model.date} ${model.time} GMT+8`.trim();
        return 'Walk-in hari ini';
    }

    function shareText(model) {
        const lines = [
            model.shopName,
            `${model.kind === 'booking' ? 'Tempahan' : 'Giliran'}: ${model.ref}`,
            model.name,
            model.service,
            whenLabel(model)
        ];
        const rm = formatRm(model.priceRm);
        if (rm) lines.push(rm);
        return lines.filter(Boolean).join('\n');
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function truncate(ctx, text, maxWidth) {
        const value = String(text);
        if (ctx.measureText(value).width <= maxWidth) return value;
        let cut = value;
        while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
        return `${cut}…`;
    }

    /** Draw the pass onto a canvas for PNG export/sharing. Returns a canvas. */
    async function drawCanvas(model) {
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) { /* ignore */ } }
        const W = 720;
        const pad = 48;
        const rows = [];
        rows.push(['NAMA', model.name || '-']);
        if (model.service) rows.push(['PERKHIDMATAN', model.service]);
        rows.push([model.kind === 'booking' ? 'MASA TEMPAHAN' : 'JENIS', whenLabel(model)]);
        if (model.seat || model.barber) rows.push(['KERUSI / BARBER', [model.seat && `Kerusi ${model.seat}`, model.barber].filter(Boolean).join(' · ')]);
        const meta = [model.durationMinutes ? `${model.durationMinutes} minit` : '', formatRm(model.priceRm)].filter(Boolean).join('  ·  ');
        if (meta) rows.push(['ANGGARAN', meta]);

        const H = 190 + 150 + rows.length * 86 + 440;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const sans = 'Manrope, system-ui, sans-serif';

        ctx.fillStyle = '#0d0a09';
        ctx.fillRect(0, 0, W, H);
        const card = { x: 24, y: 24, w: W - 48, h: H - 48 };
        const grad = ctx.createLinearGradient(card.x, card.y, card.x + card.w, card.y + card.h);
        grad.addColorStop(0, '#2a1d14');
        grad.addColorStop(0.55, '#1b1511');
        grad.addColorStop(1, '#171310');
        ctx.fillStyle = grad;
        ctx.strokeStyle = 'rgba(216,176,107,.55)';
        ctx.lineWidth = 2;
        roundRect(ctx, card.x, card.y, card.w, card.h, 28);
        ctx.fill();
        ctx.stroke();

        let y = card.y + 70;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#d8b06b';
        ctx.font = `700 22px ${sans}`;
        ctx.fillText(truncate(ctx, (model.shopName || '').toUpperCase(), 360), pad + 24, y);
        ctx.fillStyle = '#aaa099';
        ctx.font = `700 20px ${sans}`;
        ctx.textAlign = 'right';
        ctx.fillText(model.kind === 'booking' ? 'PAS TEMPAHAN' : 'PAS WALK-IN', W - pad - 24, y);

        y += 120;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#f0c77e';
        ctx.font = `500 110px ${sans}`;
        ctx.fillText(truncate(ctx, model.ref, W - pad * 2 - 48), pad + 24, y);

        y += 50;
        for (const [label, value] of rows) {
            ctx.fillStyle = '#aaa099';
            ctx.font = `700 18px ${sans}`;
            ctx.fillText(label, pad + 24, y);
            ctx.fillStyle = '#f7f1e9';
            ctx.font = `600 28px ${sans}`;
            ctx.fillText(truncate(ctx, value, W - pad * 2 - 48), pad + 24, y + 36);
            y += 86;
        }

        // Perforation line
        y += 10;
        ctx.strokeStyle = 'rgba(247,241,233,.25)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 10]);
        ctx.beginPath();
        ctx.moveTo(card.x + 30, y);
        ctx.lineTo(card.x + card.w - 30, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // QR on a white tile for reliable scanning
        const qr = createQr(model.qrText);
        const count = qr.getModuleCount();
        const quiet = 4;
        const cell = Math.max(1, Math.floor(340 / (count + quiet * 2)));
        const side = cell * (count + quiet * 2);
        const qx = Math.round((W - side) / 2);
        const qy = y + 40;
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, qx, qy, side, side, 16);
        ctx.fill();
        ctx.fillStyle = '#111111';
        for (let r = 0; r < count; r++) {
            for (let c = 0; c < count; c++) {
                if (qr.isDark(r, c)) ctx.fillRect(qx + (c + quiet) * cell, qy + (r + quiet) * cell, cell, cell);
            }
        }
        ctx.textAlign = 'center';
        ctx.fillStyle = '#aaa099';
        ctx.font = `600 20px ${sans}`;
        ctx.fillText('Tunjukkan kod ini kepada barber semasa tiba', W / 2, qy + side + 44);
        return canvas;
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG export failed'))), 'image/png');
        });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function fileBase(model) {
        return `pas-${model.ref}`.replace(/[^A-Za-z0-9_-]+/g, '-');
    }

    async function savePng(model) {
        const blob = await canvasToBlob(await drawCanvas(model));
        downloadBlob(blob, `${fileBase(model)}.png`);
    }

    /** Native share with the PNG when supported; falls back to text share, then download. */
    async function sharePass(model) {
        const blob = await canvasToBlob(await drawCanvas(model));
        const file = new File([blob], `${fileBase(model)}.png`, { type: 'image/png' });
        const text = shareText(model);
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file], title: model.shopName, text }); return 'shared'; }
            catch (error) { if (error && error.name === 'AbortError') return 'cancelled'; }
        }
        if (navigator.share) {
            try { await navigator.share({ title: model.shopName, text }); return 'shared-text'; }
            catch (error) { if (error && error.name === 'AbortError') return 'cancelled'; }
        }
        downloadBlob(blob, file.name);
        return 'downloaded';
    }

    function icsEscape(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    /** Build an .ics for a booking. Times are local values tagged with the shop timezone. */
    function buildIcs(model, now = new Date()) {
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(model.date);
        const timeMatch = /^(\d{1,2}):(\d{2})/.exec(model.time);
        if (!dateMatch || !timeMatch) return null;
        const [, y, mo, d] = dateMatch;
        const startMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
        const endMinutes = startMinutes + (model.durationMinutes || 40);
        const fmt = (minutes) => {
            const dayOffset = Math.floor(minutes / 1440);
            const base = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) + dayOffset));
            const mm = ((minutes % 1440) + 1440) % 1440;
            return `${base.getUTCFullYear()}${pad2(base.getUTCMonth() + 1)}${pad2(base.getUTCDate())}T${pad2(Math.floor(mm / 60))}${pad2(mm % 60)}00`;
        };
        const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
        return [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//C-Cutz Barber//Pass//MS',
            'BEGIN:VEVENT',
            `UID:${icsEscape(model.id)}@c-cutzbarber.my`,
            `DTSTAMP:${stamp}`,
            `DTSTART;TZID=${TZ}:${fmt(startMinutes)}`,
            `DTEND;TZID=${TZ}:${fmt(endMinutes)}`,
            `SUMMARY:${icsEscape(`${model.shopName} - ${model.service || 'Tempahan'}`)}`,
            `DESCRIPTION:${icsEscape(`Rujukan ${model.ref}. Nama: ${model.name}`)}`,
            'END:VEVENT',
            'END:VCALENDAR'
        ].join('\r\n');
    }

    function saveIcs(model) {
        const ics = buildIcs(model);
        if (!ics) return false;
        downloadBlob(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), `${fileBase(model)}.ics`);
        return true;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /** Render the pass into `container` using DOM APIs (no untrusted HTML). */
    function renderInto(container, model) {
        container.textContent = '';
        const pass = el('div', 'pass-card');
        const head = el('div', 'pass-head');
        head.append(el('span', 'pass-shop', model.shopName), el('span', 'pass-kind', model.kind === 'booking' ? 'PAS TEMPAHAN' : 'PAS WALK-IN'));
        pass.append(head, el('div', 'pass-ref', model.ref));

        const details = el('dl', 'pass-details');
        const add = (label, value) => {
            if (!value) return;
            const row = el('div', 'pass-row');
            row.append(el('dt', '', label), el('dd', '', value));
            details.append(row);
        };
        add('Nama', model.name);
        add('Perkhidmatan', model.service);
        add(model.kind === 'booking' ? 'Masa tempahan' : 'Jenis', whenLabel(model));
        add('Kerusi / Barber', [model.seat && `Kerusi ${model.seat}`, model.barber].filter(Boolean).join(' · '));
        add('Anggaran', [model.durationMinutes ? `${model.durationMinutes} minit` : '', formatRm(model.priceRm)].filter(Boolean).join(' · '));
        pass.append(details, el('div', 'pass-perforation'));

        const qrWrap = el('div', 'pass-qr');
        // SVG is generated locally from numeric module data; the label is character-filtered.
        qrWrap.innerHTML = qrSvg(model.qrText, '#111111', '#ffffff', `Kod QR rujukan ${model.ref}`);
        pass.append(qrWrap, el('p', 'pass-hint', 'Tunjukkan kod ini kepada barber semasa tiba.'));
        container.append(pass);
    }

    function openDialog(record, kind, shopName) {
        const dialog = document.getElementById('customerPassDialog');
        if (!dialog || !record) return;
        const model = buildPassModel(record, kind, shopName);
        const body = dialog.querySelector('[data-pass-body]');
        const status = dialog.querySelector('[data-pass-status]');
        const calendarBtn = dialog.querySelector('[data-pass-calendar]');
        renderInto(body, model);
        status.textContent = '';
        calendarBtn.hidden = !(model.kind === 'booking' && buildIcs(model));
        dialog.querySelector('[data-pass-save]').onclick = async () => {
            try { await savePng(model); status.textContent = 'Pas disimpan sebagai imej.'; }
            catch (_) { status.textContent = 'Tidak dapat menyimpan imej. Cuba lagi.'; }
        };
        dialog.querySelector('[data-pass-share]').onclick = async () => {
            try {
                const result = await sharePass(model);
                status.textContent = result === 'downloaded' ? 'Perkongsian tidak disokong; imej dimuat turun.' : (result === 'cancelled' ? '' : 'Dikongsi.');
            } catch (_) { status.textContent = 'Tidak dapat berkongsi. Cuba lagi.'; }
        };
        calendarBtn.onclick = () => { status.textContent = saveIcs(model) ? 'Fail kalendar dimuat turun.' : 'Tarikh tempahan tidak sah.'; };
        if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else { dialog.setAttribute('open', ''); }
    }

    window.CustomerPass = { buildPassModel, qrSvg, buildIcs, drawCanvas, openDialog, renderInto };
})();
