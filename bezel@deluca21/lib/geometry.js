export function sideWidths(state) {
    const band = state.border ? state.borderWidth : 0;
    const side = {left: band, right: band, top: band, bottom: band};
    for (const bar of state.bars) {
        if (!bar.autohide && bar.kind !== 'dock' && !bar.margin && (bar.length ?? 100) === 100)
            side[bar.edge] = Math.max(side[bar.edge], bar.thickness);
    }
    return side;
}

export function reservedWidths(state) {
    const reserved = state.bars.filter(bar => bar.reserveSpace);
    const gap = reserved.length ? Math.max(...reserved.map(bar => bar.reserveOffset)) : 0;
    const band = state.border && reserved.length ? state.borderWidth + gap : 0;
    const side = {left: band, right: band, top: band, bottom: band};
    for (const bar of reserved) {
        if (!bar.autohide)
            side[bar.edge] = Math.max(side[bar.edge], bar.thickness + bar.reserveOffset + (bar.margin ?? 0));
    }
    return side;
}

export function cornerRadius(width, height, side, radius) {
    return Math.max(0, Math.min(radius,
        (width - side.left - side.right) / 2,
        (height - side.top - side.bottom) / 2));
}

// Keep the center on the bar midpoint while it still fits. Once the center
// would crowd an end, it takes the gap between the two ends and stops there.
export function horizontalZoneWidths(available, natural) {
    const total = Math.max(0, available);
    const [start, center, end] = natural.map(n => Math.max(0, n));
    if (2 * Math.max(start, end) + center <= total)
        return [(total - center) / 2, center, (total - center) / 2];
    if (start + end <= total)
        return [start, total - start - end, end];
    const floor = center > 0 ? Math.min(center, total * 0.34) : 0;
    const room = Math.max(0, total - floor);
    const ends = start + end || 1;
    const startWidth = room * (start / ends);
    return [startWidth, total - startWidth - (room - startWidth), room - startWidth];
}
