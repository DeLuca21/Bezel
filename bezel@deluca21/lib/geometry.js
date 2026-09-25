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

// Keep the center on the bar midpoint when possible, but never strand usable
// space in empty zones while a populated zone is clipped.
export function horizontalZoneWidths(available, natural) {
    const total = Math.max(0, available);
    const [start, center, end] = natural.map(n => Math.max(0, n));
    if (2 * Math.max(start, end) + center <= total)
        return [(total - center) / 2, center, (total - center) / 2];
    const spare = total - start - center - end;
    if (spare >= 0) return [start + spare / 2, center, end + spare / 2];
    const needs = [start, center, end];
    const widths = needs.map(n => Math.min(n, total / 3));
    let remaining = total - widths.reduce((a, b) => a + b, 0);
    for (let pass = 0; pass < 3 && remaining > 0.01; pass++) {
        const hungry = needs.map((n, i) => n > widths[i] + 0.01 ? i : -1).filter(i => i >= 0);
        if (!hungry.length) break;
        const share = remaining / hungry.length;
        for (const i of hungry) {
            const extra = Math.min(share, needs[i] - widths[i]);
            widths[i] += extra;
            remaining -= extra;
        }
    }
    return widths;
}
