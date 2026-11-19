'use strict';
const $ = (s) => document.querySelector(s);
const storage = { get(k, fallback) { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } }, set(k,v) { try { localStorage.setItem(k,v); } catch { /* Preferences remain usable without storage. */ } } };
let lang = storage.get('ccutzV2Language','ms');
if (!['ms','en'].includes(lang)) lang = 'ms';
let appearance = storage.get('ccutzV2Theme','system');
if (!['light','dark','system'].includes(appearance)) appearance='system';
let mode='walkin';
const media = matchMedia('(prefers-color-scheme: dark)');
const services={adult:{ms:'Potong rambut dewasa',en:'Adult haircut',price:20},child:{ms:'Potong rambut kanak-kanak',en:'Children’s haircut',price:12}};
const tr=(ms,en)=>lang==='ms'?ms:en;
function theme(){ const value=appearance==='system'?(media.matches?'dark':'light'):appearance; document.documentElement.dataset.theme=value; $('#theme').value=appearance; document.querySelector('meta[name="theme-color"]').content=value==='dark'?'#111416':'#eef0f2'; updateStudio(); }
function updateStudio(){ const url=new URL('https://c-cutzbarber.my/style-studio/');url.searchParams.set('lang',lang);url.searchParams.set('theme',appearance==='system'?'auto':appearance);url.searchParams.set('scheme','gold');document.querySelectorAll('[data-style-studio],#studio').forEach(link=>link.href=url.href); }
function translate(){document.documentElement.lang=lang;document.querySelectorAll('[data-ms][data-en]').forEach(el=>{el.textContent=el.dataset[lang];});document.querySelectorAll('[data-lang]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.lang===lang)));$('#theme').setAttribute('aria-label',tr('Paparan','Appearance'));$('#close').setAttribute('aria-label',tr('Tutup','Close'));updateMode();updateStudio();updateLook();document.dispatchEvent(new Event('preview:textchange'));}
function updateMode(){document.querySelectorAll('[data-mode]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.mode===mode)));$('#booking-fields').hidden=mode!=='booking';$('#date').disabled=mode!=='booking';$('#time').disabled=mode!=='booking';$('#review').firstElementChild.textContent=mode==='booking'?tr('Semak tempahan','Review booking'):tr('Semak giliran','Review visit');}
const looks = {
  'low-taper': {title:'Low Taper Fade',ms:'Taper lembut. Bentuk semula jadi.',en:'Soft taper. Natural shape.'},
  'textured-crop': {title:'Textured Crop',ms:'Tekstur pendek. Sisi kemas.',en:'Short texture. Clean sides.'},
  'side-part': {title:'Classic Side Part',ms:'Belahan jelas. Kemasan klasik.',en:'Defined part. Classic finish.'},
};
let selectedLook='low-taper';
function updateLook(){const look=looks[selectedLook];$('#look-title').textContent=look.title;$('#look-detail').textContent=look[lang];$('#look-image').src=`../style-studio/assets/looks/${selectedLook}-front.webp`;$('#look-image').alt=tr(`Rujukan gaya ${look.title}`,`${look.title} haircut reference`);document.querySelectorAll('[data-look]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.look===selectedLook)));}
document.querySelectorAll('[data-look]').forEach(el=>el.addEventListener('click',()=>{selectedLook=el.dataset.look;updateLook();}));
function localDate(){ const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
$('#date').min=localDate();$('#date').value=localDate();
document.querySelectorAll('[data-lang]').forEach(el=>el.addEventListener('click',()=>{lang=el.dataset.lang;storage.set('ccutzV2Language',lang);translate();}));
$('#theme').addEventListener('change',e=>{appearance=e.target.value;storage.set('ccutzV2Theme',appearance);theme();});media.addEventListener('change',theme);
document.querySelectorAll('[data-mode]').forEach(el=>el.addEventListener('click',()=>{mode=el.dataset.mode;updateMode();}));
document.querySelectorAll('[name=service]').forEach(el=>el.addEventListener('change',()=>{$('#total').textContent=`RM ${services[el.value].price}`;}));
function error(id,invalid){$(`#${id}-error`).hidden=!invalid;$(`#${id}`).setAttribute('aria-invalid',String(invalid));}
['name','phone','date'].forEach(id=>$(`#${id}`).addEventListener('input',()=>error(id,false)));
$('#visit').addEventListener('submit',e=>{e.preventDefault();const name=$('#name').value.trim(),phone=$('#phone').value.trim();const invalidName=!name;const invalidPhone=!!phone&&(!/^[+\d\s()-]+$/.test(phone)||phone.replace(/\D/g,'').length<7||phone.replace(/\D/g,'').length>15);const invalidDate=mode==='booking'&&(!$('#date').value||$('#date').value<localDate());error('name',invalidName);error('phone',invalidPhone);error('date',invalidDate);if(invalidName||invalidPhone||invalidDate){$(invalidName?'#name':invalidPhone?'#phone':'#date').focus();return;}
const service=services[document.querySelector('[name=service]:checked').value];const rows=[[tr('Nama','Name'),name],[tr('Servis','Service'),service[lang]],[tr('Kunjungan','Visit'),mode==='walkin'?'Walk-in':`${$('#date').value} · ${$('#time').value}`],[tr('Jumlah contoh','Sample total'),`RM ${service.price}`]];$('#receipt').replaceChildren();for(const [key,value] of rows){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;row.append(dt,dd);$('#receipt').append(row);}$('#review-content').hidden=false;$('#success').hidden=true;$('#summary').showModal();$('#confirm').focus();});
function closeDialog(){$('#summary').close();$('#review').focus();}$('#close').addEventListener('click',closeDialog);$('#again').addEventListener('click',closeDialog);
$('#confirm').addEventListener('click',()=>{$('#review-content').hidden=true;$('#success').hidden=false;$('#ticket').textContent=mode==='walkin'?'A012':tr('Masa dipilih','Time selected');$('#again').focus();});
// Native Escape dismissal preserves the entered form and restores focus.
$('#summary').addEventListener('close',()=>$('#review').focus());
theme();translate();
