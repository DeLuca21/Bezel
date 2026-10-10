// Adapted from https://github.com/knespii/atelier lib/liquid.js, GPL-2.0.
// Upstream revision cee80e9c58c9b70b03ee6720337be3198331098a; see docs/atelier-LICENSE.
// Shapes of liquid, as cards turn into it and back: a card pouring over to
// another place, one drawing into its middle (or spreading out of it), and
// a panel flowing out of a bar. Each is a few rounded boxes and capsules,
// which a shader melts together where they come near each other. Pure
// functions of how far along they are, shared by the shell and the tests.
//
// A box: [centerX, centerY, halfWidth, halfHeight, radius, blend]; a
// capsule: [ax, ay, bx, by, radius, blend]. Blend is how near (in pixels) it
// melts into what is drawn before it; 0 keeps it apart.

export const clamp01 = t => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
// Part of the way between two points of the way, 0 to 1.
const between = (t, from, to) => clamp01((t - from) / (to - from));
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = t => 1 - (1 - t) ** 3;

/**
 * @param {number[]} rect - [x, y, width, height]
 * @param {number} radius - of its corners
 * @param {number} [blend]
 * @returns {number[]} the box it is
 */
export function boxOf([x, y, width, height], radius, blend = 0) {
    return [x + width / 2, y + height / 2, width / 2, height / 2, Math.min(radius, width / 2, height / 2), blend];
}

// (Nothing of it left: not drawn, nor melting into anything.)
const shown = ([, , a, b, radius]) => a > 0.25 && b > 0.25 && radius >= 0;

/**
 * A card pouring over to another place: it drains away towards it in a
 * stream, which fills the card there.
 *
 * @param {number[]} from - [x, y, width, height]
 * @param {number[]} to - [x, y, width, height]
 * @param {number} t - 0 (the card where it was) to 1 (where it goes)
 * @param {object} look - {radius, blend}: of the cards' corners, and how
 *   near the liquid melts
 * @returns {object} {boxes, capsules}
 */
export function pour(from, to, t, {radius, blend}) {
    if (t >= 1)
        return {boxes: [boxOf(to, radius)], capsules: []};
    const [fx, fy] = [from[0] + from[2] / 2, from[1] + from[3] / 2];
    const [tx, ty] = [to[0] + to[2] / 2, to[1] + to[3] / 2];
    // (As it settles, it stops melting into what is near.)
    const k = blend * (1 - between(t, 0.85, 1));
    // Where it was: round, and running out towards where it goes.
    const drain = easeInOut(between(t, 0.12, 0.62));
    const source = [
        lerp(fx, tx, 0.22 * drain), lerp(fy, ty, 0.22 * drain),
        from[2] / 2 * (1 - drain) ** 0.85, from[3] / 2 * (1 - drain) ** 1.15,
    ];
    source.push(Math.min(lerp(radius, Math.min(source[2], source[3]), drain), source[2], source[3]), k);
    // On its way: a stream, a drop at its front, its end behind.
    const head = easeInOut(between(t, 0.14, 0.5));
    const tail = easeInOut(between(t, 0.5, 0.9));
    const base = Math.min(from[2], from[3], to[2], to[3]);
    const thick = base * 0.1 * Math.sin(Math.PI * between(t, 0.12, 0.92));
    const stream = [lerp(fx, tx, tail), lerp(fy, ty, tail), lerp(fx, tx, head), lerp(fy, ty, head), thick, k];
    const front = base * 0.17 * Math.sin(Math.PI * between(t, 0.12, 0.7));
    const drop = [stream[2], stream[3], front, front, front, k];
    // Where it goes: filling up, from the side it comes from.
    const fill = easeOut(between(t, 0.42, 1));
    const target = [
        lerp(tx, fx, 0.22 * (1 - fill)), lerp(ty, fy, 0.22 * (1 - fill)),
        to[2] / 2 * fill ** 0.85, to[3] / 2 * fill ** 1.15,
    ];
    target.push(Math.min(lerp(Math.min(target[2], target[3]), radius, fill), target[2], target[3]), k);
    return {
        boxes: [source, drop, target].filter(shown),
        capsules: thick > 0.25 ? [stream] : [],
    };
}

