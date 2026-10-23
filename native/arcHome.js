// Arc home screen: a rotating hero banner above the server's home sections.
//
// Concatenated after arcTheme.js by SystemComponent::getNativeShellScript(). It
// watches the DOM for jellyfin-web's .homeSectionsContainer and inserts one
// .arcHero at its top, featuring the newest movies and series that have backdrop
// art. Styling lives in native/arc-theme.css, so the hero is only shown while the
// Arc theme is applied (see the "arcthemechange" event from arcTheme.js).
//
// Play and Details use jellyfin-web's own item actions: the buttons sit inside an
// emby-itemscontainer element and carry data-action="resume" / "link", with the
// item's data-id, data-serverid and data-type on their parent, exactly like the
// action buttons on a library card.
(function() {
    const ROTATE_MS = 8000;
    const CACHE_MS = 5 * 60 * 1000;
    const MAX_ITEMS = 6;

    let cache = { userId: null, at: 0, items: null, pending: null };
    let rotateTimer = null;
    let scheduled = false;

    const themeOn = () => !!(window.ArcTheme && window.ArcTheme.isApplied());

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    async function featuredItems(apiClient) {
        const userId = apiClient.getCurrentUserId();
        const fresh = cache.items && cache.userId === userId && Date.now() - cache.at < CACHE_MS;
        if (fresh) return cache.items;
        if (cache.pending && cache.userId === userId) return cache.pending;

        cache.userId = userId;
        cache.pending = apiClient.getItems(userId, {
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            ImageTypes: 'Backdrop',
            Fields: 'Overview,Genres,ProductionYear,OfficialRating',
            EnableUserData: true,
            Limit: MAX_ITEMS
        }).then((result) => {
            cache.items = (result && result.Items) || [];
            cache.at = Date.now();
            return cache.items;
        }).finally(() => {
            cache.pending = null;
        });
        return cache.pending;
    }

    function slideHtml(apiClient, item, index) {
        const tag = item.BackdropImageTags && item.BackdropImageTags[0];
        const url = apiClient.getScaledImageUrl(item.Id, { type: 'Backdrop', index: 0, tag, maxWidth: 1920, quality: 90 });
        return `<div class="arcHero-slide${index === 0 ? ' is-active' : ''}" style="background-image:url('${encodeURI(url)}')"></div>`;
    }

    function contentHtml(apiClient, item) {
        const logoTag = item.ImageTags && item.ImageTags.Logo;
        const heading = logoTag
            ? `<img class="arcHero-logo" alt="${escapeHtml(item.Name)}" src="${encodeURI(apiClient.getScaledImageUrl(item.Id, { type: 'Logo', tag: logoTag, maxWidth: 700 }))}">`
            : `<h1 class="arcHero-title">${escapeHtml(item.Name)}</h1>`;
        const meta = [item.ProductionYear, item.OfficialRating, ...(item.Genres || []).slice(0, 2)]
            .filter(Boolean).map(escapeHtml).join(' &middot; ');
        const resumable = item.UserData && item.UserData.PlaybackPositionTicks > 0;
        const playLabel = resumable ? 'Resume' : 'Play';
        const kind = item.Type === 'Series' ? 'New series' : 'New movie';

        return `
            <p class="arcHero-eyebrow">${kind}</p>
            ${heading}
            ${meta ? `<p class="arcHero-meta">${meta}</p>` : ''}
            ${item.Overview ? `<p class="arcHero-overview">${escapeHtml(item.Overview)}</p>` : ''}
            <div class="arcHero-actions"
                 data-id="${escapeHtml(item.Id)}"
                 data-serverid="${escapeHtml(item.ServerId || apiClient.serverId())}"
                 data-type="${escapeHtml(item.Type)}"
                 data-mediatype="${escapeHtml(item.MediaType || '')}"
                 data-isfolder="${item.IsFolder ? 'true' : 'false'}"
                 data-positionticks="${resumable ? item.UserData.PlaybackPositionTicks : 0}">
                <button type="button" class="arcHero-button arcHero-button-primary itemAction" data-action="resume">
                    <span class="material-icons" aria-hidden="true">play_arrow</span>${playLabel}
                </button>
                <button type="button" class="arcHero-button arcHero-button-secondary itemAction" data-action="link">
                    Details
                </button>
            </div>`;
    }

    // jellyfin-web defines emby-itemscontainer as a customized <div>; its click
    // handler turns our data-action buttons into real playback and navigation.
    // Current releases register it through the document.registerElement polyfill,
    // which upgrades any element carrying is="emby-itemscontainer" once it is in
    // the document; a native customElements registration is used when present.
    // Without either, the buttons fall back to opening the details page.
    function createActionHost() {
        let host = null;
        if (customElements.get('emby-itemscontainer')) {
            host = document.createElement('div', { is: 'emby-itemscontainer' });
        } else if (typeof document.registerElement === 'function') {
            host = document.createElement('div');
            host.setAttribute('is', 'emby-itemscontainer');
        }
        if (host) {
            host.setAttribute('data-multiselect', 'false');
            host.setAttribute('data-contextmenu', 'false');
        }
        return host;
    }

    function stopRotation() {
        if (rotateTimer) {
            clearInterval(rotateTimer);
            rotateTimer = null;
        }
    }

    function render(container, apiClient, items) {
        if (!items.length || !container.isConnected) return;
        container.querySelectorAll('.arcHero').forEach((el) => el.remove());
        stopRotation();

        const hero = document.createElement('section');
        hero.className = 'arcHero';
        hero.setAttribute('aria-roledescription', 'carousel');
        hero.innerHTML = items.map((item, i) => slideHtml(apiClient, item, i)).join('') +
            '<div class="arcHero-scrim"></div>';

        const host = createActionHost();
        const content = host || document.createElement('div');
        content.classList.add('arcHero-content');
        content.innerHTML = contentHtml(apiClient, items[0]);
        hero.appendChild(content);

        if (items.length > 1) {
            const dots = document.createElement('div');
            dots.className = 'arcHero-dots';
            dots.innerHTML = items.map((item, i) =>
                `<button type="button" class="arcHero-dot${i === 0 ? ' is-active' : ''}" aria-label="${escapeHtml(item.Name)}"></button>`
            ).join('');
            hero.appendChild(dots);
        }

        let current = 0;
        const show = (index) => {
            current = (index + items.length) % items.length;
            hero.querySelectorAll('.arcHero-slide').forEach((el, i) => el.classList.toggle('is-active', i === current));
            hero.querySelectorAll('.arcHero-dot').forEach((el, i) => el.classList.toggle('is-active', i === current));
            content.innerHTML = contentHtml(apiClient, items[current]);
        };

        hero.addEventListener('click', (e) => {
            const dot = e.target.closest('.arcHero-dot');
            if (dot) {
                show([...dot.parentNode.children].indexOf(dot));
                return;
            }
            if (!host) {
                const action = e.target.closest('[data-action]');
                if (action) {
                    const id = action.closest('[data-id]').getAttribute('data-id');
                    window.location.hash = `#/details?id=${encodeURIComponent(id)}&serverId=${encodeURIComponent(apiClient.serverId())}`;
                }
            }
        });

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const start = () => {
            stopRotation();
            if (items.length > 1 && !reducedMotion) {
                rotateTimer = setInterval(() => {
                    if (!hero.isConnected) {
                        stopRotation();
                        return;
                    }
                    show(current + 1);
                }, ROTATE_MS);
            }
        };
        hero.addEventListener('mouseenter', stopRotation);
        hero.addEventListener('mouseleave', start);
        hero.addEventListener('focusin', stopRotation);

        container.prepend(hero);
        start();
    }

    async function ensureHero() {
        scheduled = false;
        const container = document.querySelector('.homePage:not(.hide) .homeSectionsContainer');
        if (!container || !themeOn()) return;
        if (container.querySelector(':scope > .arcHero')) return;
        if (container.hasAttribute('data-arc-hero')) return;

        const apiClient = window.ApiClient;
        if (!apiClient || !apiClient.getCurrentUserId || !apiClient.getCurrentUserId()) return;

        container.setAttribute('data-arc-hero', 'loading');
        try {
            const items = await featuredItems(apiClient);
            if (themeOn() && !container.querySelector(':scope > .arcHero')) {
                render(container, apiClient, items);
            }
        } catch (e) {
            console.error('Arc home: failed to load featured items', e);
        } finally {
            container.removeAttribute('data-arc-hero');
        }
    }

    // jellyfin-web rebuilds the home sections on every visit and refresh, which
    // drops the hero; re-insert it on the next frame after any DOM change.
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(ensureHero);
    };

    const startObserving = () => {
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
        schedule();
    };

    if (document.body) {
        startObserving();
    } else {
        document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }

    window.addEventListener('arcthemechange', (e) => {
        if (e.detail && e.detail.applied) {
            schedule();
        } else {
            stopRotation();
            document.querySelectorAll('.arcHero').forEach((el) => el.remove());
        }
    });
})();
