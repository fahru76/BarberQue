# V2 redesign verification

2026-11-20, independent customer preview.

## Executed

- JavaScript syntax check for app.js and extracted inline Pretext module passed. The previous embedding used replacement-string substitution, which corrupted a dollar sequence in the vendored bundle. Regenerating with literal template concatenation fixes the module; it now parses and the browser reports no console errors.
- Browser exercised empty name, invalid phone, optional empty phone, both service totals, review, sample confirmation, return to form, past-date rejection, future booking summary, native Escape, BM/EN, Light/Dark/System and preference persistence.
- Reference selection changed the desktop image/title and pressed state. All four image elements loaded. Both Studio links carry current language/theme.
- Responsive geometry checked at 375, 768 and 1440 CSS pixels. Document scroll width remained within viewport. The phone review action stayed within the viewport at 375px.
- Fonts verified from Google's official CSS loading endpoint.

## Limits

The required gstack lint ran twice. Its browser renderer still fails on Windows with ENAMETOOLONG uv_spawn; that automated gate is not green. The second static pass has no source blocks besides the renderer failure. Advisory findings include intentionally two-line visit buttons, small radios inside large clickable service rows, numerical step labels and overflow clipping not being used. The tool refused several explanatory waiver comments; these are disclosed rather than represented as a pass. Direct browser evidence covers the layouts and interactions above.

System mode was resolved against the current dark OS setting; changing the operating system itself was not tested. No live Supabase mutations or payment actions were performed. Mobile keyboard/safe-area behaviour still needs a physical-phone check. Staff/admin screens and real availability are not implemented here.
