# Style Studio

The customer page links to `./style-studio/`. This static app contains the C-Cutz haircut references and three-photo consultation flow. Photos stay in tab memory and never go to Supabase or an image-generation service. The back photo is optional.

The studio uses the main page's BM/EN buttons, theme selector structure, and exact Gold, Teal, Forest, and Royal Blue palette tokens in both light and dark modes. Auto follows the device while retaining the chosen palette. The shared browser keys are `uiLang`, `appTheme`, and `appScheme`; preference storage failure does not disable the controls. The entry link also carries language, theme, and scheme as validated query parameters so it works on the custom domain and a GitHub Pages project path. The studio consumes these parameters once; later user changes persist across reloads.

Source is also maintained in the private C-Cutz Sites checkout in the Hairstyle workspace. When updating the studio, copy the contents of that checkout's `public/` to this repo's `style-studio/`, retain the same preference contract, and verify both deployments. Do not copy Site credentials, Worker code, or `.openai/hosting.json` into this public directory.

Checks: `npm test`, studio preference unit tests, and browser navigation from the customer page. Verify BM/EN, all eight color choices, Auto, reload persistence, three-photo review, and missing back-photo reference behavior. Existing bookings, queue records, and migrations do not change.
