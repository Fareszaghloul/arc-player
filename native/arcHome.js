// Arc home screen, in the style of Apple's TV app.
//
// Concatenated after arcTheme.js by SystemComponent::getNativeShellScript(). It
// watches the DOM for jellyfin-web's .homeSectionsContainer and reshapes it:
//
//   1. A full-bleed hero that runs edge to edge under the translucent header. It
//      leads with what the user is partway through ("Continue Watching", with time
//      left), then the newest movies and series, rotating every 8 seconds.
//   2. Library tabs (Movies, Shows, ...) in the header next to Home, replacing Favorites.
//   3. Only two kinds of server sections stay visible: Continue Watching and the
//      per-library "Recently Added" rows. My Media tiles, Next Up, audio/book
//      resume rows and Live TV are hidden (data-arc-section="other").
//
// Styling lives in native/arc-theme.css, so all of this only applies while the Arc
// theme is on (see the "arcthemechange" event from arcTheme.js); with it off, the
// server's own home page is shown untouched.
//
// Play, Details and the library pills use jellyfin-web's own item actions: they
// sit inside an is="emby-itemscontainer" element and carry data-action plus the
// item's data-id / data-serverid / data-type, exactly like library card buttons.
(function() {
    const ROTATE_MS = 8000;
    const CACHE_MS = 5 * 60 * 1000;
    const MAX_SLIDES = 6;
    const MAX_RESUME_SLIDES = 2;
    const TICKS_PER_MINUTE = 600000000;

    let cache = { userId: null, at: 0, data: null, pending: null };
    let rotateTimer = null;
    let scheduled = false;

    const themeOn = () => !!(window.ArcTheme && window.ArcTheme.isApplied());

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    // ------------------------------------------------------------------ data

    const ITEM_FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,PrimaryImageAspectRatio';

    // Backdrop and logo for an item; episodes borrow their series' artwork.
    function artwork(apiClient, item) {
        let backdrop = null;
        if (item.BackdropImageTags && item.BackdropImageTags.length) {
            backdrop = { id: item.Id, tag: item.BackdropImageTags[0] };
        } else if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
            backdrop = { id: item.ParentBackdropItemId, tag: item.ParentBackdropImageTags[0] };
        }
        let logo = null;
        if (item.ImageTags && item.ImageTags.Logo) {
            logo = { id: item.Id, tag: item.ImageTags.Logo };
        } else if (item.ParentLogoItemId && item.ParentLogoImageTag) {
            logo = { id: item.ParentLogoItemId, tag: item.ParentLogoImageTag };
        }
        return {
            backdrop: backdrop && apiClient.getScaledImageUrl(backdrop.id, { type: 'Backdrop', index: 0, tag: backdrop.tag, maxWidth: 2400, quality: 90 }),
            logo: logo && apiClient.getScaledImageUrl(logo.id, { type: 'Logo', tag: logo.tag, maxWidth: 800 })
        };
    }

    async function loadHome(apiClient) {
        const userId = apiClient.getCurrentUserId();
        const fresh = cache.data && cache.userId === userId && Date.now() - cache.at < CACHE_MS;
        if (fresh) return cache.data;
        if (cache.pending && cache.userId === userId) return cache.pending;

        cache.userId = userId;
        cache.pending = Promise.all([
            apiClient.getResumableItems(userId, {
                MediaTypes: 'Video',
                Limit: MAX_RESUME_SLIDES + 2,
                Recursive: true,
                Fields: ITEM_FIELDS,
                EnableImageTypes: 'Primary,Backdrop,Thumb,Logo',
                ImageTypeLimit: 1,
                EnableTotalRecordCount: false
            }).catch((e) => {
                console.warn('Arc home: could not load resumable items', e);
                return { Items: [] };
            }),
            apiClient.getItems(userId, {
                IncludeItemTypes: 'Movie,Series',
                Recursive: true,
                SortBy: 'DateCreated',
                SortOrder: 'Descending',
                ImageTypes: 'Backdrop',
                Fields: ITEM_FIELDS,
                EnableUserData: true,
                Limit: MAX_SLIDES
            }),
            apiClient.getUserViews({}, userId).catch((e) => {
                console.warn('Arc home: could not load libraries', e);
                return { Items: [] };
            })
        ]).then(([resume, latest, views]) => {
            const slides = [];
            const seen = new Set();
            for (const item of (resume && resume.Items) || []) {
                if (slides.length >= MAX_RESUME_SLIDES) break;
                const key = item.SeriesId || item.Id;
                if (seen.has(key) || !artwork(apiClient, item).backdrop) continue;
                seen.add(key);
                slides.push({ item, resume: true });
            }
            for (const item of (latest && latest.Items) || []) {
                if (slides.length >= MAX_SLIDES) break;
                if (seen.has(item.Id) || !artwork(apiClient, item).backdrop) continue;
                seen.add(item.Id);
                slides.push({ item, resume: false });
            }
            cache.data = { slides, libraries: (views && views.Items) || [] };
            cache.at = Date.now();
            return cache.data;
        }).finally(() => {
            cache.pending = null;
        });
        return cache.pending;
    }

    // -------------------------------------------------------------- markup

    function minutesLeft(item) {
        const total = item.RunTimeTicks || 0;
        const position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
        if (!total || position >= total) return null;
        return Math.max(1, Math.round((total - position) / TICKS_PER_MINUTE));
    }

    function formatMinutes(minutes) {
        if (minutes < 60) return `${minutes} min`;
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m ? `${h} hr ${m} min` : `${h} hr`;
    }

    function eyebrow(slide) {
        if (slide.resume) return 'Continue Watching';
        return slide.item.Type === 'Series' ? 'New Series' : 'New Movie';
    }

    function contentHtml(apiClient, slide) {
        const item = slide.item;
        const art = artwork(apiClient, item);
        const isEpisode = item.Type === 'Episode';
        const titleText = isEpisode ? (item.SeriesName || item.Name) : item.Name;
        const heading = art.logo
            ? `<img class="arcHero-logo" alt="${escapeHtml(titleText)}" src="${encodeURI(art.logo)}">`
            : `<h1 class="arcHero-title">${escapeHtml(titleText)}</h1>`;

        let meta;
        if (isEpisode) {
            const number = [item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : null,
                            item.IndexNumber != null ? `E${item.IndexNumber}` : null].filter(Boolean).join(' · ');
            meta = [number, item.Name].filter(Boolean).map(escapeHtml).join(' &middot; ');
        } else {
            meta = [item.ProductionYear, item.OfficialRating, ...(item.Genres || []).slice(0, 2)]
                .filter(Boolean).map(escapeHtml).join(' &middot; ');
        }

        const position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
        const resumable = position > 0;
        const left = resumable ? minutesLeft(item) : null;
        const percent = resumable && item.UserData.PlayedPercentage ? Math.min(100, Math.max(2, item.UserData.PlayedPercentage)) : 0;
        const progress = resumable
            ? `<div class="arcHero-progress"><div class="arcHero-progressBar"><div style="width:${percent.toFixed(1)}%"></div></div>${left ? `<span>${formatMinutes(left)} left</span>` : ''}</div>`
            : '';

        return `
            <p class="arcHero-eyebrow">${eyebrow(slide)}</p>
            ${heading}
            ${meta ? `<p class="arcHero-meta">${meta}</p>` : ''}
            ${progress}
            ${item.Overview ? `<p class="arcHero-overview">${escapeHtml(item.Overview)}</p>` : ''}
            <div class="arcHero-actions"
                 data-id="${escapeHtml(item.Id)}"
                 data-serverid="${escapeHtml(item.ServerId || apiClient.serverId())}"
                 data-type="${escapeHtml(item.Type)}"
                 data-mediatype="${escapeHtml(item.MediaType || '')}"
                 data-isfolder="${item.IsFolder ? 'true' : 'false'}"
                 data-positionticks="${position}">
                <button type="button" class="arcHero-button arcHero-button-primary itemAction" data-action="resume">
                    <span class="material-icons" aria-hidden="true">play_arrow</span>${resumable ? 'Resume' : 'Play'}
                </button>
                <button type="button" class="arcHero-button arcHero-button-secondary itemAction" data-action="link">
                    Details
                </button>
            </div>`;
    }

    function librariesHtml(apiClient, libraries) {
        return libraries.map((lib) => `
            <button type="button" class="arcLibraries-pill itemAction" data-action="link"
                    data-id="${escapeHtml(lib.Id)}"
                    data-serverid="${escapeHtml(lib.ServerId || apiClient.serverId())}"
                    data-type="${escapeHtml(lib.Type || 'CollectionFolder')}"
                    data-collectiontype="${escapeHtml(lib.CollectionType || '')}"
                    data-isfolder="true">${escapeHtml(lib.Name)}</button>`).join('');
    }

    // jellyfin-web defines emby-itemscontainer as a customized <div>; its click
    // handler turns data-action buttons into real playback and navigation. Current
    // releases register it through the document.registerElement polyfill, which
    // upgrades any element carrying is="emby-itemscontainer" once it is in the
    // document; a native customElements registration is used when present. Without
    // either, clicks fall back to the details page (see onFallbackClick).
    function createActionHost(className) {
        let host;
        if (customElements.get('emby-itemscontainer')) {
            host = document.createElement('div', { is: 'emby-itemscontainer' });
        } else {
            host = document.createElement('div');
            if (typeof document.registerElement === 'function') {
                host.setAttribute('is', 'emby-itemscontainer');
            } else {
                host.addEventListener('click', onFallbackClick);
            }
        }
        host.setAttribute('data-multiselect', 'false');
        host.setAttribute('data-contextmenu', 'false');
        host.className = className;
        return host;
    }

    function onFallbackClick(e) {
        const action = e.target.closest('[data-action]');
        if (!action) return;
        const target = action.closest('[data-id]');
        window.location.hash = `#/details?id=${encodeURIComponent(target.getAttribute('data-id'))}` +
            `&serverId=${encodeURIComponent(target.getAttribute('data-serverid'))}`;
    }

    // ------------------------------------------------------ section filtering

    // Tag each server section so arc-theme.css can keep Continue Watching and the
    // per-library "Recently Added" rows and hide the rest.
    function classifySections(container) {
        for (const section of container.children) {
            // Our own elements, and jellyfin-web's latest-media wrapper, which is a plain
            // <div class="sectionN"> holding one .verticalSection per library.
            if (section.classList.contains('arcHero') || section.classList.contains('arcLibraries')) continue;
            let kind = 'other';
            if (section.querySelector(':scope > .verticalSection')) {
                kind = 'latest'; // the latest-media section nests one section per library
            } else {
                const items = section.querySelector('.itemsContainer');
                const monitor = (items && items.getAttribute('data-monitor')) || '';
                const linkedTitle = section.querySelector('.sectionTitleTextButton');
                if (monitor.includes('videoplayback') && !linkedTitle) kind = 'resume';
            }
            if (section.getAttribute('data-arc-section') !== kind) {
                section.setAttribute('data-arc-section', kind);
            }
        }
    }

    // ---------------------------------------------------------------- hero

    function stopRotation() {
        if (rotateTimer) {
            clearInterval(rotateTimer);
            rotateTimer = null;
        }
    }

    // Stretch the hero to the window edges and up under the fixed header.
    function bleed(hero) {
        if (!hero.isConnected) return;
        hero.style.marginTop = '0px';
        hero.style.marginLeft = '0px';
        const rect = hero.getBoundingClientRect();
        hero.style.marginTop = `${-(rect.top + window.scrollY)}px`;
        hero.style.marginLeft = `${-rect.left}px`;
        hero.style.width = `${document.documentElement.clientWidth}px`;
        updateHeader();
    }

    // Over the hero, the header turns into a soft gradient; past it, the usual
    // translucent bar returns.
    function updateHeader() {
        const hero = document.querySelector('.homePage:not(.hide) .arcHero');
        const header = document.querySelector('.skinHeader');
        let over = false;
        if (hero && hero.isConnected && header && themeOn()) {
            over = hero.getBoundingClientRect().bottom > header.offsetHeight + 1;
        }
        document.documentElement.classList.toggle('arc-header-over-hero', over);
    }

    // Library tabs in the header, right after Home. They sit inside jellyfin-web's tab
    // bar but are not .emby-tab-button elements, so its tab switching ignores them;
    // clicks go through our item-action host and open the library like a card would.
    function ensureNav(apiClient, libraries) {
        const slider = document.querySelector('.headerTabs .emby-tabs-slider');
        if (!slider || !libraries.length) return;
        if (slider.querySelector(':scope > .arcNav')) return;
        const home = slider.querySelector('.emby-tab-button[data-index="0"]');
        if (!home) return;
        const nav = createActionHost('arcNav');
        nav.innerHTML = librariesHtml(apiClient, libraries).replaceAll('arcLibraries-pill', 'arcNav-tab');
        home.after(nav);
    }

    function render(container, apiClient, data) {
        container.querySelectorAll(':scope > .arcHero').forEach((el) => el.remove());
        stopRotation();
        container.setAttribute('data-arc-rendered', 'true');

        const slides = data.slides;
        if (!slides.length) {
            updateHeader();
            return;
        }

        const hero = document.createElement('section');
        hero.className = 'arcHero';
        hero.setAttribute('aria-roledescription', 'carousel');
        hero.innerHTML = slides.map((slide, i) =>
            `<div class="arcHero-slide${i === 0 ? ' is-active' : ''}" style="background-image:url('${encodeURI(artwork(apiClient, slide.item).backdrop)}')"></div>`
        ).join('') + '<div class="arcHero-scrim"></div>';

        const content = createActionHost('arcHero-content');
        content.innerHTML = contentHtml(apiClient, slides[0]);
        hero.appendChild(content);

        if (slides.length > 1) {
            const dots = document.createElement('div');
            dots.className = 'arcHero-dots';
            dots.innerHTML = slides.map((slide, i) =>
                `<button type="button" class="arcHero-dot${i === 0 ? ' is-active' : ''}" aria-label="${escapeHtml(slide.item.SeriesName || slide.item.Name)}"></button>`
            ).join('');
            hero.appendChild(dots);
        }

        let current = 0;
        const show = (index) => {
            current = (index + slides.length) % slides.length;
            hero.querySelectorAll('.arcHero-slide').forEach((el, i) => el.classList.toggle('is-active', i === current));
            hero.querySelectorAll('.arcHero-dot').forEach((el, i) => el.classList.toggle('is-active', i === current));
            content.innerHTML = contentHtml(apiClient, slides[current]);
        };

        hero.addEventListener('click', (e) => {
            const dot = e.target.closest('.arcHero-dot');
            if (dot) show([...dot.parentNode.children].indexOf(dot));
        });

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const start = () => {
            stopRotation();
            if (slides.length > 1 && !reducedMotion) {
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
        bleed(hero);
        start();
    }

    // ------------------------------------------------------------- lifecycle

    async function ensureHome() {
        scheduled = false;
        const container = document.querySelector('.homePage:not(.hide) .homeSectionsContainer');
        // Lets arc-theme.css hide the logo and the Favorites tab on the home page only.
        document.documentElement.classList.toggle('arc-on-home', !!container && themeOn());
        if (!container || !themeOn()) {
            updateHeader();
            return;
        }
        classifySections(container);

        const apiClient = window.ApiClient;
        const signedIn = apiClient && apiClient.getCurrentUserId && apiClient.getCurrentUserId();
        if (signedIn && cache.data && cache.userId === apiClient.getCurrentUserId()) {
            ensureNav(apiClient, cache.data.libraries);
        }

        const hero = container.querySelector(':scope > .arcHero');
        if (hero) {
            if (hero.style.width !== `${document.documentElement.clientWidth}px`) bleed(hero);
            return;
        }
        if (container.hasAttribute('data-arc-rendered')) return; // rendered without slides
        if (container.hasAttribute('data-arc-home')) return; // already loading
        if (!signedIn) return;

        container.setAttribute('data-arc-home', 'loading');
        try {
            const data = await loadHome(apiClient);
            ensureNav(apiClient, data.libraries);
            if (themeOn() && container.isConnected && !container.querySelector(':scope > .arcHero')) {
                render(container, apiClient, data);
            }
        } catch (e) {
            console.error('Arc home: failed to build the home screen', e);
        } finally {
            container.removeAttribute('data-arc-home');
        }
    }

    // jellyfin-web rebuilds the home sections on every visit and refresh, which
    // drops the hero; rebuild on the next frame after any DOM change.
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(ensureHome);
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

    window.addEventListener('scroll', updateHeader, { passive: true });
    window.addEventListener('resize', () => {
        const hero = document.querySelector('.homePage:not(.hide) .arcHero');
        if (hero) bleed(hero);
    });
    window.addEventListener('hashchange', () => requestAnimationFrame(updateHeader));

    window.addEventListener('arcthemechange', (e) => {
        if (e.detail && e.detail.applied) {
            schedule();
        } else {
            stopRotation();
            document.querySelectorAll('.arcHero, .arcLibraries, .arcNav').forEach((el) => el.remove());
            document.querySelectorAll('[data-arc-rendered]').forEach((el) => el.removeAttribute('data-arc-rendered'));
            document.documentElement.classList.remove('arc-on-home');
            document.querySelectorAll('[data-arc-section]').forEach((el) => el.removeAttribute('data-arc-section'));
            updateHeader();
        }
    });
})();
