import Cairo from 'cairo';
import {notificationJoinsFrame} from './frame-regions.js';

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

function openingPathCuts(cr, width, height, sides, radius, items) {
    const x = sides.left;
    const y = sides.top;
    const w = Math.max(1, width - x - sides.right);
    const h = Math.max(1, height - y - sides.bottom);
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    const cuts = {};
    for (const item of items) {
        if (!item?.corner || !(item.progress > 0))
            continue;
        cuts[item.corner] = {
            width: Math.min(w - r * 2, item.width),
            depth: Math.min(h - r * 2, item.height * item.progress),
        };
    }
    const edges = [
        {ox: x, oy: y, rotation: 0, length: w, start: 'top-left', end: 'top-right', mx: x + r, my: y},
        {ox: x + w, oy: y, rotation: Math.PI / 2, length: h, start: 'top-right', end: 'bottom-right', mx: x + w, my: y + r},
        {ox: x + w, oy: y + h, rotation: Math.PI, length: w, start: 'bottom-right', end: 'bottom-left', mx: x + w - r, my: y + h},
        {ox: x, oy: y + h, rotation: Math.PI * 1.5, length: h, start: 'bottom-left', end: 'top-left', mx: x, my: y + h - r},
    ];
    let offset = 0;
    for (let i = 0; i < 4; i++) {
        if (!cuts[edges[i].start]) {
            offset = i;
            break;
        }
    }
    cr.newPath();
    cr.moveTo(edges[offset].mx, edges[offset].my);
    for (let n = 0; n < 4; n++) {
        const {ox, oy, rotation, length, end} = edges[(offset + n) % 4];
        const horizontal = end === 'top-right' || end === 'bottom-left';
        const cut = cuts[end];
        cr.save();
        cr.translate(ox, oy);
        cr.rotate(rotation);
        if (cut) {
            const span = horizontal ? cut.width : cut.depth;
            const inset = horizontal ? cut.depth : cut.width;
            const start = length - span;
            const round = Math.min(r, inset / 2, span / 2);
            cr.lineTo(start - round, 0);
            if (round > 0)
                cr.arc(start - round, round, round, -Math.PI / 2, 0);
            cr.lineTo(start, inset - round);
            if (round > 0)
                cr.arcNegative(start + round, inset - round, round, Math.PI, Math.PI / 2);
            cr.lineTo(length - r, inset);
            if (r > 0)
                cr.arc(length - r, inset + r, r, -Math.PI / 2, 0);
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

// The desktop opening is one path. A drawer is an indentation in that path,
// not a second rounded rectangle placed over it. Thus joins and shadows match.
export function openingPath(cr, width, height, sides, radius, popup = null, notification = null) {
    const drawer = popup && !popup.corner ? popup : null;
    const extra = popup?.corner ? popup : null;
    const openingWidth = Math.max(1, width - sides.left - sides.right);
    const openingHeight = Math.max(1, height - sides.top - sides.bottom);
    const banner = notification && !notificationJoinsFrame(popup, notification, {w: openingWidth, h: openingHeight, sides})
        ? null : notification;
    if (extra?.progress > 0 && banner?.corner && banner.progress > 0) {
        openingPathCuts(cr, width, height, sides, radius, [extra, banner]);
        return;
    }
    openingPathSingle(cr, width, height, sides, radius, drawer, extra ?? banner);
}

function openingPathSingle(cr, width, height, sides, radius, popup, notification) {
    // Mirror the corner path so every anchored corner reuses the top-right cut.
    if (notification?.corner === 'bottom-left') {
        cr.save();
        cr.translate(0, height);
        cr.scale(1, -1);
        openingPathSingle(cr, width, height, {...sides, top: sides.bottom, bottom: sides.top}, radius, popup ? {...popup, y: height - popup.y - popup.height,
                edge: ({top: 'bottom', bottom: 'top'})[popup.edge] ?? popup.edge} : null,
            {...notification, corner: 'top-left', edge: 'top'});
        cr.restore();
        return;
    }
    if (notification?.corner === 'top-left' || notification?.corner === 'bottom-right') {
        cr.save();
        cr.translate(width, 0);
        cr.scale(-1, 1);
        openingPathSingle(cr, width, height, {...sides, left: sides.right, right: sides.left}, radius, popup ? {...popup, x: width - popup.x - popup.width,
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
    if (!color) return;
    const hex = `${color}`.replace('#', '');
    const rgb = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
    roundedRect(cr, rect.x, rect.y, rect.w, rect.h, radius);
    cr.setSourceRGBA(rgb[0] || 0, rgb[1] || 0, rgb[2] || 0, opacity);
    cr.fill();
}

// Round the advancing ends, with enough overdraw to settle the screen corners
// continuously before handing back to the static frame.
function edgeClip(cr, width, height, motion, shadow) {
    cr.newPath();
    cr.setFillRule(Cairo.FillRule.WINDING);
    for (const [edge, growth] of Object.entries(motion.edges)) {
        if (growth <= 0) continue;
        const vertical = edge === 'left' || edge === 'right';
        const length = vertical ? height : width;
        const thickness = Math.min(vertical ? width : height,
            Math.max(0, motion.sides[edge] + motion.radius + shadow));
        if (thickness === 0) continue;
        const span = (length + 2 * thickness) * growth;
        const x = vertical ? (edge === 'left' ? -thickness : width - thickness) : (width - span) / 2;
        const y = vertical ? (height - span) / 2 : (edge === 'top' ? -thickness : height - thickness);
        const w = vertical ? thickness * 2 : span;
        const h = vertical ? span : thickness * 2;
        const r = Math.min(thickness, w / 2, h / 2);
        cr.newSubPath();
        cr.moveTo(x + r, y);
        cr.lineTo(x + w - r, y); cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.lineTo(x + w, y + h - r); cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.lineTo(x + r, y + h); cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(x, y + r); cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
        cr.closePath();
    }
    cr.clip();
}

export function paintLoginFrame(cr, width, height, motion, color, shadow, popup = null, notification = null) {
    if (motion.solid) {
        cr.setOperator(Cairo.Operator.SOURCE);
        source(cr, color);
        cr.paint();
    } else if (motion.edges) {
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        cr.save();
        if (Object.values(motion.edges).some(growth => growth < 1))
            edgeClip(cr, width, height, motion, shadow);
        // Paint only the configured frame. The desktop opening stays fixed,
        // while a soft front carries the frame outwards from each edge centre.
        openingPath(cr, width, height, motion.sides, motion.radius, popup, notification);
        paintOutside(cr, width, height, cr.copyPath(), color, shadow * motion.shadow);
        cr.restore();
    } else {
        paintFrame(cr, width, height, motion.sides, motion.radius, color, shadow * motion.shadow, popup, notification);
    }
}

function paintOutside(cr, width, height, opening, color, shadow, coverage = 1) {
    cr.newPath();
    cr.rectangle(0, 0, width, height);
    cr.appendPath(opening);
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    if (color) { source(cr, color, coverage); cr.fill(); }
    else cr.newPath();
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

export function paintFrame(cr, width, height, sides, radius, color, shadow, popup = null, notification = null, alpha = 1) {
    const coverage = Math.max(0, Math.min(1, Number(alpha) || 0));
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);
    openingPath(cr, width, height, sides, radius, popup, notification);
    paintOutside(cr, width, height, cr.copyPath(), color, shadow, coverage);
}

// Shadows are independent of surface fill, so glass never needs a Cairo slab.
export function paintFrameShadow(cr, width, height, sides, radius, shadow, popup = null, notification = null) {
    cr.setOperator(Cairo.Operator.CLEAR); cr.paint();
    cr.setOperator(Cairo.Operator.OVER);
    openingPath(cr, width, height, sides, radius, popup, notification);
    paintOutside(cr, width, height, cr.copyPath(), null, shadow);
}
