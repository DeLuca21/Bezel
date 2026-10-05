import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {clamp, switchOn} from './config.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

export function buildOsd(bar) {
    const services = bar._overlay.services;
    const volume = bar._state.modules.find(item => item.id === 'volume');
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL, x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 14px;',
    });
    box.add_child(edgeLevel(bar, 'audio-volume-high-symbolic',
        () => services.stream?.is_muted ? 0 : services.volume / Math.max(0.01, services.maxVolume),
        value => services.setVolume(value * services.maxVolume),
        () => services.volumeIcon, 8, switchOn(volume, bar._state, 'popIcon'), switchOn(volume, bar._state, 'popValue'),
        () => services.stream?.is_muted ? 'Muted' : `${Math.round(services.volume * 100)}%`,
        switchOn(volume, bar._state, 'showMute') ? () => services.toggleMute() : null));
    if (services.hasBrightness)
        box.add_child(edgeLevel(bar, 'display-brightness-symbolic',
            () => services.brightnessLevel, value => services.setBrightness(value),
            () => 'display-brightness-symbolic', 6,
            switchOn(volume, bar._state, 'brightIcon'), switchOn(volume, bar._state, 'brightValue'),
            () => `${Math.round(services.brightnessLevel * 100)}%`));
    return box;
}

export function buildStacked(bar) {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;'});
    box.add_child(buildLevelControl(bar, 'volume', false));
    if (bar._overlay.services.hasBrightness)
        box.add_child(buildLevelControl(bar, 'brightness', false));
    if (switchOn(bar._state.modules.find(item => item.id === 'volume'), bar._state, 'showMute'))
        box.add_child(buildMuteButton(bar));
    return box;
}

export function buildMuteButton(bar) {
    const mute = new St.Button({can_focus: true, label: 'Mute / unmute', style_class: 'bezel-action',
        style: `background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; border-radius: 14px; padding: 10px;`});
    mute.connect('clicked', () => bar._overlay.services.toggleMute());
    return mute;
}

// The same controls are used by automatic groups and editable rows.
export function buildLevelControl(bar, id, withMute = true, options = null) {
    const services = bar._overlay.services;
    const volume = bar._state.modules.find(item => item.id === 'volume') || {id: 'volume', ...options};
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 12px;'});
    if (id === 'volume') {
        box.add_child(flatLevel(bar, 'audio-volume-high-symbolic', 'Volume',
            () => services.stream?.is_muted ? 0 : Math.min(services.maxVolume, services.volume),
            value => services.setVolume(value), () => services.maxVolume,
            switchOn(volume, bar._state, 'popIcon'), switchOn(volume, bar._state, 'popValue'), () => services.volumeIcon,
            () => services.stream?.is_muted ? 'Muted' : `${Math.round(services.volume * 100)}%`));
        if (withMute && switchOn(volume, bar._state, 'showMute')) box.add_child(buildMuteButton(bar));
    } else if (services.hasBrightness) {
        box.add_child(flatLevel(bar, 'display-brightness-symbolic', 'Brightness',
            () => services.brightnessLevel, value => services.setBrightness(value), () => 1,
            switchOn(volume, bar._state, 'brightIcon'), switchOn(volume, bar._state, 'brightValue'),
            () => 'display-brightness-symbolic', () => `${Math.round(services.brightnessLevel * 100)}%`));
    }
    return box;
}

export function buildSessionRail(bar, options = {}) {
    const actions = SystemActions.getDefault();
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 10px;',
    });
    for (const [title, icon, allowed, run] of [
        ['Log out', 'system-log-out-symbolic', actions.can_logout, () => actions.activateLogout()],
        ['Power off', 'system-shutdown-symbolic', actions.can_power_off, () => actions.activatePowerOff()],
        ['Lock', 'system-lock-screen-symbolic', actions.can_lock_screen, () => actions.activateLockScreen()],
        ['Restart', 'system-reboot-symbolic', actions.can_restart, () => actions.activateRestart()],
        ['Suspend', 'media-playback-pause-symbolic', actions.can_suspend, () => actions.activateSuspend()],
    ]) {
        const key = {'Lock': 'powerLock', 'Suspend': 'powerSuspend', 'Log out': 'powerLogout', 'Restart': 'powerRestart', 'Power off': 'powerOff'}[title];
        if (!allowed || options[key] === false)
            continue;
        const button = new St.Button({
            can_focus: true, reactive: true, accessible_name: title,
            style: `background-color: ${bar._theme.surface}; border-radius: 18px; padding: 10px;`,
            child: new St.Icon({icon_name: icon, icon_size: 22, style: `color: ${bar._theme.fg};`}),
        });
        button.connect('clicked', () => { bar._close(); run(); });
        box.add_child(button);
    }
    return box;
}

