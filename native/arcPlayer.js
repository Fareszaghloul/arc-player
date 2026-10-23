// Arc video player helpers.
//
// Concatenated after arcHome.js by SystemComponent::getNativeShellScript().
//
// Volume slider: arc-theme.css reserves room for the player's volume slider to the
// right of the volume icon and keeps it hidden until the volume control is "open".
// CSS :hover alone proved unreliable in Arc's embedded browser (the hover state could
// lag behind the pointer), so the control is opened from mouse movement instead, the
// same signal jellyfin-web uses to show the player controls:
//   - closed, it opens when the pointer reaches the volume icon (not the empty space
//     reserved for the slider);
//   - open, it stays open while the pointer is over the icon or the slider, and while
//     the slider is being dragged.
(function() {
    const OPEN = 'arc-volume-open';
    const SLACK = 8;
    let dragging = false;

    const within = (el, x, y) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 &&
            x >= r.left - SLACK && x <= r.right + SLACK &&
            y >= r.top - SLACK && y <= r.bottom + SLACK;
    };

    const update = (x, y) => {
        const control = document.querySelector('.videoOsdBottom .volumeButtons');
        if (!control) return;
        const isOpen = control.classList.contains(OPEN);
        const icon = control.querySelector('.buttonMute');
        const slider = control.querySelector('.osdVolumeSliderContainer');
        const open = dragging || within(icon, x, y) || (isOpen && within(slider, x, y));
        if (open !== isOpen) control.classList.toggle(OPEN, open);
    };

    document.addEventListener('mousemove', (e) => update(e.clientX, e.clientY), { capture: true, passive: true });

    document.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.videoOsdBottom .osdVolumeSliderContainer')) dragging = true;
    }, true);
    document.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        update(e.clientX, e.clientY);
    }, true);
})();
