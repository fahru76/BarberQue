(() => {
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Preferences still work in memory. */ } };
  const schemes = ["gold", "teal", "forest", "royal"];
  const validScheme = (value) => schemes.includes(value) ? value : "gold";
  const validTheme = (value) => value === "auto" || schemes.some((item) => ["light", "dark"].some((mode) => value === `${item}:${mode}`));
  const params = new URLSearchParams(location.search), system = matchMedia("(prefers-color-scheme: dark)");
  let language = ["ms", "en"].includes(params.get("lang")) ? params.get("lang") : read("uiLang") === "en" ? "en" : "ms";
  let scheme = validScheme(params.get("scheme") || read("appScheme"));
  const normalize = (value) => validTheme(value) ? value : ["light", "dark"].includes(value) ? `${scheme}:${value}` : "auto";
  let theme = normalize(params.get("theme") || read("appTheme"));
  const backgrounds = { gold: ["#0d0a09", "#f2eee9"], teal: ["#0a0f0f", "#eef4f3"], forest: ["#0a0e0a", "#eff3ee"], royal: ["#0a0c12", "#eef0f6"] };
  function apply() {
    if (theme !== "auto") scheme = theme.split(":")[0];
    const resolved = theme === "auto" ? system.matches ? "dark" : "light" : theme.split(":")[1];
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.scheme = scheme;
    document.documentElement.style.colorScheme = `only ${resolved}`;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", `only ${resolved}`);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", backgrounds[scheme][resolved === "light" ? 1 : 0]);
    window.dispatchEvent(new CustomEvent("studio-preferences"));
  }
  function persistTheme() { write("appTheme", theme); write("appScheme", theme === "auto" ? scheme : theme.split(":")[0]); }
  window.StudioPreferences = {
    get language() { return language; }, get theme() { return theme; }, get scheme() { return scheme; },
    setLanguage(value) { if (!["ms", "en"].includes(value)) return; language = value; write("uiLang", language); apply(); },
    setTheme(value) { if (!validTheme(value) && !["light", "dark", "system"].includes(value)) return; theme = normalize(value); persistTheme(); apply(); },
  };
  if (params.has("lang")) write("uiLang", language);
  if (params.has("theme") || params.has("scheme")) persistTheme();
  if (["lang", "theme", "scheme"].some((key) => params.has(key))) {
    const clean = new URL(location.href); for (const key of ["lang", "theme", "scheme"]) clean.searchParams.delete(key);
    history.replaceState(null, "", clean);
  }
  system.addEventListener("change", () => { if (theme === "auto") apply(); });
  window.addEventListener("storage", (event) => {
    if (event.key === "uiLang" || event.key === null) language = read("uiLang") === "en" ? "en" : "ms";
    if (["appTheme", "appScheme", null].includes(event.key)) { scheme = validScheme(read("appScheme")); theme = normalize(read("appTheme")); }
    if (["uiLang", "appTheme", "appScheme", null].includes(event.key)) apply();
  });
  apply();
})();
