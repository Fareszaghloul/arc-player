// Arc theme injection hook.
//
// SystemComponent::getNativeShellScript() concatenates this file after
// nativeshell.js into the user script that runs at document creation in every
// page the Arc window loads. jmpInfo.themeCss carries the contents of
// native/arc-theme.css.
//
// The CSS is attached as a constructed stylesheet in document.adoptedStyleSheets.
// The cascade orders adopted sheets after all <style> and <link> sheets, so the
// theme wins over equal-specificity rules however late jellyfin-web loads its own
// theme, without racing it for a position in <head>.
//
// window.ArcTheme is the hook for other Arc features and for devtools:
//   ArcTheme.apply(css)   attach the theme, replacing its CSS (default jmpInfo.themeCss)
//   ArcTheme.remove()     detach the theme
//   ArcTheme.isApplied()  whether the theme sheet is attached
// Every attach or detach dispatches an "arcthemechange" event on window with
// { detail: { applied } }, which native/arcHome.js uses to add or drop its hero.
(function() {
    const sheet = new CSSStyleSheet();

    const isApplied = () => document.adoptedStyleSheets.includes(sheet);

    const notify = () => {
        window.dispatchEvent(new CustomEvent('arcthemechange', { detail: { applied: isApplied() } }));
    };

    const apply = (css = jmpInfo.themeCss || '') => {
        sheet.replaceSync(css);
        if (!isApplied()) {
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }
        notify();
    };

    const remove = () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
        notify();
    };

    window.ArcTheme = { apply, remove, isApplied };

    const applySafely = () => {
        try {
            apply();
        } catch (e) {
            console.error('Arc theme: failed to apply', e);
        }
    };

    if (jmpInfo.settings.main?.arcTheme !== false) {
        applySafely();
    }

    // Live toggle from the client settings modal: nativeshell.js calls each
    // jmpInfo.settingsUpdate callback with the section name and the changed keys.
    jmpInfo.settingsUpdate.push((section, data) => {
        if (section !== 'main' || !('arcTheme' in data)) return;
        if (data.arcTheme) {
            applySafely();
        } else {
            remove();
        }
    });
})();
