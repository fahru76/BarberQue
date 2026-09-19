#!/usr/bin/env node
// Candidate palette validator for the 4-scheme theme design (2026-09-19).
// Scores every critical WCAG pair per scheme+mode. Iterate accent hexes here
// until all PASS, then port into index.html.

function srgbToLin(c){c/=255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);}
function lum(hex){let m=hex.replace('#','');if(m.length===3)m=m.split('').map(c=>c+c).join('');const r=parseInt(m.slice(0,2),16),g=parseInt(m.slice(2,4),16),b=parseInt(m.slice(4,6),16);return 0.2126*srgbToLin(r)+0.7152*srgbToLin(g)+0.0722*srgbToLin(b);}
function ratio(a,b){const l1=lum(a),l2=lum(b);const[hi,lo]=l1>=l2?[l1,l2]:[l2,l1];return(hi+0.05)/(lo+0.05);}

const PAIRS = [
  ['text-main/bg', '--text-main','--bg-color',4.5],
  ['text-main/surface','--text-main','--surface-color',4.5],
  ['text-muted/bg','--text-muted','--bg-color',4.5],
  ['text-muted/surface','--text-muted','--surface-color',4.5],
  ['primary/bg','--primary-color','--bg-color',3.0],
  ['primary/surface','--primary-color','--surface-color',3.0],
  ['on-primary/primary','--on-primary','--primary-color',4.5],
  ['on-success/success','--on-success','--success',4.5],
  ['warning/surface','--warning','--surface-color',4.5],
  ['danger/surface','--danger','--surface-color',4.5],
  ['success/surface','--success','--surface-color',4.5],
  ['info/surface','--info','--surface-color',4.5],
];

// Each scheme: dark + light token sets. Neutrals are tinted to the scheme hue.
const SCHEMES = {
  teal: {
    dark: { '--bg-color':'#0a0f0f','--surface-color':'#111a1a','--primary-color':'#5ec8c0','--on-primary':'#0b1514','--text-main':'#eef7f6','--text-muted':'#9fb4b2','--warning':'#c9a24b','--danger':'#cd7d77','--success':'#6cb08a','--info':'#6fb3c9','--on-success':'#0b1514' },
    light:{ '--bg-color':'#eef4f3','--surface-color':'#f8fbfb','--primary-color':'#1c7a72','--on-primary':'#ffffff','--text-main':'#14211f','--text-muted':'#5f7370','--warning':'#7c5f16','--danger':'#a04a44','--success':'#2f7a4f','--info':'#227081','--on-success':'#ffffff' },
  },
  forest: {
    dark: { '--bg-color':'#0a0e0a','--surface-color':'#121a12','--primary-color':'#7cc97f','--on-primary':'#0d170d','--text-main':'#eff6ee','--text-muted':'#a3b5a1','--warning':'#c9a24b','--danger':'#cd7d77','--success':'#6cb08a','--info':'#7fb3c4','--on-success':'#0d170d' },
    light:{ '--bg-color':'#eff3ee','--surface-color':'#f8faf8','--primary-color':'#2c6e33','--on-primary':'#ffffff','--text-main':'#162115','--text-muted':'#5f7160','--warning':'#7c5f16','--danger':'#a04a44','--success':'#2f7a4f','--info':'#227081','--on-success':'#ffffff' },
  },
  royal: {
    dark: { '--bg-color':'#0a0c12','--surface-color':'#12141d','--primary-color':'#8aa8e8','--on-primary':'#0d1220','--text-main':'#eef1f9','--text-muted':'#a2aabd','--warning':'#c9a24b','--danger':'#cd7d77','--success':'#6cb08a','--info':'#7fa8c9','--on-success':'#0d1220' },
    light:{ '--bg-color':'#eef0f6','--surface-color':'#f9fafc','--primary-color':'#2c4ea3','--on-primary':'#ffffff','--text-main':'#171c28','--text-muted':'#5d6474','--warning':'#7c5f16','--danger':'#a04a44','--success':'#2f7a4f','--info':'#227081','--on-success':'#ffffff' },
  },
};

let fail=0;
for(const [scheme,modes] of Object.entries(SCHEMES)){
  for(const [mode,t] of Object.entries(modes)){
    const rows=[];
    for(const [name,fg,bg,min] of PAIRS){
      const r=ratio(t[fg],t[bg]); const pass=r>=min; if(!pass)fail++;
      rows.push(`    ${pass?'PASS':'FAIL'}  ${r.toFixed(2).padStart(5)}:1 (>=${min})  ${name}`);
    }
    console.log(`\n=== ${scheme} / ${mode} ===\n${rows.join('\n')}`);
  }
}
console.log(`\n${fail?fail+' FAILURES':'ALL PASS'}`);
process.exit(fail?1:0);
