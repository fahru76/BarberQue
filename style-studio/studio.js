import { cuts, views } from "./catalog.js";
import { t, applyStaticCopy } from "./i18n.js";
const viewLabel = (index) => t(views[index].label);

const byId = (id) => document.getElementById(id);
const canvas = byId("canvas"), ctx = canvas.getContext("2d");
const stage = byId("stage"), dialog = byId("capture-dialog");
const video = byId("camera-video");
const sampleUrl = new URL("./assets/sample.webp", import.meta.url).href;
const samples = new Map();
const requiredAngles = [0, 1, 3];
const captureOrder = [...requiredAngles, 2];
const firstMissing = () => requiredAngles.find((index) => !draft[index]);
const instructions = [
  ["Look straight at the camera. Keep your head level and both eyes visible.", "Include the top of your hair, both ears, and your shoulders."],
  ["Show your left ear to the camera. Keep your chin level.", "Your left means your own left. Include your nose, ear, and the back of your head."],
  ["Ask someone to photograph the back of your head, or upload a photo they took.", "This photo is optional. Have your helper hold the phone at eye level and include your neckline. You can add it later or let your barber check the back in person."],
  ["Show your right ear to the camera. Keep your chin level.", "Your right means your own right. Match the distance and lighting of your left photo."],
];
const outlines = [
  "M120 345L120 310C60 270 74 94 180 75C286 94 300 270 240 310L240 345M120 335L50 385M240 335L310 385",
  "M120 345L125 310C65 250 80 92 175 75C240 64 265 114 262 160L290 203L266 215L264 244Q270 276 224 290L220 345M120 335L50 385M220 335L300 385",
  "M118 345L118 300C70 270 70 120 120 90Q180 50 240 90C290 120 290 270 242 300L242 345M118 335L50 385M242 335L310 385M120 298Q180 320 240 298",
  "M240 345L235 310C295 250 280 92 185 75C120 64 95 114 98 160L70 203L94 215L96 244Q90 276 136 290L140 345M240 335L310 385M140 335L60 385",
];
let cut = cuts[0], angle = 0, filter = "All", photos = [];
let paintRequest = 0, drag = null;
let draft = [], step = 0, candidate = null, reviewing = false;
let stream = null, cameraRequest = 0, fileRequest = 0, facing = "user";
let timer = null, seconds = 0;

