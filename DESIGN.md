---
name: C-Cutz Barber (QueueCut)
description: Warm, low-lit barbershop interface: espresso surfaces, brass gold, ember-orange accent, moving toward a frosted-glass layer language.
colors:
  espresso-bg: "#0d0a09"
  espresso-surface: "#171310"
  espresso-elevated: "#211b17"
  brass: "#d8b06b"
  brass-strong: "#f0c77e"
  ember: "#ff671d"
  ember-strong: "#ff8a3d"
  cream-text: "#f7f1e9"
  smoke-muted: "#aaa099"
  input-well: "#120f0d"
  paper-bg: "#f2eee9"
  paper-surface: "#fbf8f3"
  paper-elevated: "#ffffff"
  walnut-brass: "#8b642f"
  walnut-brass-strong: "#6f4b1f"
  rust-ember: "#bf3f0b"
  ink-text: "#1d1815"
  ink-muted: "#726862"
  success: "#68a77a"
  warning: "#c99a4b"
  danger: "#d4807a"
  info: "#77a5ad"
typography:
  display:
    fontFamily: "Cormorant Garamond, serif"
    fontWeight: 600
  body:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
  label:
    fontFamily: "Manrope, sans-serif"
    fontSize: ".78rem"
    fontWeight: 700
    letterSpacing: ".055em"
  ticket-number:
    fontFamily: "Manrope, sans-serif"
    fontSize: "clamp(3rem, 12vw, 5.2rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-.04em"
rounded:
  sm: "8px"
  md: "14px"
  lg: "22px"
spacing:
  "1": "5px"
  "2": "10px"
  "3": "15px"
  "4": "20px"
  "5": "25px"
  "6": "30px"
components:
  button-primary:
    backgroundColor: "{colors.brass}"
    textColor: "#11130f"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "11px 18px"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.brass-strong}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.cream-text}"
    rounded: "{rounded.md}"
    padding: "11px 18px"
    height: "46px"
  input-field:
    backgroundColor: "{colors.input-well}"
    textColor: "{colors.cream-text}"
    padding: "12px 15px"
    height: "48px"
---

# Design System: C-Cutz Barber (QueueCut)

## Overview

**Creative North Star: "The Hipster Barbershop"**

A modern, characterful take on the neighbourhood barbershop: a dim, warm room, brass fixtures, one hot ember of orange, and a frosted-glass interface layer floating over it. The user chose this direction, including "a new modern layout with a glass look interface." Be precise about the gap: glass is only partly present in the code today (the top navigation uses `backdrop-filter: blur(20px) saturate(130%)` and dialogs blur their backdrop at 8px). Cards are translucent tints, not true frosted panels. New work should extend glass deliberately rather than treat it as already established.

The system serves four contexts at once: a customer's phone, a barber's tablet, an owner's desk, and an unattended shop TV. Density and legibility win over decoration; brand lives in colour temperature, the serif display face, and the ticket number.

**Key Characteristics:**
- Dark espresso is the default; a warm light "paper" theme is the supported alternate.
- Brass gold carries primary actions and the ticket; ember orange is reserved for accent, glow, and selection.
- Uppercase, tracked Manrope labels on buttons; Cormorant Garamond for display moments.
- Tonal layering plus large, diffuse shadows; no hard drop shadows.
- Teal is an optional third scheme, not canonical.

## Colors

A warm-neutral palette tinted toward brown, with a gold primary and an orange accent.

