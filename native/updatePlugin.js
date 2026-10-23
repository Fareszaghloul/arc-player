// Arc update status and prompt.
//
// jellyfin-web loads this plugin once per web client start (see getPlugins() in
// nativeshell.js). The native updater (api.updater, UpdaterComponent in C++)
// checks for a newer Arc on every launch by itself.
//
// With "Install Updates Automatically" on (the default) the native side downloads,
// verifies and installs the update without asking, waiting for playback to stop
// before restarting. This card only reports progress, offers "Restart now" while
// an update waits for playback to end, and can be hidden.
//
// With it off, the card asks: Later or Install. Nothing is downloaded until Install.
//
// The card carries its own styles so it looks the same with the Arc theme off, and
// it stays out of the way on the video player screen.
(function() {
const HIDDEN_KEY = 'arcUpdateHiddenVersion';

const CARD_CSS = `
.arcUpdate {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 99999;
    width: 340px;
    max-width: calc(100vw - 40px);
    padding: 18px 18px 16px;
    border-radius: 18px;
    background: rgba(28, 28, 30, 0.88);
    -webkit-backdrop-filter: saturate(180%) blur(24px);
    backdrop-filter: saturate(180%) blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
    color: #f5f5f7;
    font: 400 14px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    animation: arcUpdateIn 0.45s cubic-bezier(0.25, 0.1, 0.25, 1) both;
}
.arcUpdate.is-offscreen { display: none; }
@keyframes arcUpdateIn { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: none; } }
.arcUpdate-title { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.arcUpdate-sub { margin: 0; color: rgba(245, 245, 247, 0.6); font-size: 13px; }
.arcUpdate-notes {
    margin: 12px 0 0;
    max-height: 7.5em;
    overflow: auto;
    white-space: pre-wrap;
    color: rgba(245, 245, 247, 0.78);
    font-size: 13px;
}
.arcUpdate-progress { height: 4px; margin: 14px 0 0; border-radius: 2px; background: rgba(255, 255, 255, 0.14); overflow: hidden; display: none; }
.arcUpdate-progress > div { height: 100%; width: 0; background: #f5f5f7; transition: width 0.2s linear; }
.arcUpdate.is-busy .arcUpdate-progress { display: block; }
.arcUpdate-status { margin: 8px 0 0; font-size: 12px; color: rgba(245, 245, 247, 0.6); min-height: 1.2em; }
.arcUpdate-status.is-error { color: #ff6b6b; }
.arcUpdate-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.arcUpdate-actions:empty { display: none; }
.arcUpdate-button {
    border: 0;
    border-radius: 10px;
    padding: 8px 16px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.2s, transform 0.12s;
}
.arcUpdate-button:active { transform: scale(0.97); }
.arcUpdate-button:disabled { opacity: 0.4; cursor: default; }
.arcUpdate-secondary { background: rgba(255, 255, 255, 0.12); color: #f5f5f7; }
.arcUpdate-secondary:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
.arcUpdate-primary { background: #f5f5f7; color: #000; }
.arcUpdate-primary:hover:not(:disabled) { background: #fff; }
`;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const formatSize = (bytes) => {
    if (!bytes || bytes <= 0) return '';
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
};

const onPlayerScreen = () => window.location.hash.startsWith('#/video');

class updatePlugin {
    constructor() {
        this.name = 'Update Plugin';
        this.type = 'input';
        this.id = 'updatePlugin';
        this.card = null;
        this.update = null;

        window.addEventListener('hashchange', () => this.syncVisibility());

        (async () => {
            const api = await window.apiPromise;
            const updater = api.updater;
            if (!updater) {
                console.warn('Arc updater: native updater component is not available');
                return;
            }
            this.updater = updater;

            updater.updateAvailable.connect((update) => this.onAvailable(update));
            updater.updateError.connect((message) => this.onError(message));
            updater.downloadProgress.connect((received, total) => this.onProgress(received, total));
            updater.waitingForPlayback.connect((version) => this.onWaiting(version));
            updater.installing.connect((version) => this.onInstalling(version));
            updater.upToDate.connect((version) => console.info(`Arc updater: ${version} is current`));

            // The native side may already be downloading from its launch-time check.
            updater.status((status) => this.resume(status));

            if (jmpInfo.settings.main.checkForUpdates !== false) {
                updater.check(false);
            }
        })();
    }

    resume(status) {
        if (!status || !status.version) return;
        if (status.phase === 'waiting') this.onWaiting(status.version);
        else if (status.phase === 'installing') this.onInstalling(status.version);
        else if (status.phase === 'downloading' && status.total > 0) this.onProgress(status.received, status.total);
    }

    onAvailable(update) {
        this.update = update;
        if (update.automatic && update.canInstall) {
            this.renderAutomatic(update);
        } else {
            this.renderPrompt(update);
        }
    }

    ensureStyle() {
        if (!document.getElementById('arcUpdateStyle')) {
            const style = document.createElement('style');
            style.id = 'arcUpdateStyle';
            style.textContent = CARD_CSS;
            document.head.appendChild(style);
        }
    }

    mount(html, automatic) {
        if (this.card) return false;
        if (window.sessionStorage.getItem(HIDDEN_KEY) === this.update.version) return false;
        this.ensureStyle();
        const card = document.createElement('div');
        card.className = 'arcUpdate' + (automatic ? ' is-auto' : '');
        card.setAttribute('role', 'status');
        card.setAttribute('aria-label', 'Arc update');
        card.innerHTML = html;
        document.body.appendChild(card);
        this.card = card;
        this.syncVisibility();
        return true;
    }

    renderAutomatic(update) {
        const size = formatSize(update.size);
        const mounted = this.mount(`
            <p class="arcUpdate-title">Updating Arc to ${escapeHtml(update.version)}</p>
            <p class="arcUpdate-sub">Downloading in the background${size ? ` &middot; ${size}` : ''}</p>
            <div class="arcUpdate-progress"><div></div></div>
            <p class="arcUpdate-status" aria-live="polite">Starting download…</p>
            <div class="arcUpdate-actions">
                <button type="button" class="arcUpdate-button arcUpdate-secondary" data-arc="hide">Hide</button>
            </div>`, true);
        if (!mounted) return;
        this.card.classList.add('is-busy');
        this.bind();
    }

    renderPrompt(update) {
        const size = formatSize(update.size);
        const mounted = this.mount(`
            <p class="arcUpdate-title">Arc ${escapeHtml(update.version)} is available</p>
            <p class="arcUpdate-sub">You have ${escapeHtml(update.currentVersion)}${size ? ` &middot; ${size}` : ''}</p>
            ${update.notes ? `<p class="arcUpdate-notes">${escapeHtml(update.notes)}</p>` : ''}
            <div class="arcUpdate-progress"><div></div></div>
            <p class="arcUpdate-status" aria-live="polite"></p>
            <div class="arcUpdate-actions">
                <button type="button" class="arcUpdate-button arcUpdate-secondary" data-arc="hide">Later</button>
                <button type="button" class="arcUpdate-button arcUpdate-primary" data-arc="install">${update.canInstall ? 'Install' : 'Download'}</button>
            </div>`, false);
        if (!mounted) return;
        this.bind();
    }

    bind() {
        this.card.addEventListener('click', (e) => {
            const action = e.target.closest('[data-arc]')?.getAttribute('data-arc');
            if (action === 'hide') {
                window.sessionStorage.setItem(HIDDEN_KEY, this.update.version);
                this.close();
            } else if (action === 'install') {
                this.installNow();
            }
        });
    }

    installNow() {
        if (!this.card) return;
        if (!this.update.canInstall) {
            this.updater.install();
            this.close();
            return;
        }
        this.card.classList.add('is-busy');
        this.card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        this.setStatus('Downloading…');
        this.updater.install();
    }

    setActions(html) {
        if (this.card) this.card.querySelector('.arcUpdate-actions').innerHTML = html;
    }

    onProgress(received, total) {
        if (!this.card || !(total > 0)) return;
        const percent = Math.round((received / total) * 100);
        this.card.querySelector('.arcUpdate-progress > div').style.width = `${percent}%`;
        this.setStatus(`Downloading… ${percent}%`);
    }

    onWaiting(version) {
        if (!this.card && this.update) this.renderAutomatic(this.update);
        if (!this.card) return;
        this.card.classList.add('is-busy');
        this.card.querySelector('.arcUpdate-progress > div').style.width = '100%';
        this.card.querySelector('.arcUpdate-title').textContent = `Arc ${version} is ready`;
        this.card.querySelector('.arcUpdate-sub').textContent = 'Arc will restart to finish updating when playback stops.';
        this.setStatus('');
        this.setActions(`
            <button type="button" class="arcUpdate-button arcUpdate-secondary" data-arc="hide">Hide</button>
            <button type="button" class="arcUpdate-button arcUpdate-primary" data-arc="install">Restart now</button>`);
    }

    onInstalling(version) {
        if (!this.card && this.update) this.renderAutomatic(this.update);
        if (!this.card) return;
        this.card.classList.remove('is-offscreen');
        this.card.classList.add('is-busy');
        this.card.querySelector('.arcUpdate-progress > div').style.width = '100%';
        this.setStatus(`Installing Arc ${version}. Arc will restart.`);
        this.setActions('');
    }

    onError(message) {
        // Errors from a background check (no feed, offline) are only logged. An error
        // while the card is downloading or installing is shown with a retry.
        if (!this.card || !this.card.classList.contains('is-busy')) {
            console.warn('Arc updater:', message);
            return;
        }
        this.card.classList.remove('is-busy');
        this.setStatus(message, true);
        this.setActions(`
            <button type="button" class="arcUpdate-button arcUpdate-secondary" data-arc="hide">Hide</button>
            <button type="button" class="arcUpdate-button arcUpdate-primary" data-arc="install">Try again</button>`);
    }

    setStatus(text, isError = false) {
        if (!this.card) return;
        const status = this.card.querySelector('.arcUpdate-status');
        status.textContent = text;
        status.classList.toggle('is-error', isError);
    }

    // Keep the automatic status card off the video player screen.
    syncVisibility() {
        if (this.card && this.card.classList.contains('is-auto')) {
            this.card.classList.toggle('is-offscreen', onPlayerScreen());
        }
    }

    close() {
        if (this.card) {
            this.card.remove();
            this.card = null;
        }
    }
}

window._updatePlugin = updatePlugin;
})();