function edgeLevel(bar, icon, getValue, setValue, iconName, thickness = 8, showIcon = true, showValue = false, valueText = () => '', onIcon = null) {
    const theme = bar._theme;
    const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 10px;',
    });
    const glyph = new St.Icon({icon_name: icon, icon_size: 16, style: `color: ${theme.muted};`});
    glyph.visible = showIcon;
    const reading = new St.Label({text: '', style: `color: ${theme.fg}; font-size: 11px; font-weight: 600;`});
    reading.visible = showValue;
    const track = new St.DrawingArea({width: thickness, height: 148, reactive: true});
    track.connect('repaint', area => {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const ratio = clamp(getValue(), 0, 1);
            cr.setSourceRGBA(0, 0, 0, 0.08);
            rounded(cr, 0, 0, w, h, w / 2);
            cr.fill();
            const fill = Math.max(w, h * ratio);
            cr.setSourceRGB(...[1, 3, 5].map(i => parseInt(theme.accent.slice(i, i + 2), 16) / 255));
            rounded(cr, 0, h - fill, w, fill, w / 2);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    });
    const apply = event => {
        const [, y] = event.get_coords();
        const [, ay] = track.get_transformed_position();
        const [, ah] = track.get_transformed_size();
        setValue(clamp(1 - (y - ay) / Math.max(1, ah), 0, 1));
        track.queue_repaint();
    };
    track.connect('button-press-event', (_actor, event) => {
        apply(event);
        return Clutter.EVENT_STOP;
    });
    track.connect('motion-event', (_actor, event) => {
        if (event.get_state() & Clutter.ModifierType.BUTTON1_MASK)
            apply(event);
        return Clutter.EVENT_PROPAGATE;
    });
    column.add_child(glyph);
    column.add_child(reading);
    column.add_child(track);
    if (onIcon) {
        const mute = new St.Button({
            can_focus: true, label: 'Mute', accessible_name: 'Mute / unmute',
            style: `color: ${theme.fg}; font-size: 11px; padding: 2px 6px; border-radius: 8px; background-color: ${theme.surface};`,
        });
        mute.connect('clicked', onIcon);
        column.add_child(mute);
    }
    let lastRatio;
    const unsubscribe = bar._overlay.services.subscribe(() => {
        glyph.icon_name = iconName();
        reading.text = valueText();
        const ratio = clamp(getValue(), 0, 1);
        // Media, clipboard and other service updates do not change this meter.
        if (ratio !== lastRatio) {
            lastRatio = ratio;
            track.queue_repaint();
        }
    });
    column.connect('destroy', unsubscribe);
    return column;
}

function flatLevel(bar, fallbackIcon, name, getValue, setValue, getMax, showIcon, showValue, iconName, valueText) {
    const theme = bar._theme;
    const row = new St.BoxLayout({style: 'spacing: 8px;', y_align: Clutter.ActorAlign.CENTER});
    const glyph = new St.Icon({icon_name: fallbackIcon, icon_size: 16, style: `color: ${theme.muted};`});
    glyph.visible = showIcon;
    const reading = new St.Label({text: '', style: `color: ${theme.fg}; font-size: 12px; font-weight: 600;`});
    reading.visible = showValue;
    const slider = new Slider.Slider(0);
    slider.accessible_name = name;
    slider.x_expand = true;
    slider.style = `height: 28px; min-width: 40px; -barlevel-height: 24px; color: ${theme.accent}; -barlevel-active-background-color: ${theme.accent}; -barlevel-background-color: ${theme.border};`;
    let updating = false;
    slider.connect('notify::value', () => {
        if (!updating)
            setValue(slider.value);
    });
    row.add_child(glyph);
    row.add_child(slider);
    row.add_child(reading);
    const unsubscribe = bar._overlay.services.subscribe(() => {
        updating = true;
        slider.maximum_value = getMax();
        slider.overdrive_start = 1;
        slider.value = getValue();
        glyph.icon_name = iconName();
        reading.text = valueText();
        updating = false;
    });
    row.connect('destroy', unsubscribe);
    return row;
}

function rounded(cr, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, Math.max(0, h / 2));
    cr.newPath();
    cr.moveTo(x + radius, y);
    cr.lineTo(x + w - radius, y);
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.lineTo(x + w, y + h - radius);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.lineTo(x + radius, y + h);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.lineTo(x, y + radius);
    cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
    cr.closePath();
}