### Primary
- **Brass** (#d8b06b dark / #8b642f light): primary buttons, ticket border and number.
- **Brass Strong** (#f0c77e dark / #6f4b1f light): hover and the large ticket number.

### Secondary
- **Ember** (#ff671d dark / #bf3f0b light): accent glow, hover tints, text selection, background glow. Rare by design.

### Neutral
- **Espresso** (#0d0a09), **Espresso Surface** (#171310), **Espresso Elevated** (#211b17): page, panel, raised layers.
- **Input Well** (#120f0d): form fields sit darker than their panel.
- **Cream Text** (#f7f1e9) and **Smoke Muted** (#aaa099) on dark. The light theme uses Ink (#1d1815) and Ink Muted (#726862) on Paper (#f2eee9 / #fbf8f3 / #ffffff).
- Borders are the text colour at about 12% (5.5% for dividers), not solid colours.

### Status
- Success #68a77a, Warning #c99a4b, Danger #d4807a (5.3:1 on the tinted danger surface), Info #77a5ad (darker variants in the light theme). The source documents contrast checks for text and primary-on-background in both modes.

### Named Rules
**The One Ember Rule.** Orange is a glow and a signal, not a fill. If a large share of a screen is orange, it has stopped meaning anything.
**The Both Modes Rule.** Every colour decision is made twice, dark espresso and light paper, with contrast verified in both.

## Typography

**Display Font:** Cormorant Garamond (serif), weights 500-600
**Body Font:** Manrope (sans-serif), weights 400-700

**Character:** A classical barbershop serif for moments of identity against a clean geometric sans for everything operational.

### Hierarchy
- **Display** (Cormorant Garamond 600): shop identity and large headings.
- **Body** (Manrope 500, 1rem): forms, lists, descriptions.
- **Label** (Manrope 700, .78rem, +0.055em, uppercase): buttons and small controls.
- **Ticket Number** (Manrope 500, clamp(3rem, 12vw, 5.2rem), line-height 1, -0.04em): the queue number, the largest thing on the customer screen and legible on the shop TV.

### Named Rules
**The Number First Rule.** On customer and display surfaces the queue number is the hero; nothing decorative may outweigh it.

## Layout

Single-column, phone-first flow that widens for tablet, admin, and the TV display. Breakpoints observed at 680px, 768px, and 900px. Spacing is a 5px-base ramp (5, 10, 15, 20, 25, 30px), chosen because it matches the file's dominant declarations. Touch targets are at least 46px for buttons and 48px for fields. A blanket `prefers-reduced-motion` rule disables animation and transitions.

## Elevation & Depth

Tonal layering first: page, surface, and elevated surface step lighter in dark mode and use white-on-paper in the light theme. Shadows are large and diffuse: small `0 12px 34px rgba(0,0,0,.24)` and large `0 30px 90px rgba(0,0,0,.46)` (light theme: warm brown at 9% and 16%). The ticket may carry a soft brass glow. Frosted glass (backdrop blur with a translucent tint) is the stated direction for floating layers such as navigation and overlays.

### Named Rules
**The Diffuse Only Rule.** Shadows spread wide and soft. No tight, dark offset shadows.

## Shapes

Softly rounded: 8px for small controls, 14px for buttons and cards, 22px for large containers. Borders are hairline, low-contrast tints of the text colour. The ticket uses a 2px brass border with a gradient wash of ember and brass tints.

## Components

### Buttons
- **Shape:** 14px radius, 46px minimum height, uppercase tracked label.
- **Primary:** brass fill, near-black text (#11130f), hover to Brass Strong.
- **Outline:** transparent, brass-tinted 1px border, cream text; hover adds a faint ember wash and a 1px lift.
- **Destructive:** danger-coloured border and text, never a filled red.
- **Focus:** 2px Brass Strong outline with 3px offset on every interactive element.

### Inputs / Fields
- 48px high, input-well background, 1px low-contrast border; border shifts to brass on focus, plus the shared focus outline.

### Ticket
- Gradient wash, 2px brass border, centred; the Ticket Number is the focal element.

### Dialogs
- Native dialog with backdrop `rgba(3,5,4,.72)` and an 8px blur.

## Do's and Don'ts

### Do:
- **Do** use Brass for primary actions and Ember sparingly for glow and selection.
- **Do** verify contrast in both dark and light themes.
- **Do** keep the ticket number the largest element on customer and display surfaces.
- **Do** extend glass (blur plus translucent tint) deliberately on floating layers.
- **Do** honour `prefers-reduced-motion`.

### Don't:
- **Don't** fill large areas with orange.
- **Don't** use tight, hard drop shadows.
- **Don't** treat the teal scheme as canonical; it is an optional alternate.
- **Don't** hard-code the shop name or palette in new components; keep them swappable.
