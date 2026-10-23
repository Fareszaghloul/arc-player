// Arc update prompt.
//
// jellyfin-web loads this plugin once per web client start (see getPlugins() in
// nativeshell.js). It asks the native updater (api.updater, UpdaterComponent in
// C++) whether a newer Arc is published and, if so, shows a small card with the
// release notes. Nothing is downloaded until the user chooses Install; the native
// side then verifies the installer's SHA-256, runs it silently and restarts Arc.
//
// The card carries its own styles so it looks the same with the Arc theme off.
(function() {
const DISMISSED_KEY = 'arcUpdateDismissedVersion';

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
.arcUpdate-later { background: rgba(255, 255, 255, 0.12); color: #f5f5f7; }
.arcUpdate-later:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
.arcUpdate-install { background: #f5f5f7; color: #000; }
.arcUpdate-install:hover:not(:disabled) { background: #fff; }
`;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const formatSize = (bytes) => {
    if (!bytes || bytes <= 0) return '';
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
};

class updatePlugin {
    constructor() {
        this.name = 'Update Plugin';
        this.type = 'input';
        this.id = 'updatePlugin';
        this.card = null;

        (async () => {
            const api = await window.apiPromise;
            const updater = api.updater;
            if (!updater) {
                console.warn('Arc updater: native updater component is not available');
                return;
            }
            this.updater = updater;

            updater.updateAvailable.connect((update) => this.show(update));
            updater.updateError.connect((message) => this.onError(message));
            updater.downloadProgress.connect((received, total) => this.onProgress(received, total));
            updater.installing.connect((version) => this.onInstalling(version));
            updater.upToDate.connect((version) => console.info(`Arc updater: ${version} is current`));

            if (jmpInfo.settings.main.checkForUpdates !== false) {
                updater.check(false);
            }
        })();
    }

    show(update) {
        if (this.card) return;
        if (window.sessionStorage.getItem(DISMISSED_KEY) === update.version) return;
        this.update = update;

        if (!document.getElementById('arcUpdateStyle')) {
            const style = document.createElement('style');
            style.id = 'arcUpdateStyle';
            style.textContent = CARD_CSS;
            document.head.appendChild(style);
        }

        const size = formatSize(update.size);
        const card = document.createElement('div');
        card.className = 'arcUpdate';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-label', 'Arc update');
        card.innerHTML = `
            <p class="arcUpdate-title">Arc ${escapeHtml(update.version)} is available</p>
            <p class="arcUpdate-sub">You have ${escapeHtml(update.currentVersion)}${size ? ` &middot; ${size}` : ''}</p>
            ${update.notes ? `<p class="arcUpdate-notes">${escapeHtml(update.notes)}</p>` : ''}
            <div class="arcUpdate-progress"><div></div></div>
            <p class="arcUpdate-status" aria-live="polite"></p>
            <div class="arcUpdate-actions">
                <button type="button" class="arcUpdate-button arcUpdate-later">Later</button>
                <button type="button" class="arcUpdate-button arcUpdate-install">${update.canInstall ? 'Install' : 'Download'}</button>
            </div>`;

        card.querySelector('.arcUpdate-later').addEventListener('click', () => {
            window.sessionStorage.setItem(DISMISSED_KEY, update.version);
            this.close();
        });
        card.querySelector('.arcUpdate-install').addEventListener('click', () => this.install());

        document.body.appendChild(card);
        this.card = card;
    }

    install() {
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

    onProgress(received, total) {
        if (!this.card) return;
        const bar = this.card.querySelector('.arcUpdate-progress > div');
        if (total > 0) {
            const percent = Math.round((received / total) * 100);
            bar.style.width = `${percent}%`;
            this.setStatus(`Downloading… ${percent}%`);
        }
    }

    onInstalling(version) {
        if (!this.card) return;
        this.card.querySelector('.arcUpdate-progress > div').style.width = '100%';
        this.setStatus(`Installing Arc ${version}. Arc will restart.`);
    }

    onError(message) {
        // Errors from the automatic check (no feed, offline) are only logged; an
        // error while the card is busy installing is shown with a retry.
        if (!this.card || !this.card.classList.contains('is-busy')) {
            console.warn('Arc updater:', message);
            return;
        }
        this.card.classList.remove('is-busy');
        this.card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        this.card.querySelector('.arcUpdate-install').textContent = 'Try again';
        this.setStatus(message, true);
    }

    setStatus(text, isError = false) {
        const status = this.card.querySelector('.arcUpdate-status');
        status.textContent = text;
        status.classList.toggle('is-error', isError);
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
