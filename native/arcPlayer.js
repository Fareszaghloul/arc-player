// Arc video player helpers.
//
// Concatenated after arcHome.js by SystemComponent::getNativeShellScript().
//
// Volume slider: arc-theme.css floats the player's volume slider on a small pill just
// above the volume icon and keeps it hidden until the volume control is "open".
// CSS :hover alone proved unreliable in Arc's embedded browser (the hover state could
// lag behind the pointer), so the control is opened from mouse movement instead, the
// same signal jellyfin-web uses to show the player controls:
//   - closed, it opens when the pointer reaches the volume icon;
//   - open, it stays open while the pointer is over the icon, the pill, or the space
//     between them (one box around both, so moving up to the pill never closes it), and
//     while the slider is being dragged.
(function() {
    const OPEN = 'arc-volume-open';
    const SLACK = 8;
    let dragging = false;

    const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };

    const union = (a, b) => (a && b) ? {
        left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)
    } : (a || b);

    const within = (r, x, y) => !!r &&
        x >= r.left - SLACK && x <= r.right + SLACK &&
        y >= r.top - SLACK && y <= r.bottom + SLACK;

    const update = (x, y) => {
        const control = document.querySelector('.videoOsdBottom .volumeButtons');
        if (!control) return;
        const isOpen = control.classList.contains(OPEN);
        const icon = box(control.querySelector('.buttonMute'));
        const slider = box(control.querySelector('.osdVolumeSliderContainer'));
        const open = dragging || within(icon, x, y) || (isOpen && within(union(icon, slider), x, y));
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
