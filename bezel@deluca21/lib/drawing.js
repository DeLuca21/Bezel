import Cairo from 'cairo';

// Paint the area OUTSIDE a quarter circle. GJS Cairo uses camelCase methods,
// unlike Python Cairo; keep this shared with the actual Cairo regression test.
export function paintCorner(cr, width, height, color, corner) {
    const centers = {br: [1, 1], bl: [0, 1], tr: [1, 0], tl: [0, 0]};
    const [cx, cy] = centers[corner];
    const hex = color.slice(1);
    cr.save();
    cr.scale(width, height);
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    cr.rectangle(0, 0, 1, 1);
    cr.newSubPath();
    cr.arc(cx, cy, 1, 0, Math.PI * 2);
    cr.setSourceRGBA(parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1);
    cr.fill();
    cr.restore();
}

function source(cr, hex, alpha = 1) {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], alpha);
}

// The desktop opening is one path. A drawer is an indentation in that path,
// not a second rounded rectangle placed over it. Thus joins and shadows match.
export function openingPath(cr, width, height, sides, radius, popup = null, notification = null) {
    // Mirror the corner path so every anchored corner reuses the top-right cut.
    if (notification?.corner === 'bottom-left') {
        cr.save();
        cr.translate(0, height);
        cr.scale(1, -1);
        openingPath(cr, width, height, {...sides, top: sides.bottom, bottom: sides.top}, radius, popup ? {...popup, y: height - popup.y - popup.height,
                edge: ({top: 'bottom', bottom: 'top'})[popup.edge] ?? popup.edge} : null,
            {...notification, corner: 'top-left', edge: 'top'});
        cr.restore();
        return;
    }
    if (notification?.corner === 'top-left' || notification?.corner === 'bottom-right') {
        cr.save();
        cr.translate(width, 0);
        cr.scale(-1, 1);
        openingPath(cr, width, height, {...sides, left: sides.right, right: sides.left}, radius, popup ? {...popup, x: width - popup.x - popup.width,
                edge: ({left: 'right', right: 'left'})[popup.edge] ?? popup.edge} : null,
            {...notification, corner: notification.corner === 'top-left' ? 'top-right' : 'bottom-left'});
        cr.restore();
        return;
    }
    const x = sides.left;
    const y = sides.top;
    const w = Math.max(1, width - x - sides.right);
    const h = Math.max(1, height - y - sides.bottom);
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    const corner = notification?.progress > 0 ? {
        width: Math.min(w - r * 2, notification.width),
        depth: Math.min(h - r * 2, notification.height * notification.progress),
    } : null;
    cr.newPath();
    cr.moveTo(x + r, y);
    const edges = [
        ['top', x, y, 0, w], ['right', x + w, y, Math.PI / 2, h],
        ['bottom', x + w, y + h, Math.PI, w], ['left', x, y + h, Math.PI * 1.5, h],
    ];
    for (const [edge, ox, oy, rotation, length] of edges) {
        cr.save();
        cr.translate(ox, oy);
        cr.rotate(rotation);
        if (popup?.edge === edge && popup.progress > 0) {
            const horizontal = edge === 'top' || edge === 'bottom';
            const span = horizontal ? popup.width : popup.height;
            const start = edge === 'top' ? popup.x - x : edge === 'right' ? popup.y - y
                : edge === 'bottom' ? x + w - popup.x - span : y + h - popup.y - span;
            const depth = (horizontal ? popup.height : popup.width) * popup.progress;
            const joinStart = Math.max(0, Math.min(r, depth / 2, start - r));
            const joinEnd = Math.max(0, Math.min(r, depth / 2, length - r - start - span));
            const round = Math.min(r, depth / 2, span / 2);
            cr.lineTo(start - joinStart, 0);
            if (joinStart > 0)
                cr.arc(start - joinStart, joinStart, joinStart, -Math.PI / 2, 0);
            cr.lineTo(start, depth - round);
            if (round > 0)
                cr.arcNegative(start + round, depth - round, round, Math.PI, Math.PI / 2);
            cr.lineTo(start + span - round, depth);
            if (round > 0)
                cr.arcNegative(start + span - round, depth - round, round, Math.PI / 2, 0);
            cr.lineTo(start + span, joinEnd);
            if (joinEnd > 0)
                cr.arc(start + span + joinEnd, joinEnd, joinEnd, Math.PI, Math.PI * 1.5);
        }
        if (edge === (notification?.edge === 'bottom' ? 'bottom' : 'top') && corner) {
            const start = w - corner.width;
            const round = Math.min(r, corner.depth / 2, corner.width / 2);
            cr.lineTo(start - round, 0);
            cr.arc(start - round, round, round, -Math.PI / 2, 0);
            cr.lineTo(start, corner.depth - round);
            cr.arcNegative(start + round, corner.depth - round, round, Math.PI, Math.PI / 2);
            cr.lineTo(w - r, corner.depth);
            cr.arc(w - r, corner.depth + r, r, -Math.PI / 2, 0);
            cr.restore();
            continue;
        }
        cr.lineTo(length - r, 0);
        if (r > 0)
            cr.arc(length - r, r, r, -Math.PI / 2, 0);
        cr.restore();
    }
    cr.closePath();
}

function roundedRect(cr, x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

// Use the frame's concentric, low-opacity strokes, clipped outside the fill.
export function paintPillBackdrop(cr, rect, radius, color, opacity, shadow) {
    const depth = Math.max(0, Number(shadow) || 0);
    if (depth > 0 && opacity > 0) {
        cr.save();
        cr.newPath();
        cr.rectangle(rect.x - depth - 1, rect.y - depth - 1,
            rect.w + depth * 2 + 2, rect.h + depth * 2 + 2);
        roundedRect(cr, rect.x, rect.y, rect.w, rect.h, radius);
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.clip();
        for (let i = depth; i >= 1; i--) {
            roundedRect(cr, rect.x, rect.y, rect.w, rect.h, radius);
            cr.setLineWidth(i * 2);
            cr.setSourceRGBA(0, 0, 0, 0.035 * (1 - i / (depth + 1)) * opacity);
            cr.stroke();
        }
        cr.restore();
    }
    const hex = `${color}`.replace('#', '');
    const rgb = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
    roundedRect(cr, rect.x, rect.y, rect.w, rect.h, radius);
    cr.setSourceRGBA(rgb[0] || 0, rgb[1] || 0, rgb[2] || 0, opacity);
    cr.fill();
}

export function paintFrame(cr, width, height, sides, radius, color, shadow, popup = null, notification = null, alpha = 1) {
    const coverage = Math.max(0, Math.min(1, Number(alpha) || 0));
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);
    openingPath(cr, width, height, sides, radius, popup, notification);
    const opening = cr.copyPath();
    cr.newPath();
    cr.rectangle(0, 0, width, height);
    cr.appendPath(opening);
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    source(cr, color, coverage);
    cr.fill();
    if (shadow > 0 && coverage > 0) {
        cr.save();
        cr.appendPath(opening);
        cr.clip();
        for (let i = shadow; i >= 1; i--) {
            cr.appendPath(opening);
            cr.setLineWidth(i * 2);
            cr.setSourceRGBA(0, 0, 0, 0.035 * (1 - i / (shadow + 1)) * coverage);
            cr.stroke();
        }
        cr.restore();
    }
}
