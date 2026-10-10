// Liquid keeps Bezel's edge attachment and shoulders. Motion is a temporary
// silhouette; the resting shape has no connector. Glass and solid motion use
// the same mask, rather than painting opaque liquid over a blurred surface.
export const unit = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export function settle(t) {
    const x = unit(t) - 1;
    return 1 + 2.35 * x ** 3 + 1.35 * x ** 2;
}
export function liquidSample(style, progress) {
    const t = unit(progress);
    if (t === 0 || t === 1) return {growth: t, drop: 0, reach: 0};
    if (style === 'unfold') return {growth: settle(t), drop: 0, reach: 0};
    if (style === 'grow') return {growth: settle(t), drop: 0, reach: 0};
    const end = style === 'drip-grow' ? 0.52 : 0.34;
    const drop = style === 'drip-grow'
        ? (t < end ? Math.sin(Math.PI * t / end) : 0)
        : t < end ? Math.sin(Math.PI * t / (end * 1.8)) : Math.max(0, 1 - (t - end) / 0.2);
    return {growth: t < end ? 0 : settle((t - end) / (1 - end)),
        drop, reach: unit(t / end)};
}
export function revealedRect(rect, progress) {
    const {x, y, width, height, edge} = rect;
    const p = Math.max(0, progress); // Retain spring overshoot.
    if (edge === 'top') return [x, y, width, height * p];
    if (edge === 'bottom') return [x, y + height * (1 - p), width, height * p];
    if (edge === 'left') return [x, y, width * p, height];
    return [x + width * (1 - p), y, width * p, height];
}

// Smooth position and size interpolation with a small elastic stretch en route.
export function shiftSample(from, to, progress, radius = 18) {
    const t = unit(progress);
    const ease = t * t * t * (t * (t * 6 - 15) + 10);
    const rect = from.map((v, i) => v + (to[i] - v) * ease);
    const dx = to[0] + to[2] / 2 - from[0] - from[2] / 2;
    const dy = to[1] + to[3] / 2 - from[1] - from[3] / 2;
    const stretch = Math.sin(Math.PI * t) ** 2 * Math.min(28, Math.hypot(dx, dy) * 0.04);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    rect[horizontal ? 0 : 1] -= stretch / 2;
    rect[horizontal ? 2 : 3] += stretch;
    return {rect, radius: Math.min(radius + stretch * 0.3, rect[2] / 2, rect[3] / 2)};
}

// Travel along the shortest route on the inside perimeter, never across the desktop.
export function frameShiftSample(from, to, progress, bounds) {
    const t = unit(progress), ease = t * t * (3 - 2 * t);
    if (t === 0) return {...from};
    if (t === 1) return {...to};
    // A shared corner is a fixed attachment, even if the drawers name
    // different edges. Interpolating their centres would leave that corner.
    if ((from.corner && from.corner === to.corner) || from.edge === to.edge) {
        const geometry = {...from, corner: from.corner === to.corner ? from.corner : false};
        for (const key of ['x', 'y', 'width', 'height'])
            geometry[key] = from[key] + (to[key] - from[key]) * ease;
        return geometry;
    }
    const {x, y, width: w, height: h} = bounds;
    const perimeter = 2 * (w + h);
    const coordinate = g => {
        const cx = g.x + g.width / 2 - x, cy = g.y + g.height / 2 - y;
        return g.edge === 'top' ? cx : g.edge === 'right' ? w + cy
            : g.edge === 'bottom' ? w + h + w - cx : perimeter - cy;
    };
    const start = coordinate(from), end = coordinate(to);
    let distance = (end - start + perimeter) % perimeter;
    if (distance > perimeter / 2) distance -= perimeter;
    const s = ((start + distance * ease) % perimeter + perimeter) % perimeter;
    const width = from.width + (to.width - from.width) * ease;
    const height = from.height + (to.height - from.height) * ease;
    const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
    let edge, px, py;
    if (s <= w) { edge = 'top'; px = x + clamp(s - width / 2, 0, w - width); py = y; }
    else if (s <= w + h) { edge = 'right'; px = x + w - width; py = y + clamp(s - w - height / 2, 0, h - height); }
    else if (s <= 2 * w + h) { edge = 'bottom'; px = x + clamp(2 * w + h - s - width / 2, 0, w - width); py = y + h - height; }
    else { edge = 'left'; px = x; py = y + clamp(perimeter - s - height / 2, 0, h - height); }
    if (t === 0) return {...from};
    if (t === 1) return {...to};
    const corner = px === x && py === y ? 'top-left'
        : px === x + w - width && py === y ? 'top-right'
            : px === x && py === y + h - height ? 'bottom-left'
                : px === x + w - width && py === y + h - height ? 'bottom-right' : false;
    return {x: px, y: py, width, height, edge, corner};
}
