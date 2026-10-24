// Arc movie and show pages.
//
// Concatenated after arcPlayer.js by SystemComponent::getNativeShellScript(). When
// jellyfin-web opens the details page of a movie or a series, this puts a full-screen
// hero in front of it:
//
//   - the item's backdrop edge to edge (under the header), its title logo (or name),
//     a details row (rating, years, age rating, runtime and end time / season count),
//     genres, the overview, and Play plus a few round buttons;
//   - along the bottom, "More like this" for a movie, or a season picker and that
//     season's episodes (with watched ticks and progress) for a show.
//
// jellyfin-web's own top part of the page (poster, title, buttons, track pickers,
// overview, its Next Up / Seasons / More like this rows) is hidden by arc-theme.css;
// everything below it (cast, extras, ...) stays and scrolls up under the hero. Other
// item types (episodes, seasons, people, collections, ...) keep the server's page.
//
// Buttons and cards use jellyfin-web's own item actions, as in arcHome.js: they sit
// in an emby-itemscontainer host and carry data-action plus the item's data-id /
// data-serverid / data-type. The watched button is jellyfin-web's emby-playstatebutton.
//
// The header gets Home / library tabs as a pill in the middle (arcPageNav) on these
// pages, standing in for the Home button. Everything here only applies while the Arc
// theme is on.
(function() {
    const TICKS_PER_MINUTE = 600000000;
    const SUPPORTED_TYPES = new Set(['Movie', 'Series']);
    const MAX_SIMILAR = 12;
    const MAX_GENRES = 3;

    let scheduled = false;
    let views = { userId: null, items: null, pending: null };

    const themeOn = () => !!(window.ArcTheme && window.ArcTheme.isApplied());

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    const createActionHost = (className) => window.ArcHome.createActionHost(className);

    // The item id of the details page in the URL (#/details?id=...&serverId=...).
    function urlItemId() {
        const hash = window.location.hash || '';
        if (!hash.startsWith('#/details')) return null;
        const query = hash.indexOf('?');
        return query === -1 ? null : new URLSearchParams(hash.slice(query + 1)).get('id');
    }

    const visiblePage = () => document.querySelector('.itemDetailPage:not(.hide)');

    // ------------------------------------------------------------------ data

    const getJson = (apiClient, path, params) => apiClient.getJSON(apiClient.getUrl(path, params));

    function libraries(apiClient) {
        const userId = apiClient.getCurrentUserId();
        if (views.userId === userId && views.items) return Promise.resolve(views.items);
        if (views.userId === userId && views.pending) return views.pending;
        views = { userId, items: null, pending: null };
        views.pending = apiClient.getUserViews({}, userId)
            .then((result) => (views.items = (result && result.Items) || []))
            .catch((e) => {
                console.warn('Arc details: could not load libraries', e);
                return [];
            })
            .finally(() => { views.pending = null; });
        return views.pending;
    }

    // preferredSeasonId: the season the picker was on, when the page is refreshed.
    async function loadSeries(apiClient, item, preferredSeasonId) {
        const userId = apiClient.getCurrentUserId();
        const [seasonsResult, nextUpResult] = await Promise.all([
            getJson(apiClient, `Shows/${item.Id}/Seasons`, { userId, enableImages: false }),
            getJson(apiClient, 'Shows/NextUp', {
                seriesId: item.Id,
                userId,
                limit: 1,
                enableResumable: true,
                disableFirstEpisode: false,
                fields: 'MediaSourceCount',
                enableImages: false
            }).catch((e) => {
                console.warn('Arc details: could not load next up', e);
                return { Items: [] };
            })
        ]);
        const seasons = (seasonsResult && seasonsResult.Items) || [];
        let nextUp = (nextUpResult && nextUpResult.Items && nextUpResult.Items[0]) || null;

        // Open the season of the next episode, else the first regular season (or, on a
        // refresh, the season that was open).
        const firstSeason = seasons.find((s) => s.IndexNumber > 0) || seasons[0] || null;
        let season = (preferredSeasonId && seasons.find((s) => s.Id === preferredSeasonId)) ||
            (nextUp && seasons.find((s) => s.Id === nextUp.SeasonId)) || firstSeason;
        const episodes = season ? await loadEpisodes(apiClient, item, season) : [];
        if (!nextUp && firstSeason) {
            // Nothing watched yet (or all of it): start from the first regular season.
            const first = season === firstSeason ? episodes : await loadEpisodes(apiClient, item, firstSeason);
            nextUp = first.find((e) => !(e.UserData && e.UserData.Played)) || first[0] || null;
        }
        return { seasons, season, episodes, nextUp };
    }

    async function loadEpisodes(apiClient, series, season) {
        const result = await getJson(apiClient, `Shows/${series.Id}/Episodes`, {
            seasonId: season.Id,
            userId: apiClient.getCurrentUserId(),
            fields: 'Overview',
            enableImageTypes: 'Primary,Thumb,Backdrop',
            imageTypeLimit: 1
        });
        return (result && result.Items) || [];
    }

    async function loadSimilar(apiClient, item) {
        const result = await getJson(apiClient, `Items/${item.Id}/Similar`, {
            userId: apiClient.getCurrentUserId(),
            limit: MAX_SIMILAR,
            fields: 'Genres',
            enableImageTypes: 'Thumb,Backdrop,Logo',
            imageTypeLimit: 1
        }).catch((e) => {
            console.warn('Arc details: could not load similar items', e);
            return { Items: [] };
        });
        return (result && result.Items) || [];
    }

    async function load(apiClient, id, preferredSeasonId) {
        const item = await apiClient.getItem(apiClient.getCurrentUserId(), id);
        if (!SUPPORTED_TYPES.has(item.Type)) return { item };
        const extra = item.Type === 'Series'
            ? await loadSeries(apiClient, item, preferredSeasonId)
            : { similar: await loadSimilar(apiClient, item) };
        return { item, ...extra };
    }

    // -------------------------------------------------------------- artwork

    const image = (apiClient, id, type, tag, maxWidth) =>
        apiClient.getScaledImageUrl(id, { type, tag, maxWidth, quality: 90 });

    function backdropUrl(apiClient, item, maxWidth) {
        if (item.BackdropImageTags && item.BackdropImageTags.length) {
            return image(apiClient, item.Id, 'Backdrop', item.BackdropImageTags[0], maxWidth);
        }
        if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
            return image(apiClient, item.ParentBackdropItemId, 'Backdrop', item.ParentBackdropImageTags[0], maxWidth);
        }
        return null;
    }

    function logoUrl(apiClient, item) {
        if (item.ImageTags && item.ImageTags.Logo) return image(apiClient, item.Id, 'Logo', item.ImageTags.Logo, 900);
        if (item.ParentLogoItemId && item.ParentLogoImageTag) return image(apiClient, item.ParentLogoItemId, 'Logo', item.ParentLogoImageTag, 900);
        return null;
    }

    // Landscape art for a card: a Thumb (which usually carries the title), else the
    // backdrop with the logo laid over it.
    function landscapeArt(apiClient, item) {
        if (item.ImageTags && item.ImageTags.Thumb) {
            return { src: image(apiClient, item.Id, 'Thumb', item.ImageTags.Thumb, 720), logo: null };
        }
        return { src: backdropUrl(apiClient, item, 720), logo: logoUrl(apiClient, item) };
    }

    function episodeArt(apiClient, episode, series) {
        if (episode.ImageTags && episode.ImageTags.Primary) return image(apiClient, episode.Id, 'Primary', episode.ImageTags.Primary, 640);
        if (episode.ImageTags && episode.ImageTags.Thumb) return image(apiClient, episode.Id, 'Thumb', episode.ImageTags.Thumb, 640);
        if (series.ImageTags && series.ImageTags.Thumb) return image(apiClient, series.Id, 'Thumb', series.ImageTags.Thumb, 640);
        return backdropUrl(apiClient, series, 640);
    }

    // -------------------------------------------------------------- markup

    function formatDuration(ticks) {
        const minutes = Math.max(1, Math.round(ticks / TICKS_PER_MINUTE));
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (!h) return `${m}m`;
        return m ? `${h}h ${m}m` : `${h}h`;
    }

    const position = (item) => (item.UserData && item.UserData.PlaybackPositionTicks) || 0;

    function endsAt(item) {
        const remaining = (item.RunTimeTicks || 0) - position(item);
        if (remaining <= 0) return null;
        const end = new Date(Date.now() + remaining / 10000);
        return end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function yearsText(item) {
        const start = item.ProductionYear;
        if (!start) return null;
        if (item.Type !== 'Series') return String(start);
        const end = item.Status === 'Ended' && item.EndDate ? new Date(item.EndDate).getFullYear() : null;
        if (item.Status === 'Ended') return end && end !== start ? `${start} – ${end}` : String(start);
        return `${start} – Present`;
    }

    function metaHtml(item, data) {
        const parts = [];
        if (item.CommunityRating) {
            parts.push(`<span class="arcDetail-rating"><span class="arcDetail-star" aria-hidden="true">★</span>${item.CommunityRating.toFixed(1)}</span>`);
        }
        const years = yearsText(item);
        if (years) parts.push(`<span>${escapeHtml(years)}</span>`);
        if (item.OfficialRating) parts.push(`<span class="arcDetail-badge">${escapeHtml(item.OfficialRating)}</span>`);
        if (item.Type === 'Series') {
            const count = data.seasons.filter((s) => s.IndexNumber > 0).length || data.seasons.length;
            if (count) parts.push(`<span>${count} ${count === 1 ? 'season' : 'seasons'}</span>`);
        } else if (item.RunTimeTicks) {
            parts.push(`<span>${formatDuration(item.RunTimeTicks)}</span>`);
            const end = endsAt(item);
            if (end) parts.push(`<span>Ends at ${escapeHtml(end)}</span>`);
        }
        return parts.join('');
    }

    const itemAttrs = (apiClient, item) =>
        `data-id="${escapeHtml(item.Id)}" data-serverid="${escapeHtml(item.ServerId || apiClient.serverId())}" ` +
        `data-type="${escapeHtml(item.Type)}" data-mediatype="${escapeHtml(item.MediaType || '')}" ` +
        `data-isfolder="${item.IsFolder ? 'true' : 'false'}" data-positionticks="${position(item)}"`;

    function episodeLabel(episode) {
        const s = episode.ParentIndexNumber;
        const e = episode.IndexNumber;
        if (s != null && e != null) return `S${s} E${e}`;
        if (e != null) return `E${e}`;
        return null;
    }

    function actionsHtml(apiClient, item, data) {
        const playTarget = item.Type === 'Series' ? data.nextUp : item;
        let play = '';
        if (playTarget) {
            const resuming = position(playTarget) > 0;
            const label = item.Type === 'Series'
                ? [resuming ? 'Resume' : 'Play', episodeLabel(playTarget)].filter(Boolean).join(' ')
                : (resuming ? 'Resume' : 'Play');
            play = `
                <div class="arcDetail-action" ${itemAttrs(apiClient, playTarget)}>
                    <button type="button" class="arcDetail-play itemAction" data-action="resume">
                        <span class="material-icons" aria-hidden="true">play_arrow</span>${escapeHtml(label)}
                    </button>
                </div>`;
        }
        const shuffle = item.Type === 'Series' ? `
                <div class="arcDetail-action" ${itemAttrs(apiClient, item)}>
                    <button type="button" class="arcDetail-round itemAction" data-action="shuffle" title="Shuffle">
                        <span class="material-icons" aria-hidden="true">shuffle</span>
                    </button>
                </div>` : '';
        const played = !!(item.UserData && item.UserData.Played);
        const watched = `
                <button is="emby-playstatebutton" type="button" data-action="none" class="arcDetail-round arcDetail-watched"
                        data-id="${escapeHtml(item.Id)}" data-serverid="${escapeHtml(item.ServerId || apiClient.serverId())}"
                        data-itemtype="${escapeHtml(item.Type)}" data-played="${played}" title="Mark as watched">
                    <span class="material-icons check" aria-hidden="true"></span>
                </button>`;
        return play + shuffle + watched;
    }

    function similarCardsHtml(apiClient, items) {
        return items.map((item) => {
            const art = landscapeArt(apiClient, item);
            const sub = [item.ProductionYear, (item.Genres || [])[0]].filter(Boolean).map(escapeHtml).join(' · ');
            return `
                <button type="button" class="arcDetail-card itemAction" data-action="link" ${itemAttrs(apiClient, item)}>
                    <span class="arcDetail-cardArt">
                        ${art.src ? `<img loading="lazy" alt="" src="${encodeURI(art.src)}">` : ''}
                        ${art.logo ? `<img class="arcDetail-cardLogo" loading="lazy" alt="" src="${encodeURI(art.logo)}">` : ''}
                    </span>
                    <span class="arcDetail-cardTitle">${escapeHtml(item.Name)}</span>
                    ${sub ? `<span class="arcDetail-cardSub">${sub}</span>` : ''}
                </button>`;
        }).join('');
    }

    function episodeCardsHtml(apiClient, series, episodes) {
        return episodes.map((episode) => {
            const art = episodeArt(apiClient, episode, series);
            const played = !!(episode.UserData && episode.UserData.Played);
            const pos = position(episode);
            const total = episode.RunTimeTicks || 0;
            const percent = pos && total ? Math.min(100, Math.max(2, (pos / total) * 100)) : 0;
            const number = episode.IndexNumber != null ? `${episode.IndexNumber}. ` : '';
            const sub = [total ? formatDuration(total) : null, percent ? `${formatDuration(total - pos)} left` : null]
                .filter(Boolean).join(' · ');
            return `
                <button type="button" class="arcDetail-card arcDetail-episode itemAction" data-action="resume" ${itemAttrs(apiClient, episode)}>
                    <span class="arcDetail-cardArt">
                        ${art ? `<img loading="lazy" alt="" src="${encodeURI(art)}">` : ''}
                        ${played ? '<span class="arcDetail-tick material-icons" aria-label="Watched">check</span>' : ''}
                        ${percent ? `<span class="arcDetail-progress"><span style="width:${percent.toFixed(1)}%"></span></span>` : ''}
                    </span>
                    <span class="arcDetail-cardTitle">${escapeHtml(number + (episode.Name || ''))}</span>
                    ${sub ? `<span class="arcDetail-cardSub">${escapeHtml(sub)}</span>` : ''}
                </button>`;
        }).join('');
    }

    function seasonTabsHtml(seasons, current) {
        if (seasons.length < 2) return '';
        return `<div class="arcDetail-seasons" role="tablist">${seasons.map((s) =>
            `<button type="button" role="tab" class="arcDetail-season${current && s.Id === current.Id ? ' is-active' : ''}"
                     aria-selected="${current && s.Id === current.Id}" data-season-id="${escapeHtml(s.Id)}">${escapeHtml(s.Name)}</button>`
        ).join('')}</div>`;
    }

    // ------------------------------------------------------------------ row

    // A horizontally scrolling card row with arrow buttons at either end.
    function buildRow(cardsHtml, className) {
        const row = document.createElement('div');
        row.className = `arcDetail-row ${className}`;
        const scroller = createActionHost('arcDetail-scroller');
        scroller.innerHTML = cardsHtml;
        const prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'arcDetail-arrow arcDetail-arrow-prev';
        prev.setAttribute('aria-label', 'Previous');
        prev.innerHTML = '<span class="material-icons" aria-hidden="true">chevron_left</span>';
        const next = prev.cloneNode(true);
        next.className = 'arcDetail-arrow arcDetail-arrow-next';
        next.setAttribute('aria-label', 'Next');
        next.querySelector('.material-icons').textContent = 'chevron_right';
        const updateArrows = () => {
            prev.classList.toggle('is-hidden', scroller.scrollLeft <= 2);
            next.classList.toggle('is-hidden', scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2);
        };
        const page = (direction) => scroller.scrollBy({ left: direction * scroller.clientWidth * 0.85, behavior: 'smooth' });
        prev.addEventListener('click', () => page(-1));
        next.addEventListener('click', () => page(1));
        scroller.addEventListener('scroll', updateArrows, { passive: true });
        row.append(prev, scroller, next);
        row.updateArrows = updateArrows;
        requestAnimationFrame(updateArrows);
        return row;
    }

    // Scroll so the given card is the second one in view (the one before it stays visible).
    function scrollToCard(row, id) {
        const scroller = row.querySelector('.arcDetail-scroller');
        const card = id && scroller.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!card) return;
        const previous = card.previousElementSibling;
        scroller.scrollLeft = (previous || card).offsetLeft - scroller.firstElementChild.offsetLeft;
        row.updateArrows();
    }

    // ---------------------------------------------------------------- hero

    // Stretch the hero to the window edges and up under the fixed header.
    function bleed(hero) {
        if (!hero.isConnected) return;
        hero.style.marginTop = '0px';
        hero.style.marginLeft = '0px';
        const rect = hero.getBoundingClientRect();
        hero.style.marginTop = `${-(rect.top + window.scrollY)}px`;
        hero.style.marginLeft = `${-rect.left}px`;
        hero.style.width = `${document.documentElement.clientWidth}px`;
        window.ArcHome.updateHeader();
    }

    function render(page, apiClient, data) {
        const item = data.item;
        const backdrop = backdropUrl(apiClient, item, 2400);
        const logo = logoUrl(apiClient, item);

        const hero = document.createElement('section');
        hero.className = 'arcDetail';
        hero.setAttribute('data-item-id', item.Id);
        hero.innerHTML = `
            <div class="arcDetail-backdrop"${backdrop ? ` style="background-image:url('${encodeURI(backdrop)}')"` : ''}></div>
            <div class="arcDetail-scrim"></div>`;

        const info = document.createElement('div');
        info.className = 'arcDetail-info';
        const genres = (item.Genres || []).slice(0, MAX_GENRES);
        info.innerHTML = `
            ${logo
                ? `<img class="arcDetail-logo" alt="${escapeHtml(item.Name)}" src="${encodeURI(logo)}">`
                : `<h1 class="arcDetail-title">${escapeHtml(item.Name)}</h1>`}
            <div class="arcDetail-meta">${metaHtml(item, data)}</div>
            ${genres.length ? `<div class="arcDetail-genres">${genres.map((g) => `<span>${escapeHtml(g)}</span>`).join('')}</div>` : ''}
            ${item.Overview ? `<p class="arcDetail-overview">${escapeHtml(item.Overview)}</p>` : ''}`;
        const actions = createActionHost('arcDetail-actions');
        actions.innerHTML = actionsHtml(apiClient, item, data);
        info.appendChild(actions);
        hero.appendChild(info);

        const bottom = document.createElement('div');
        bottom.className = 'arcDetail-bottom';
        if (item.Type === 'Series') {
            bottom.innerHTML = seasonTabsHtml(data.seasons, data.season);
            const row = buildRow(episodeCardsHtml(apiClient, item, data.episodes), 'arcDetail-row-episodes');
            bottom.appendChild(row);
            bottom.addEventListener('click', (e) => {
                const tab = e.target.closest('.arcDetail-season');
                if (tab) switchSeason(apiClient, item, data, bottom, tab.getAttribute('data-season-id'));
            });
            hero.appendChild(bottom);
            requestAnimationFrame(() => scrollToCard(row, data.nextUp && data.nextUp.Id));
        } else if (data.similar.length) {
            bottom.innerHTML = '<h2 class="arcDetail-rowTitle">More like this</h2>';
            bottom.appendChild(buildRow(similarCardsHtml(apiClient, data.similar), 'arcDetail-row-similar'));
            hero.appendChild(bottom);
        }

        hero.setAttribute('data-rendered-at', String(Date.now()));
        if (data.season) hero.setAttribute('data-season-id', data.season.Id);
        page.querySelectorAll(':scope > .arcDetail').forEach((el) => el.remove());
        page.prepend(hero);
        page.classList.add('arc-detail-page');
        page.classList.remove('arc-detail-pending');
        bleed(hero);
    }

    async function switchSeason(apiClient, series, data, bottom, seasonId) {
        const season = data.seasons.find((s) => s.Id === seasonId);
        if (!season || (data.season && data.season.Id === seasonId)) return;
        data.season = season;
        const hero = bottom.closest('.arcDetail');
        if (hero) hero.setAttribute('data-season-id', seasonId); // kept when the page refreshes
        bottom.querySelectorAll('.arcDetail-season').forEach((tab) => {
            const active = tab.getAttribute('data-season-id') === seasonId;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', String(active));
        });
        try {
            const episodes = await loadEpisodes(apiClient, series, season);
            if (data.season !== season) return; // another season was picked meanwhile
            data.episodes = episodes;
            const oldRow = bottom.querySelector('.arcDetail-row');
            const row = buildRow(episodeCardsHtml(apiClient, series, episodes), 'arcDetail-row-episodes');
            oldRow.replaceWith(row);
            requestAnimationFrame(() => scrollToCard(row, data.nextUp && data.nextUp.SeasonId === seasonId ? data.nextUp.Id : null));
        } catch (e) {
            console.error('Arc details: could not load the season', e);
        }
    }

    // ---------------------------------------------------------- header nav

    // Home and library tabs as a pill in the middle of the header on movie and show
    // pages. Home goes through the header's own (hidden) Home button; the library
    // tabs open the library like a card would.
    async function ensurePageNav(apiClient, item) {
        const header = document.querySelector('.skinHeader');
        if (!header) return;
        let nav = header.querySelector(':scope > .arcPageNav');
        if (!nav) {
            const items = await libraries(apiClient);
            nav = header.querySelector(':scope > .arcPageNav');
            if (!nav) {
                nav = createActionHost('arcPageNav');
                nav.innerHTML = '<button type="button" class="arcPageNav-tab" data-arc-home="true">Home</button>' +
                    items.filter((lib) => lib.CollectionType === 'movies' || lib.CollectionType === 'tvshows').map((lib) => `
                        <button type="button" class="arcPageNav-tab itemAction" data-action="link"
                                data-id="${escapeHtml(lib.Id)}"
                                data-serverid="${escapeHtml(lib.ServerId || apiClient.serverId())}"
                                data-type="${escapeHtml(lib.Type || 'CollectionFolder')}"
                                data-collectiontype="${escapeHtml(lib.CollectionType || '')}"
                                data-isfolder="true">${escapeHtml(lib.Name)}</button>`).join('');
                nav.addEventListener('click', (e) => {
                    if (!e.target.closest('[data-arc-home]')) return;
                    const home = document.querySelector('.headerHomeButton');
                    if (home) home.click();
                });
                header.appendChild(nav);
            }
        }
        const kind = item.Type === 'Series' ? 'tvshows' : 'movies';
        const tabs = [...nav.querySelectorAll('.arcPageNav-tab[data-collectiontype]')];
        const active = tabs.find((tab) => tab.getAttribute('data-collectiontype') === kind);
        tabs.forEach((tab) => tab.classList.toggle('is-active', tab === active));
    }

    // ------------------------------------------------------------- lifecycle

    function clear(page) {
        if (!page) return;
        page.querySelectorAll(':scope > .arcDetail').forEach((el) => el.remove());
        page.classList.remove('arc-detail-page', 'arc-detail-pending');
        page.removeAttribute('data-arc-detail-id');
    }

    async function ensureDetail(force = false) {
        scheduled = false;
        const page = visiblePage();
        const id = urlItemId();
        const apiClient = window.ApiClient;
        const signedIn = apiClient && apiClient.getCurrentUserId && apiClient.getCurrentUserId();
        const active = !!page && !!id && themeOn() && !!signedIn;
        document.documentElement.classList.toggle('arc-on-detail', active && page.classList.contains('arc-detail-page'));
        if (!active) {
            if (page && !themeOn()) clear(page);
            window.ArcHome.updateHeader();
            return;
        }

        const hero = page.querySelector(':scope > .arcDetail');
        if (!force && page.getAttribute('data-arc-detail-id') === id) {
            if (hero && hero.style.width !== `${document.documentElement.clientWidth}px`) bleed(hero);
            return;
        }

        // Hide jellyfin-web's own header part until we know whether this item gets the
        // Arc layout, so it does not flash first.
        page.setAttribute('data-arc-detail-id', id);
        if (hero && hero.getAttribute('data-item-id') !== id) hero.remove(); // jellyfin-web reused the page
        if (!page.querySelector(':scope > .arcDetail')) page.classList.add('arc-detail-pending');
        try {
            const current = page.querySelector(':scope > .arcDetail');
            const data = await load(apiClient, id, current && current.getAttribute('data-season-id'));
            if (page.getAttribute('data-arc-detail-id') !== id || !themeOn()) return; // moved on meanwhile
            if (!SUPPORTED_TYPES.has(data.item.Type)) {
                page.querySelectorAll(':scope > .arcDetail').forEach((el) => el.remove());
                page.classList.remove('arc-detail-page', 'arc-detail-pending');
                document.documentElement.classList.remove('arc-on-detail');
                window.ArcHome.updateHeader();
                return;
            }
            render(page, apiClient, data);
            document.documentElement.classList.add('arc-on-detail');
            ensurePageNav(apiClient, data.item).catch((e) => console.warn('Arc details: header tabs failed', e));
        } catch (e) {
            console.error('Arc details: failed to build the page', e);
            page.classList.remove('arc-detail-pending');
            page.removeAttribute('data-arc-detail-id');
        }
    }

    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => ensureDetail());
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

    // Coming back to the page (after playback, say) refreshes progress, ticks and the
    // Resume button. jellyfin-web also fires viewshow when the page first opens, while
    // the first build is under way; rebuilding then would swap the hero out from under
    // the pointer, so only a hero that has been up for a moment is refreshed.
    const REFRESH_AFTER_MS = 1500;
    document.addEventListener('viewshow', (e) => {
        const page = e.target;
        if (!page || !page.classList || !page.classList.contains('itemDetailPage')) return;
        requestAnimationFrame(() => {
            const hero = page.querySelector(':scope > .arcDetail');
            const shownFor = hero ? Date.now() - Number(hero.getAttribute('data-rendered-at')) : 0;
            if (hero && hero.getAttribute('data-item-id') === urlItemId() && shownFor > REFRESH_AFTER_MS) {
                ensureDetail(true);
            }
        });
    }, true);

    window.addEventListener('hashchange', schedule);
    window.addEventListener('resize', () => {
        const hero = document.querySelector('.itemDetailPage:not(.hide) > .arcDetail');
        if (hero) bleed(hero);
    });

    window.addEventListener('arcthemechange', (e) => {
        if (e.detail && e.detail.applied) {
            schedule();
        } else {
            document.querySelectorAll('.itemDetailPage').forEach(clear);
            document.querySelectorAll('.arcPageNav').forEach((el) => el.remove());
            document.documentElement.classList.remove('arc-on-detail');
        }
    });
})();
