# C-Cutz Barber V2

Independent, interactive customer-screen design preview. Open `/v2/` on this branch’s deployment, or run `python -m http.server 4176 --bind 127.0.0.1` at the repository root and visit http://127.0.0.1:4176/v2/.

This branch adds only `v2/`. Existing application files, production configuration, Supabase migrations and APIs are unchanged. Do not merge or promote automatically. There is no backend connection: service prices, availability, queue numbers and confirmation are explicitly sample data. Names and phones stay in page memory; only V2 language/theme preferences persist under separate storage keys.

## Design decisions

- Hick’s Law: two visit types and a small sample service choice keep the next action clear.
- Fitts’s Law: actions are at least 44px; fields and primary actions are at least 50px tall.
- Gestalt proximity: prices and durations sit with their service; Style Studio sits beside service selection rather than above the main task.
- Progressive disclosure: booking date and time appear only for bookings.
- Von Restorff effect: one brass primary action per stage; secondary actions stay quiet.
- Jakob’s Law: native radios, select, date input and modal dialog use familiar browser behaviour.
- Error prevention: inline errors, retained form values, a review step and an explicit simulation confirmation.
- Visibility of system status: sample queue and wait estimate stay visible, with clear sample labels and confirmation feedback.
- Accessibility: semantic form labels, keyboard focus, skip link, native modal focus containment, BM/EN, system-aware theme, reduced-motion support and responsive text layout.

Colours are derived from the C-Cutz espresso/brass and paper/walnut palettes. The user authorised typography and colour refinement. Manrope serves operational text; Cormorant Garamond serves identity and the introduction. No frontend framework or UI library migration is required. Pretext is vendored inline for responsive text sizing; fonts load from Google Fonts with system fallbacks. `?edit=1` enables editing marked presentation text for evaluation only; edits are not persisted.

## Evaluation

Try BM/EN, Light/Dark/System, both visit types, invalid/valid inputs, both services, review, confirmation, Escape and return-to-form. Resize at 375, 768, 1024 and 1440 pixels. Style Studio opens the existing live studio in a separate tab and carries language/theme preferences; the main website link opens the existing production application.

## Boundaries

This is the V2 customer design, not a replacement for staff, admin, reporting, live queue or payment workflows. Backend integration requires a separate staging environment and another implementation pass. No production actions happen from the V2 form.
