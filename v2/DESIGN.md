# V2 design direction

Surface: Operate. A customer on a phone needs to see queue context, choose a service and review a visit. This is an app workspace, not a marketing landing page.

## Colour

Light: background #eef0f2; surface #fcfcfd; text #182026; muted #59636e; accent #2451e6; accent text #f9fbff; selected surface #edf1ff. Dark: background #111416; surface #191d21; text #edf0f3; muted #adb7c1; accent #9cb3ff; accent text #111a35; selected surface #252f49. The queue strip keeps a charcoal surface in both modes. Input boundaries use a stronger separate control token.

## Typography and scale

Barlow Condensed 600/700/800 gives the shop mark and page title a compact identity. Source Sans 3 400/500/600/700 serves the task UI. Both are verified at Google's official Fonts CSS endpoint, loaded with display=swap and sans-serif fallbacks. Body 16px; form labels 16px; service labels 16/18px; section heads 18/20px; page title 32/40px. Captions generally 12/14px. Spacing follows a 4px scale. Radii are 4px for controls and 8px for interactive groups.

## Composition

Header, title, queue strip, workspace. Desktop uses service form plus haircut reference rail. Smaller screens move reference controls below the form and remove the large reference portrait. Phones fix the total/review action at the bottom with safe-area padding and sufficient footer clearance. No decorative animation or loading theatre. Reduced-motion is respected.

## Constraints

BM/EN share structure. System theme follows OS preference. Preferences use V2-only keys. Examples must remain labelled. Hair reference selection is inspiration, not a priced service or an AI haircut applied to the customer. Production DESIGN.md remains untouched.
