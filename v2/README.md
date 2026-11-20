# C-Cutz Barber V2

An independent customer-screen design preview at /v2/. Work stays on design/barberque-v2, draft PR #41. Existing source, production deployment configuration, database and migrations are unchanged. Do not merge or promote automatically.

## November 20 redesign

The previous spacious cream/serif direction was rejected. This revision replaces it with a compact booking workspace: charcoal queue strip, cool neutral surfaces, cobalt action, Barlow Condensed identity and Source Sans 3 operational text. Colours and typography may differ from production by the user's explicit instruction.

Queue status occupies a strip rather than a hero. Services, price and duration stay together. Walk-in and booking retain the same structure; only booking reveals date/time. The total and review action stay fixed on narrow phones. Haircut references use the existing project images and update the larger desktop preview. Style Studio remains a separate-tab link immediately after services, with another link under references.

## UX laws applied

- Hick: two visit types and two sample services, with booking-only fields disclosed when needed.
- Fitts: 44px minimum interactive targets; 48px inputs; full service rows are clickable.
- Gestalt proximity: service price and duration stay with their service; Studio stays near service selection.
- Jakob: native radio, date, select and dialog controls retain familiar interaction.
- Von Restorff: cobalt highlights the primary action and selected service; navigation stays neutral.
- Error prevention and feedback: inline errors, preserved inputs, review, clearly simulated confirmation and native Escape dismissal.

## Evaluation and boundaries

No backend connection. Prices, queue numbers, waiting estimates and times are sample data. The form creates no real booking or payment; personal inputs remain in page memory. Only V2 language and theme preferences persist under separate keys. Studio is an existing live page, opens separately and receives language/theme/gold-palette parameters.

Try BM/EN, Light/Dark/System, both services and visit types, invalid inputs, review, confirmation, Escape, and all three reference styles. Append ?edit=1 to edit selected presentation text temporarily. Run python -m http.server 4178 --bind 127.0.0.1 from the repository root for local evaluation.

This is the customer design only. Staff/admin workflows and live backend integration remain outside this preview. See VERIFICATION.md for evidence and limitations.
