function cornerCutsOverlap(a, b, openingWidth, openingHeight) {
    if (!a?.corner || !b?.corner)
        return false;
    if (a.corner === b.corner)
        return true;
    const size = item => ({
        w: item.width ?? 0,
        h: (item.height ?? 0) * Math.max(0, item.progress ?? 1),
        top: (item.edge ?? item.corner.split('-')[0]) !== 'bottom',
        left: item.corner.endsWith('left'),
    });
    const first = size(a);
    const second = size(b);
    return (first.top === second.top && first.w + second.w > openingWidth)
        || (first.left === second.left && first.h + second.h > openingHeight);
}

function drawerOverlapsCorner(popup, notification, opening) {
    const sides = opening.sides ?? {left: 0, top: 0, right: 0, bottom: 0};
    const aw = popup.width ?? 0;
    const ah = (popup.height ?? 0) * Math.max(0, popup.progress ?? 1);
    const bw = notification.width ?? 0;
    const bh = (notification.height ?? 0) * Math.max(0, notification.progress ?? 1);
    const left = notification.corner?.endsWith('left');
    const bottom = notification.edge === 'bottom' || notification.corner?.startsWith('bottom');
    const bx = left ? sides.left : sides.left + opening.w - bw;
    const by = bottom ? sides.top + opening.h - bh : sides.top;
    return !(popup.x + aw <= bx || bx + bw <= popup.x || popup.y + ah <= by || by + bh <= popup.y);
}

// A joined banner is a hole in the frame. When another joined drawer already
// owns that hole, the banner must paint its own card instead.
export function notificationJoinsFrame(popup, notification, opening = null) {
    if (!popup || !notification)
        return true;
    if (popup.corner) {
        if (popup.corner === notification.corner)
            return false;
        return !(opening?.w > 0 && opening?.h > 0 && cornerCutsOverlap(popup, notification, opening.w, opening.h));
    }
    return !(opening?.w > 0 && opening?.h > 0 && drawerOverlapsCorner(popup, notification, opening));
}

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
    const addCorner = n => {
        const w = n.width + padding + (n.corner?.endsWith('left') ? sides.left : sides.right);
        const h = n.height + padding + (n.edge === 'bottom' ? sides.bottom : sides.top);
        patches.push(clip([n.corner?.endsWith('left') ? 0 : width - w, n.edge === 'bottom' ? height - h : 0, w, h]));
    };
    if (popup) {
        const p = popup;
        if (p.corner)
            addCorner(p);
        else {
            if (p.edge === 'left') patches.push(clip([0, p.y - padding, sides.left + p.width + padding, p.height + 2 * padding]));
            if (p.edge === 'right') patches.push(clip([width - sides.right - p.width - padding, p.y - padding, sides.right + p.width + padding, p.height + 2 * padding]));
            if (p.edge === 'top') patches.push(clip([p.x - padding, 0, p.width + 2 * padding, sides.top + p.height + padding]));
            if (p.edge === 'bottom') patches.push(clip([p.x - padding, height - sides.bottom - p.height - padding, p.width + 2 * padding, sides.bottom + p.height + padding]));
        }
    }
    if (notification)
        addCorner(notification);
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
