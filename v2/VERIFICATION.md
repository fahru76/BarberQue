# V2 evaluation record

2026-11-19. Static preview; no live API or database tests were required or run.

- `node --check v2/app.js`: passed.
- Existing repository `npm test`: passed, including scheduler fixtures, differential comparisons, SQL consistency/grant checks and Style Studio links.
- Browser exercise: BM/EN, explicit light/dark, system preference resolution, preference persistence after reload, adult/child totals, empty name, invalid phone, optional empty phone, past-date rejection, future date/time, review summaries, sample confirmation, return-to-form and Escape dismissal passed.
- Browser geometry: checked CSS viewport widths 375, 768 and 1440; document scroll width stayed within viewport. The narrow 321px view was also exercised and corrected during review.
- Style Studio URL carries language, theme and gold palette; opens a separate tab. Existing studio preference parser accepts these values.
- Required design lint was run twice. Its render helper fails with `ENAMETOOLONG: name too long, uv_spawn` on this Windows installation, so it is not a green automated design gate. Direct browser checks above supplement it.

Accepted static lint findings: the original C-Cutz wordmark uses tracked BARBER lettering; the design system intentionally uses a 5px spacing scale, white light-mode raised surfaces, Cormorant Garamond and a blurred native-dialog backdrop. The radio itself is 20px inside an 85px clickable label. The page does not hide horizontal overflow to conceal layout faults. All remain documented rather than represented as an automated pass.

The customer-screen prototype is ready for design evaluation. It does not implement staff/admin flows or live booking availability. System mode was checked against the current dark OS preference; switching the operating system itself was not tested.
