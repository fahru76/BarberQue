#!/usr/bin/env node
// WCAG contrast harness for theme design. Measures the contrast ratios the
// CURRENT theme achieves for the critical foreground/background token pairs,
// then validates any candidate palette against WCAG AA (4.5:1 normal text,
// 3:1 large text) so new schemes meet the same bar the codebase already
// documents in --on-primary / --on-success.

function srgbToLin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map(c => c + c).join(''); // #fff -> #ffffff
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function ratio(hex1, hex2) {
  const l1 = luminance(hex1), l2 = luminance(hex2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Critical pairs from the codebase's own contrast notes + WCAG AA targets.
const PAIRS = [
  { name: 'text-main on bg-color', fg: '--text-main', bg: '--bg-color', min: 4.5 },
  { name: 'text-main on surface-color', fg: '--text-main', bg: '--surface-color', min: 4.5 },
  { name: 'text-muted on bg-color', fg: '--text-muted', bg: '--bg-color', min: 4.5 },
  { name: 'text-muted on surface-color', fg: '--text-muted', bg: '--surface-color', min: 4.5 },
  { name: 'primary-color on bg-color (links/accents)', fg: '--primary-color', bg: '--bg-color', min: 3.0 },
  { name: 'on-primary on primary-color (btn fill)', fg: '--on-primary', bg: '--primary-color', min: 4.5 },
  { name: 'on-success on success', fg: '--on-success', bg: '--success', min: 4.5 },
  { name: 'warning on surface-color', fg: '--warning', bg: '--surface-color', min: 4.5 },
  { name: 'danger on surface-color', fg: '--danger', bg: '--surface-color', min: 4.5 },
  { name: 'success on surface-color', fg: '--success', bg: '--surface-color', min: 4.5 },
  { name: 'info on surface-color', fg: '--info', bg: '--surface-color', min: 4.5 },
];

const THEMES = {
  'current-dark': {
    '--bg-color': '#0d0a09', '--surface-color': '#171310', '--primary-color': '#d8b06b',
    '--on-primary': '#11130f', '--text-main': '#f7f1e9', '--text-muted': '#aaa099',
    '--warning': '#c99a4b', '--danger': '#c76e68', '--success': '#68a77a', '--info': '#77a5ad', '--on-success': '#11130f'
  },
  'current-light': {
    '--bg-color': '#f2eee9', '--surface-color': '#fbf8f3', '--primary-color': '#8b642f',
    '--on-primary': '#fff', '--text-main': '#1d1815', '--text-muted': '#726862',
    '--warning': '#82601b', '--danger': '#a34e48', '--success': '#3f7d51', '--info': '#477c85', '--on-success': '#fff'
  }
};

const mode = process.argv[2] || 'current';
if (mode === 'current') {
  for (const [name, tokens] of Object.entries(THEMES)) {
    console.log(`\n=== ${name} ===`);
    for (const p of PAIRS) {
      const r = ratio(tokens[p.fg], tokens[p.bg]);
      const pass = r >= p.min;
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${r.toFixed(2)}:1 (min ${p.min})  ${p.name}`);
    }
  }
}