/**
 * A card drawing into its middle: it rounds up as it goes, into a drop
 * that is gone.
 *
 * @param {number[]} rect - [x, y, width, height]
 * @param {number} t - 0 (the card) to 1 (gone)
 * @param {object} look - {radius}
 * @returns {object} {boxes, capsules}
 */
export function gather(rect, t, {radius}) {
    if (t <= 0)
        return {boxes: [boxOf(rect, radius)], capsules: []};
    const [x, y, width, height] = rect;
    // Round: as big as the card, more or less.
    const round = Math.sqrt(width * height) / 2;
    const rounding = easeInOut(between(t, 0, 0.7));
    // (The longer side first, and a little wobble, as liquid would.)
    const size = easeInOut(t);
    const wobble = 1 + 0.06 * Math.sin(Math.PI * 2 * t) * (1 - t);
    const box = [
        x + width / 2, y + height / 2,
        lerp(width / 2, round, rounding) * (1 - size) * wobble,
        lerp(height / 2, round, rounding) * (1 - size) / wobble,
    ];
    box.push(Math.min(lerp(radius, Math.min(box[2], box[3]), rounding), box[2], box[3]), 0);
    return {boxes: [box].filter(shown), capsules: []};
}

/**
 * A card spreading out of its middle: a drop there, swelling into it.
 *
 * @param {number[]} rect - [x, y, width, height]
 * @param {number} t - 0 (nothing) to 1 (the card)
 * @param {object} look - {radius}
 * @returns {object} {boxes, capsules}
 */
export function spread(rect, t, look) {
    return gather(rect, 1 - easeOut(clamp01(t)) ** 0.8, look);
}

/**
 * A panel flowing out of a bar, at a point of the bar's top edge: the bar
 * swells there into a drop, which rises on a neck, lets go and spreads
 * into the panel (above the bar, apart from it).
 *
 * @param {number[]} bar - [x, y, width, height]
 * @param {number} barRadius
 * @param {number[]} panel - [x, y, width, height]
 * @param {number} panelRadius
 * @param {number} originX - where on the bar's top edge
 * @param {number} t - 0 (only the bar) to 1 (the panel)
 * @param {object} look - {drop, blend}: the drop's radius, and how near
 *   the liquid melts
 * @returns {object} {boxes, capsules}; the bar is the first box
 */
export function overflow(bar, barRadius, panel, panelRadius, originX, t, {drop, blend}) {
    const boxes = [boxOf(bar, barRadius)];
    if (t <= 0)
        return {boxes, capsules: []};
    const top = bar[1];
    const [px, py, pw, ph] = panel;
    // (Apart once it has spread: the panel doesn't melt into the bar.)
    const k = blend * (1 - between(t, 0.6, 0.85));
    const swell = easeOut(between(t, 0, 0.3));
    const rise = easeInOut(between(t, 0.2, 0.5));
    const open = easeOut(between(t, 0.42, 1));
    const r = drop * swell;
    const low = top - r * 0.4;
    const high = py + ph - drop;
    const x = lerp(originX, px + pw / 2, open);
    const y = lerp(lerp(low, high, rise), py + ph / 2, open);
    const box = [x, y, lerp(r, pw / 2, open ** 0.9), lerp(r, ph / 2, open)];
    box.push(Math.min(lerp(r, panelRadius, open), box[2], box[3]), k);
    if (shown(box))
        boxes.push(box);
    // The neck it hangs on, thinning until it lets go.
    const neck = r * 0.55 * (1 - between(t, 0.38, 0.6));
    const capsules = neck > 0.25 ? [[originX, top, originX, lerp(low, high, rise), neck, k]] : [];
    return {boxes, capsules};
}
