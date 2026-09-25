// Disjoint surfaces: cache the unchanged perimeter and repaint only the drawer's
// complete swept bounds. Bounds do not grow with progress, avoiding texture
// allocation on every animation tick. All coordinates are monitor-local.
export function frameRegions(width, height, sides, padding, popup = null, notification = null) {
    const top = Math.min(height, Math.ceil(sides.top + padding));
    const bottom = Math.min(height - top, Math.ceil(sides.bottom + padding));
    const left = Math.min(width, Math.ceil(sides.left + padding));
    const right = Math.min(width - left, Math.ceil(sides.right + padding));
    let fixed = [[0, 0, width, top], [0, height - bottom, width, bottom],
        [0, top, left, height - top - bottom], [width - right, top, right, height - top - bottom]];
    const patches = [];
    const clip = ([x, y, w, h]) => {
        const x1 = Math.max(0, Math.floor(x)), y1 = Math.max(0, Math.floor(y));
        return [x1, y1, Math.max(0, Math.min(width, Math.ceil(x + w)) - x1),
            Math.max(0, Math.min(height, Math.ceil(y + h)) - y1)];
    };
    if (popup) {
        const p = popup;
        if (p.edge === 'left') patches.push(clip([0, p.y - padding, sides.left + p.width + padding, p.height + 2 * padding]));
        if (p.edge === 'right') patches.push(clip([width - sides.right - p.width - padding, p.y - padding, sides.right + p.width + padding, p.height + 2 * padding]));
        if (p.edge === 'top') patches.push(clip([p.x - padding, 0, p.width + 2 * padding, sides.top + p.height + padding]));
        if (p.edge === 'bottom') patches.push(clip([p.x - padding, height - sides.bottom - p.height - padding, p.width + 2 * padding, sides.bottom + p.height + padding]));
    }
    if (notification) {
        const n = notification;
        const w = n.width + padding + (n.corner?.endsWith('left') ? sides.left : sides.right);
        const h = n.height + padding + (n.edge === 'bottom' ? sides.bottom : sides.top);
        patches.push(clip([n.corner?.endsWith('left') ? 0 : width - w, n.edge === 'bottom' ? height - h : 0, w, h]));
    }
    // Subtract a rectangle without overlap (including transparent shadow pixels).
    const subtract = (rect, cut) => {
        const [x, y, w, h] = rect, [cx, cy, cw, ch] = cut;
        const l = Math.max(x, cx), t = Math.max(y, cy);
        const r = Math.min(x + w, cx + cw), b = Math.min(y + h, cy + ch);
        if (l >= r || t >= b) return [rect];
        return [[x, y, w, t - y], [x, b, w, y + h - b],
            [x, t, l - x, b - t], [r, t, x + w - r, b - t]];
    };
    let dynamic = [];
    for (const patch of patches) {
        fixed = fixed.flatMap(rect => subtract(rect, patch));
        dynamic = dynamic.flatMap(rect => subtract(rect, patch));
        dynamic.push(patch);
    }
    return [...fixed.map(rect => ({rect, dynamic: false})), ...dynamic.map(rect => ({rect, dynamic: true}))]
        .filter(({rect: [, , w, h]}) => w > 0 && h > 0);
}
