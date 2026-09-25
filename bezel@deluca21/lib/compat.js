// GNOME 48–50 expose enable-animations; 51 also has reduced-motion.
// Keep this function independent of GI so both API shapes can be tested.
export function allowsMotion(settings, reducedMotion) {
    if (settings.enable_animations === false) return false;
    const preference = settings.reduced_motion ?? settings.reducedMotion;
    return !reducedMotion || preference !== reducedMotion.REDUCE;
}

export function shellBackend(stage, clutter) {
    return stage.context?.get_backend() ?? clutter.get_default_backend();
}

export function maximizeWindow(window, meta) {
    if (typeof window.is_maximized === 'function') window.maximize();
    else window.maximize(meta.MaximizeFlags.BOTH);
}

// X11 input-region tracking was removed along with X11 in Shell 50.
export function chromeOptions(version, input, struts = false, fullscreen = true) {
    return {affectsStruts: struts, trackFullscreen: fullscreen,
        ...(parseInt(version, 10) < 50 ? {affectsInputRegion: input} : {})};
}
