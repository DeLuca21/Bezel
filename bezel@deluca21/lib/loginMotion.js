// Keep stored IDs stable so existing preferences and saved layouts still work.
export const LOGIN_THEMES = [
    ['liquid', 'Edge Bloom', 'Frame and bars grow from their centres, followed by a wave of icons.'],
    ['curtain', 'Split Reveal', 'The desktop opens from the centre towards the left and right edges.'],
    ['cascade', 'Top-down Sweep', 'The desktop opens from top to bottom as each edge arrives in turn.'],
    ['fade', 'Desktop Fade', 'A cover in the frame colour fades away to reveal the desktop and bars.'],
    ['glide', 'Edge Glide', 'Bars settle gently towards their edges while the frame fades in.'],
    ['soft-fade', 'Soft Fade', 'Frame and bars fade into place without movement or a desktop cover.'],
];
export const LIQUID_DURATION = 1100;
export const THEME_DURATIONS = {liquid: LIQUID_DURATION, curtain: 1150, cascade: 1350, fade: 850, glide: 900, 'soft-fade': 700};

const smooth = value => {
    const t = Math.max(0, Math.min(1, value));
    if (t >= 1 - 1e-9) return 1;
    return Math.max(0, Math.min(1, t * t * t * (t * (t * 6 - 15) + 10)));
};

// Start and settle at rest, with most growth early in the gesture.
const spread = value => 1 - (1 - smooth(value)) ** 2;

const EDGE_DELAYS = {left: 0, top: 0.015, right: 0.025, bottom: 0.04};
const liquidGrowth = (progress, edge) => spread((progress - EDGE_DELAYS[edge]) / 0.62);

export function openingMotion(theme, progress, width, height, target, radius) {
    if (theme === 'glide' || theme === 'soft-fade')
        return {sides: {...target}, radius, solid: false, opacity: smooth(progress / 0.9), shadow: 1};
    if (theme === 'liquid') {
        // The frame and bars gather at their actual edges in one gesture. Keep
        // the desktop opening fixed throughout, including on frameless layouts.
        return {sides: {...target}, radius, solid: false,
            edges: Object.fromEntries(Object.keys(EDGE_DELAYS).map(edge => [edge, liquidGrowth(progress, edge)])),
            opacity: smooth(progress / 0.19), shadow: smooth(progress / 0.72)};
    }
    const p = theme === 'cascade' ? spread(progress / 0.94) : smooth(progress / 0.88);
    let origin = {left: width / 2, right: width / 2, top: height / 2, bottom: height / 2};
    if (theme === 'curtain') {
        origin = {...origin, top: target.top, bottom: target.bottom};
    } else if (theme === 'cascade') {
        origin = {...target, bottom: height - target.top};
    }
    const sides = Object.fromEntries(Object.entries(origin).map(([edge, value]) => {
        return [edge, theme === 'fade' ? value : p === 1 ? target[edge]
            : value + (target[edge] - value) * p];
    }));
    return {sides, solid: theme === 'fade',
        radius: radius + Math.min(width, height) * 0.06 * (1 - p),
        opacity: theme === 'fade' ? 1 - smooth(progress / 0.9) : 1,
        shadow: p};
}

export function barMotion(theme, progress, edge) {
    const vertical = edge === 'left' || edge === 'right';
    if (theme === 'liquid') {
        const delay = EDGE_DELAYS[edge];
        const growth = liquidGrowth(progress, edge);
        const along = Math.max(0.001, growth);
        const across = 0.2 + 0.8 * growth;
        return {x: vertical ? across : along, y: vertical ? along : across,
            offset: 1 - spread((progress - delay) / 0.42),
            opacity: smooth((progress - delay) / 0.19),
            contentOpacity: smooth((progress - 0.44) / 0.25), pivot: [0.5, 0.5]};
    }
    if (theme === 'glide' || theme === 'soft-fade')
        return {x: 1, y: 1, offset: theme === 'glide' ? 1 - spread(progress / 0.9) : 0,
            opacity: smooth(progress / 0.9), contentOpacity: 1, pivot: [0.5, 0.5]};
    if (theme === 'fade')
        return {x: 1, y: 1, opacity: smooth((progress - 0.12) / 0.8), contentOpacity: 1, pivot: [0.5, 0.5]};
    const delay = theme === 'cascade' ? {top: 0.06, left: 0.18, right: 0.24, bottom: 0.38}[edge] : 0.18;
    const growth = Math.max(0.001, spread((progress - delay) / 0.54));
    return {x: vertical ? 1 : growth, y: vertical ? growth : 1,
        opacity: smooth((progress - delay) / 0.32),
        contentOpacity: smooth((progress - delay - 0.25) / 0.35),
        pivot: theme === 'cascade' ? [0, 0] : [0.5, 0.5]};
}

// Icons nearest the bar's centre catch first; the wave reaches both ends.
// Displacement always points from the desktop towards the configured bar.
export function iconMotion(progress, position = 0.5) {
    const distance = Math.min(1, Math.abs(position - 0.5) * 2);
    const t = Math.max(0, Math.min(1, (progress - 0.44 - distance * 0.065) / 0.38));
    const catchUp = spread(t);
    return {opacity: smooth(t / 0.52), scale: 0.96 + 0.04 * catchUp,
        across: 1 - catchUp, along: (0.5 - position) * (1 - catchUp) * 0.45};
}
