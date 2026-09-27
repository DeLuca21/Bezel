const spanOf = item => {
    const value = Number(item?.span ?? item?.size);
    if (value === 4 || value === 3 || value === 2)
        return value;
    return 1;
};

export {spanOf};

export function packRows(items) {
    const rows = [];
    let row = [];
    let used = 0;
    const flush = () => {
        if (row.length)
            rows.push(row);
        row = [];
        used = 0;
    };
    for (const item of items) {
        if (!item || typeof item !== 'object')
            continue;
        const take = spanOf(item);
        if (item.ownRow || (used && used + take > 3))
            flush();
        row.push(item);
        used += take;
        if (item.ownRow || used >= 3)
            flush();
    }
    flush();
    return rows;
}

export function cloneRows(rows) {
    return rows.map(row => row.map(cell => ({...cell})));
}

export function removeCard(rows, id) {
    return rows
        .map(row => row.filter(cell => cell.id !== id))
        .filter(row => row.length);
}

export function pageColumns(rows) {
    const used = rows.reduce((max, row) => Math.max(max, row.reduce((sum, cell) => sum + spanOf(cell), 0)), 1);
    return Math.max(1, Math.min(8, used));
}

export function cellWidths(inner, row, gap) {
    const total = Math.max(1, row.reduce((sum, cell) => sum + spanOf(cell), 0));
    const room = Math.max(1, inner - Math.max(0, row.length - 1) * gap);
    const widths = row.map(cell => Math.round(room * spanOf(cell) / total));
    const drift = room - widths.reduce((sum, value) => sum + value, 0);
    if (widths.length)
        widths[widths.length - 1] += drift;
    return widths.map(value => Math.max(1, value));
}

export function shareLabel(row, cell) {
    const total = Math.max(1, row.reduce((sum, item) => sum + spanOf(item), 0));
    const span = spanOf(cell);
    if (span >= total)
        return 'Full';
    if (total % span === 0) {
        const parts = total / span;
        if (parts === 2)
            return 'Half';
        if (parts === 3)
            return 'Third';
        if (parts === 4)
            return 'Quarter';
    }
    return `${span}/${total}`;
}

// fraction is the card's share of the row width, from the resize drag.
export function applyWidth(row, index, fraction) {
    const cell = row[index];
    if (!cell || cell.gap)
        return row.map(item => ({...item}));
    const f = Math.max(0.2, Math.min(0.98, fraction));
    const others = row.filter((_, i) => i !== index);
    const otherSpan = others.reduce((sum, item) => sum + spanOf(item), 0);
    const onlyGaps = others.every(item => item.gap);
    if (otherSpan === 0 || (onlyGaps && f > 0.88)) {
        const fit = fitAlone(f);
        const next = [{...cell, span: fit.span}];
        if (fit.trailingGap > 0)
            next.push({gap: true, span: fit.trailingGap});
        return next;
    }
    const span = Math.max(1, Math.min(4, Math.round((f * otherSpan) / Math.max(0.12, 1 - f))));
    const next = row.map(item => ({...item}));
    next[index] = {...cell, span};
    return next;
}

function fitAlone(fraction) {
    if (fraction > 0.88)
        return {span: 1, trailingGap: 0};
    if (fraction > 0.7)
        return {span: 3, trailingGap: 1};
    if (fraction > 0.58)
        return {span: 2, trailingGap: 1};
    if (fraction > 0.4)
        return {span: 1, trailingGap: 1};
    if (fraction > 0.28)
        return {span: 1, trailingGap: 2};
    return {span: 1, trailingGap: 3};
}

// bands are the rows on screen, with the dragged card already removed.
export function dropTarget(bands, x, y) {
    if (!bands.length)
        return {row: 0, index: 0, insertRow: true};
    let rowIndex = 0;
    let best = Infinity;
    bands.forEach((band, index) => {
        const mid = band.y + band.h / 2;
        const distance = Math.abs(y - mid);
        if (distance < best) {
            best = distance;
            rowIndex = index;
        }
    });
    const band = bands[rowIndex];
    const edge = Math.min(28, Math.max(12, band.h * 0.28));
    if (y < band.y + edge)
        return {row: rowIndex, index: 0, insertRow: true};
    if (y > band.y + band.h - edge)
        return {row: rowIndex + 1, index: 0, insertRow: true};
    let index = band.cells.length;
    let replaceGap = false;
    for (let i = 0; i < band.cells.length; i++) {
        const cell = band.cells[i];
        if (x < cell.x + cell.w / 2) {
            index = i;
            replaceGap = Boolean(cell.gap) && x >= cell.x && x <= cell.x + cell.w;
            break;
        }
    }
    return {row: rowIndex, index, insertRow: false, replaceGap};
}

export function findCard(rows, id) {
    for (let row = 0; row < rows.length; row++) {
        const index = rows[row].findIndex(cell => cell.id === id);
        if (index >= 0)
            return {row, index};
    }
    return null;
}

// slot indexes the rows as they are now, including the dragged card.
export function moveCard(rows, id, slot) {
    const from = findCard(rows, id);
    if (!from)
        return cloneRows(rows);
    const card = {...rows[from.row][from.index]};
    if (!slot.insertRow && !slot.replaceGap && slot.row === from.row
        && (slot.index === from.index || slot.index === from.index + 1))
        return cloneRows(rows);
    const next = cloneRows(rows);
    next[from.row].splice(from.index, 1);
    if (slot.insertRow) {
        let insertAt = slot.row;
        const kept = [];
        next.forEach((row, index) => {
            if (!row.length) {
                if (index < slot.row)
                    insertAt -= 1;
                return;
            }
            kept.push(row);
        });
        kept.splice(Math.max(0, Math.min(insertAt, kept.length)), 0, [card]);
        return kept;
    }
    let row = slot.row;
    let index = slot.index;
    if (from.row === row && index > from.index)
        index -= 1;
    const sourceEmpty = next[from.row].length === 0;
    if (sourceEmpty && row > from.row)
        row -= 1;
    if (sourceEmpty)
        next.splice(from.row, 1);
    const target = next[row] ?? [];
    next[row] = target;
    if (slot.replaceGap && target[index]?.gap)
        target[index] = {...card, span: spanOf(target[index])};
    else
        target.splice(Math.max(0, Math.min(index, target.length)), 0, card);
    return next.filter(row => row.length);
}