let statusSource = "", captureStatusSource = "";
const status = (message = "") => { statusSource = message; byId("status").textContent = t(message); };
const captureStatus = (message = "") => { captureStatusSource = message; byId("capture-status").textContent = t(message); };
function button(text, data = {}) {
  const item = document.createElement("button");
  item.type = "button"; item.textContent = t(text); Object.assign(item.dataset, data);
  return item;
}
function decode(url) {
  const image = new Image(); image.src = url;
  return image.decode().then(() => image);
}
function samplePath(style, view) {
  return new URL(`./assets/looks/${style.id}-${view.id}.webp`, import.meta.url).href;
}
function sample(style, view) {
  const key = `${style.id}-${view.id}`;
  if (!samples.has(key)) samples.set(key, decode(samplePath(style, view)).catch((error) => { samples.delete(key); throw error; }));
  return samples.get(key);
}
function renderStyles() {
  const visible = cuts.filter((style) => filter === "All" || style.category === filter);
  byId("count").textContent = visible.length;
  byId("cuts").replaceChildren(...visible.map((style) => {
    const card = button("", { cut: style.id }); card.className = "cut";
    const image = new Image(); image.src = samplePath(style, views[0]); image.alt = "";
    const caption = document.createElement("span"), name = document.createElement("strong"), detail = document.createElement("small");
    name.textContent = style.name; detail.textContent = t(style.detail);
    caption.append(name, detail); card.append(image, caption);
    card.setAttribute("aria-pressed", String(style.id === cut.id));
    return card;
  }));
}
function frame(image, x, y, w, h) {
  const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
  ctx.drawImage(image, x + (w - image.naturalWidth * scale) / 2, y + (h - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
}
async function draw() {
  const request = ++paintRequest, style = cut, index = angle;
  byId("save").disabled = true;
  try {
    const reference = await sample(style, views[index]);
    if (request !== paintRequest) return;
    const personal = Boolean(photos[index]);
    canvas.width = personal ? 1440 : 720; canvas.height = 950;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim(); ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (personal) {
      frame(photos[index].image, 0, 50, 712, 900);
      frame(reference, 728, 50, 712, 900);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(); ctx.fillRect(712, 0, 16, 950);
    } else frame(reference, 0, 50, 720, 900);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--lime").trim(); ctx.font = "600 24px system-ui"; ctx.textAlign = "center";
    ctx.fillText(personal ? t("YOUR {angle} PHOTO", { angle: viewLabel(index).toUpperCase() }) : photos.length ? t("BACK REFERENCE · NO PERSONAL PHOTO") : t("HAIRCUT REFERENCE"), 360, 34);
    if (personal) ctx.fillText(`${style.name.toUpperCase()} · ${t("REFERENCE")}`, 1080, 34);
    canvas.setAttribute("aria-label", personal ? t("Your {angle} photo beside the {style} reference", { angle: viewLabel(index).toLowerCase(), style: style.name }) : t("{style}, {angle} reference only", { style: style.name, angle: viewLabel(index).toLowerCase() }) + (photos.length ? t(". No personal back photo added.") : ""));
    byId("save").disabled = false;
  } catch { if (request === paintRequest) status("This reference could not load. Select another angle or try again."); }
}
function refresh() {
  byId("editor-title").textContent = cut.name;
  byId("preview-kind").textContent = t(photos[angle] ? "YOUR PHOTO + HAIRCUT REFERENCE" : "HAIRCUT REFERENCE ONLY");
  byId("view-name").textContent = t("{angle} view", { angle: viewLabel(angle) });
  byId("view-degrees").textContent = views[angle].degrees;
  byId("upload").textContent = t(photos.length ? "Review / replace photos" : "Take 3 photos");
  byId("reset").hidden = !photos.length;
  byId("photo-name").textContent = t(photos.length ? "Your photos" : "Studio sample");
  byId("photo-description").textContent = photos.length ? t("{count} photos · Back {state}", { count: photos.filter(Boolean).length, state: t(photos[2] ? "added" : "optional") }) : t("Explore haircut references");
  byId("photo-thumb").src = photos[0]?.url ?? sampleUrl;
  byId("comparison-note").textContent = t(photos.length ? photos[angle] ? "Your real photo beside a matching haircut reference. The haircut is not applied to your photo. Show this comparison to your barber." : "Back photo skipped. This is a haircut reference only. Add a photo later with someone’s help, or let your barber check the back in person." : "Studio references. Choose a cut, then explore its four angles.");
  byId("add-back").hidden = !photos.length || Boolean(photos[2]) || angle !== 2;
  byId("photo-list").hidden = !photos.length;
  byId("photo-list").replaceChildren(...views.map((view, index) => {
    const photo = photos[index];
    const item = button("", { angle: index });
    if (photo) { const image = new Image(); image.src = photo.url; image.alt = ""; item.append(image); }
    else { const placeholder = document.createElement("span"); placeholder.className = "optional-placeholder"; placeholder.textContent = "+"; item.append(placeholder); }
    const label = document.createElement("span"); label.textContent = photo ? viewLabel(index) : t("Back · Optional");
    item.append(label); item.setAttribute("aria-pressed", String(index === angle)); return item;
  }));
  byId("views").querySelectorAll("button").forEach((item, index) => item.setAttribute("aria-pressed", String(index === angle)));
  byId("cuts").querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.cut === cut.id)));
  stage.classList.add("turn");
  void draw();
}
function turn(index) { angle = (index + views.length) % views.length; refresh(); }
function release(photo) { if (photo && !photos.includes(photo) && !draft.includes(photo)) URL.revokeObjectURL(photo.url); }
function clearCandidate() { const old = candidate; candidate = null; release(old); }
function cancelCountdown() {
  clearInterval(timer); timer = null; seconds = 0;
  byId("countdown").hidden = true; byId("shutter").disabled = false; byId("switch-camera").disabled = false;
}
function stopCamera() {
  cameraRequest++; cancelCountdown();
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  video.srcObject = null; video.hidden = true;
}
function showStep(index) {
  stopCamera(); fileRequest++; clearCandidate();
  step = index; reviewing = false; candidate = draft[index] ?? null;
  captureStatus(); renderCapture();
}
function renderCapture() {
  byId("capture-step").textContent = reviewing ? t("READY TO PREVIEW") : step === 2 ? t("OPTIONAL PHOTO") : t("STEP {step} OF 3", { step: requiredAngles.indexOf(step) + 1 });
  byId("capture-title").textContent = reviewing ? t("Review your photos") : t("{angle} photo", { angle: viewLabel(step).toLowerCase() }) + (step === 2 ? t(" (optional)") : "");
  byId("capture-single").hidden = reviewing; byId("capture-review").hidden = !reviewing;
  byId("capture-instruction").textContent = t(instructions[step][0]); byId("capture-tip").textContent = t(instructions[step][1]);
  byId("head-outline").setAttribute("d", outlines[step === 1 ? 3 : step === 3 ? 1 : step]); byId("eye-line").toggleAttribute("hidden", step === 2);
  byId("capture-guide").toggleAttribute("hidden", Boolean(candidate));
  byId("capture-image").hidden = !candidate;
  if (candidate) byId("capture-image").src = candidate.url; else byId("capture-image").removeAttribute("src");
  byId("camera-placeholder").hidden = Boolean(candidate || stream);
  byId("source-actions").hidden = Boolean(candidate || stream);
  byId("camera-actions").hidden = !stream || Boolean(candidate);
  byId("confirm-actions").hidden = !candidate;
  byId("use-photo").textContent = requiredAngles.every((index) => draft[index] || index === step) ? t("Use photo & review") : t("Use photo & continue");
  byId("skip-back").hidden = step !== 2 || reviewing;
  byId("skip-back").textContent = t(draft[2] ? "Keep existing photo & go back" : "Skip for now");
  byId("use-camera").textContent = t(step === 2 ? "Use camera with a helper" : "Use camera");
  byId("use-camera").disabled = false;
  byId("capture-steps").replaceChildren(...captureOrder.map((index) => {
    const item = button(`${draft[index] ? "✓ " : ""}${viewLabel(index)}${index === 2 ? t(" (optional)") : ""}`, { step: index });
    item.setAttribute("aria-current", String(!reviewing && step === index)); return item;
  }));
  if (reviewing) {
    byId("review-grid").replaceChildren(...captureOrder.map((index) => {
      const view = views[index];
      const item = button("", { replace: index }); item.className = "review-photo";
      if (draft[index]) { const image = new Image(); image.src = draft[index].url; image.alt = t("{angle} photo", { angle: viewLabel(index).toLowerCase() }); item.append(image); }
      else { const placeholder = document.createElement("span"); placeholder.className = "optional-back"; placeholder.textContent = t("Ask someone to help, or leave this for your barber."); item.append(placeholder); }
      const label = document.createElement("span"); label.textContent = draft[index] ? t("{angle} · Replace", { angle: viewLabel(index) }) : t("Add back photo · Optional");
      item.append(label); return item;
    }));
  }
}
function openCapture(index) {
  draft = [...photos]; candidate = null; facing = "user";
  dialog.showModal();
  if (Number.isInteger(index)) showStep(index);
  else if (firstMissing() === undefined) showReview();
  else showStep(firstMissing());
}
function showReview() {
  stopCamera(); fileRequest++; clearCandidate(); reviewing = true; captureStatus(); renderCapture();
  byId("capture-title").tabIndex = -1; byId("capture-title").focus();
}
function cleanupCapture() {
  stopCamera(); fileRequest++;
  const unused = new Set([...draft, candidate]); draft = []; candidate = null;
  for (const photo of unused) release(photo);
  byId("file").value = ""; byId("capture-image").removeAttribute("src");
  byId("review-grid").replaceChildren(); byId("upload").focus();
}
async function loadPhoto(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) {
    captureStatus("Choose a JPG, PNG, or WebP photo up to 20 MB."); return;
  }
  stopCamera(); const request = ++fileRequest, url = URL.createObjectURL(file); let keep = false;
  captureStatus("Opening photo…");
  try {
    const image = await decode(url);
    if (request !== fileRequest || !dialog.open) return;
    if (image.naturalWidth * image.naturalHeight > 40_000_000) throw Error("This photo is too large. Choose a lower-resolution image.");
    clearCandidate(); candidate = { image, url }; keep = true; captureStatus(); renderCapture();
  } catch (error) { if (request === fileRequest) captureStatus(error.message.startsWith("This photo") ? error.message : "This photo could not open. Try a different JPG, PNG, or WebP."); }
  finally { if (!keep) URL.revokeObjectURL(url); }
}
async function startCamera() {
  stopCamera(); clearCandidate(); captureStatus("Starting camera…"); renderCapture();
  const request = ++cameraRequest; byId("use-camera").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error("Camera access is unavailable. Upload a photo instead.");
    const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1600 } }, audio: false });
    if (request !== cameraRequest || !dialog.open) { next.getTracks().forEach((track) => track.stop()); return; }
    stream = next; video.srcObject = stream; video.hidden = false; await video.play();
    if (request !== cameraRequest || !dialog.open) return;
    captureStatus("Camera ready. The preview is not mirrored."); renderCapture();
  } catch (error) {
    if (request !== cameraRequest) return;
    stopCamera(); renderCapture();
    captureStatus(error.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser or upload a photo." : "Camera could not start. Check that it is connected and not in use, or upload a photo.");
  }
}
async function takePhoto() {
  const active = stream;
  if (!active || !video.videoWidth) { cancelCountdown(); captureStatus("Wait for the camera to be ready, then try again."); return; }
  const target = document.createElement("canvas"); target.width = video.videoWidth; target.height = video.videoHeight;
  target.getContext("2d").drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => target.toBlob(resolve, "image/jpeg", .92));
  if (stream !== active || !dialog.open) return;
  if (!blob) { cancelCountdown(); captureStatus("The photo could not be captured. Try again or upload a photo."); return; }
  await loadPhoto(new File([blob], "camera.jpg", { type: "image/jpeg" }));
}
function countdown() {
  if (!stream || timer) return;
  seconds = 3; byId("countdown").textContent = seconds; byId("countdown").hidden = false;
  byId("shutter").disabled = true; byId("switch-camera").disabled = true;
  timer = setInterval(() => {
    seconds--; byId("countdown").textContent = seconds;
    if (!seconds) { clearInterval(timer); timer = null; void takePhoto(); }
  }, 1000);
}

