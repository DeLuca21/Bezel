// Fade uses one coverage for the bars and the border. Retreat moves a whole
// bar off its own screen edge, including the gap when a dock sits inset.
// The frame opening grows out to that screen edge. A monitor mask hides
// whatever has crossed the edge, so it does not appear on the next screen.

export function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export function shownAt(from, to, timelineProgress) {
    return from + (to - from) * clamp01(timelineProgress);
}

export function fadeOpacity(saved, shown) {
    return Math.round((Number(saved) || 0) * clamp01(shown));
}

export function fadeCoverage(shown, saved = 255) {
    const opacity = fadeOpacity(saved, shown);
    return {opacity, alpha: opacity / 255};
}

export function slideBy(edge, distance) {
    const d = Math.max(0, Number(distance) || 0);
    if (edge === 'left')
        return {x: -d, y: 0};
    if (edge === 'right')
        return {x: d, y: 0};
    if (edge === 'bottom')
        return {x: 0, y: d};
    return {x: 0, y: -d};
}

export function slideOut(edge, distance, shown) {
    return slideBy(edge, (Number(distance) || 0) * (1 - clamp01(shown)));
}

export function edgeClearance(edge, box, monitor) {
    const x = Number(box?.x) || 0;
    const y = Number(box?.y) || 0;
    const width = Number(box?.width) || 0;
    const height = Number(box?.height) || 0;
    const left = Number(monitor?.x) || 0;
    const top = Number(monitor?.y) || 0;
    const right = left + (Number(monitor?.width) || 0);
    const bottom = top + (Number(monitor?.height) || 0);
    if (edge === 'left')
        return Math.max(0, x + width - left);
    if (edge === 'right')
        return Math.max(0, right - x);
    if (edge === 'top')
        return Math.max(0, y + height - top);
    return Math.max(0, bottom - y);
}

// Actor-local clip pinned to the monitor while the actor translates by slide.
export function monitorClip(box, monitor, slide) {
    const originX = (Number(box?.x) || 0) + (Number(slide?.x) || 0);
    const originY = (Number(box?.y) || 0) + (Number(slide?.y) || 0);
    return {
        x: (Number(monitor?.x) || 0) - originX,
        y: (Number(monitor?.y) || 0) - originY,
        width: Number(monitor?.width) || 0,
        height: Number(monitor?.height) || 0,
    };
}

export function frameSides(rest, shown) {
    const t = clamp01(shown);
    return {
        top: (Number(rest.top) || 0) * t,
        right: (Number(rest.right) || 0) * t,
        bottom: (Number(rest.bottom) || 0) * t,
        left: (Number(rest.left) || 0) * t,
    };
}
