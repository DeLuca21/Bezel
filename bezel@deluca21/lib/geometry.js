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

// Keep the visual menu on the pointer and leave room for its shadow so it
// never sits flush against a monitor or drawer edge.
export const FILE_TILE_GAP = 14;
export const FILE_TILE_ICON = 48;
export const FILE_TILE_NAME = 72;
export const FILE_TILE_MAX = 96;
export const FILE_LIST_ICON = 28;
export const FILE_LIST_GAP = 6;
export const FILE_LIST_GUTTER = 18;
export const FILE_LIST_MAX = 260;
const FILE_TILE_SLOT = 108;

export function fileGridColumns(width, maxColumns) {
    return Math.max(1, Math.min(maxColumns, Math.floor((Math.max(0, width) + FILE_TILE_GAP) / FILE_TILE_SLOT)));
}

export function fileGridTileWidth(width, columns) {
    const count = Math.max(1, columns);
    const room = Math.max(0, width - (count - 1) * FILE_TILE_GAP);
    return Math.max(1, Math.min(FILE_TILE_MAX, Math.floor(room / count)));
}

export function fileGridInset(width, columns, tileWidth) {
    const count = Math.max(1, columns);
    const used = count * tileWidth + (count - 1) * FILE_TILE_GAP;
    return Math.max(0, Math.floor((Math.max(0, width) - used) / 2));
}

export function fileListTileWidth(width) {
    const room = Math.max(0, Math.floor(width) - FILE_LIST_GUTTER * 2);
    return Math.max(140, Math.min(FILE_LIST_MAX, room));
}

export function fileListInset(_width, _tileWidth) {
    return FILE_LIST_GUTTER;
}

export function menuPosition(monitor, x, y, width, height, pad = 14) {
    const left = Math.max(monitor.x + 4, Math.min(Math.round(x - pad), monitor.x + monitor.width - width - pad * 2 - 4));
    const top = Math.max(monitor.y + 4, Math.min(Math.round(y - pad), monitor.y + monitor.height - height - pad * 2 - 4));
    return [left, top];
}