byId("upload").onclick = () => openCapture();
byId("add-back").onclick = () => openCapture(2);
byId("skip-back").onclick = () => { const missing = firstMissing(); if (missing === undefined) showReview(); else showStep(missing); };
byId("close-capture").onclick = () => dialog.close(); dialog.addEventListener("close", cleanupCapture);
byId("capture-steps").onclick = (event) => { const item = event.target.closest("[data-step]"); if (item) showStep(Number(item.dataset.step)); };
byId("review-grid").onclick = (event) => { const item = event.target.closest("[data-replace]"); if (item) showStep(Number(item.dataset.replace)); };
byId("use-camera").onclick = () => { facing = step === 2 ? "environment" : "user"; void startCamera(); };
byId("switch-camera").onclick = () => { facing = facing === "user" ? "environment" : "user"; void startCamera(); };
byId("shutter").onclick = countdown;
byId("choose-photo").onclick = () => byId("file").click();
byId("camera-upload").onclick = () => { stopCamera(); renderCapture(); byId("file").click(); };
byId("file").onchange = (event) => { const [file] = event.currentTarget.files; event.currentTarget.value = ""; if (file) void loadPhoto(file); };
byId("retake").onclick = () => { clearCandidate(); captureStatus(); renderCapture(); };
byId("use-photo").onclick = () => {
  if (!candidate) return;
  const previous = draft[step]; draft[step] = candidate; candidate = null; release(previous);
  const missing = firstMissing();
  if (missing !== undefined) showStep(missing);
  else showReview();
};
byId("open-preview").onclick = () => {
  if (firstMissing() !== undefined) return;
  const old = photos; photos = [...draft]; for (const photo of old) release(photo);
  angle = 0; dialog.close(); status(); refresh();
};
byId("reset").onclick = () => { const old = photos; photos = []; for (const photo of old) release(photo); angle = 0; status(); refresh(); };
byId("prev").onclick = () => turn(angle - 1); byId("next").onclick = () => turn(angle + 1);
byId("views").replaceChildren(...views.map((view, index) => button(viewLabel(index), { angle: index })));
for (const id of ["views", "photo-list"]) byId(id).onclick = (event) => { const item = event.target.closest("[data-angle]"); if (item) turn(Number(item.dataset.angle)); };
byId("filters").replaceChildren(...["All", "Fade", "Short", "Medium"].map((category) => button(category, { filter: category })));
byId("filters").onclick = (event) => {
  const item = event.target.closest("[data-filter]"); if (!item) return;
  filter = item.dataset.filter; renderStyles();
  byId("filters").querySelectorAll("button").forEach((entry) => entry.setAttribute("aria-pressed", String(entry.dataset.filter === filter)));
};
byId("cuts").onclick = (event) => { const item = event.target.closest("[data-cut]"); if (!item) return; cut = cuts.find((style) => style.id === item.dataset.cut); status(); refresh(); };
stage.onkeydown = (event) => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); turn(angle + (event.key === "ArrowLeft" ? -1 : 1)); };
stage.onpointerdown = (event) => { if (!event.isPrimary || event.button !== 0) return; stage.setPointerCapture(event.pointerId); drag = { id: event.pointerId, x: event.clientX, angle }; };
stage.onpointermove = (event) => { if (event.pointerId !== drag?.id) return; const index = ((drag.angle + Math.round((drag.x - event.clientX) / 95)) % 4 + 4) % 4; if (index !== angle) turn(index); };
stage.onlostpointercapture = () => { drag = null; };
byId("save").onclick = () => {
  const name = `${cut.id}-${views[angle].id}${photos[angle] ? "-comparison" : "-reference"}`;
  canvas.toBlob((blob) => {
    if (!blob) { status("The view could not save. Try again."); return; }
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `c-cutz-${name}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, "image/png");
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden && stream) { stopCamera(); renderCapture(); captureStatus("Camera paused. Select Use camera when you return."); }
});
window.addEventListener("pagehide", stopCamera);
function renderLocale() {
  applyStaticCopy(); renderStyles(); refresh();
  byId("views").querySelectorAll("button").forEach((item, index) => { item.textContent = viewLabel(index); });
  byId("filters").querySelectorAll("button").forEach((item) => { item.textContent = t(item.dataset.filter); item.setAttribute("aria-pressed", String(item.dataset.filter === filter)); });
  status(statusSource); captureStatus(captureStatusSource);
  if (dialog.open) renderCapture();
}
document.querySelectorAll("[data-lang-option]").forEach((item) => { item.onclick = () => window.StudioPreferences.setLanguage(item.dataset.langOption); });
byId("themeSelector").onchange = (event) => window.StudioPreferences.setTheme(event.target.value);
window.addEventListener("studio-preferences", renderLocale);
renderLocale();
