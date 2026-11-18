(() => {
    const links = document.querySelectorAll('[data-style-studio]');
    // Keep the route relative so the custom domain and GitHub Pages both work.
    links.forEach(link => link.addEventListener('click', () => {
        const destination = new URL('./style-studio/', document.baseURI);
        const language = window.CustomerI18n?.getLang() || document.documentElement.lang;
        let theme = 'auto';
        try { theme = localStorage.getItem('appTheme') || 'auto'; } catch { /* Device default. */ }
        destination.searchParams.set('lang', language === 'en' ? 'en' : 'ms');
        destination.searchParams.set('theme', theme);
        try { destination.searchParams.set('scheme', localStorage.getItem('appScheme') || 'gold'); } catch { /* Default scheme. */ }
        link.href = destination.href;
    }));
})();
