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

// Cells stay the size of their content. `before` and `after` are the empty
// gaps that keep the center on the bar midpoint, then in the free space
// between the ends once an end is too long for that midpoint.
export function zonePlacement(available, natural) {
    const total = Math.max(0, available);
    let [start, center, end] = natural.map(n => Math.max(0, n));
    const packed = start + center + end;
    if (packed > total && packed > 0) {
        const fixed = center + Math.min(start, end);
        if (fixed >= total) {
            const scale = total / packed;
            start *= scale;
            center *= scale;
            end *= scale;
        } else if (start >= end)
            start = total - center - end;
        else
            end = total - center - start;
        return {sizes: [start, center, end], before: 0, after: 0};
    }
    const midpoint = (total - center) / 2;
    if (midpoint >= start && midpoint + center <= total - end) {
        return {
            sizes: [start, center, end],
            before: midpoint - start,
            after: total - end - midpoint - center,
        };
    }
    const free = Math.max(0, total - packed);
    return {sizes: [start, center, end], before: free / 2, after: free / 2};
}

export function horizontalZoneWidths(available, natural) {
    const {sizes, before, after} = zonePlacement(available, natural);
    return [sizes[0] + before, sizes[1], sizes[2] + after];
}
