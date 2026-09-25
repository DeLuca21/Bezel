import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {clamp} from './config.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

export function buildOsd(bar) {
    const services = bar._overlay.services;
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL, x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 14px;',
    });
    box.add_child(edgeLevel(bar, 'audio-volume-high-symbolic',
        () => services.stream?.is_muted ? 0 : services.volume / Math.max(0.01, services.maxVolume),
        value => services.setVolume(value * services.maxVolume),
        () => services.volumeIcon, 8));
    if (services.hasBrightness)
        box.add_child(edgeLevel(bar, 'display-brightness-symbolic',
            () => services.brightnessLevel, value => services.setBrightness(value),
            () => 'display-brightness-symbolic', 6));
    return box;
}

export function buildSessionRail(bar) {
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
        if (!allowed)
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

function edgeLevel(bar, icon, getValue, setValue, iconName, thickness = 8) {
    const theme = bar._theme;
    const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 10px;',
    });
    const glyph = new St.Icon({icon_name: icon, icon_size: 16, style: `color: ${theme.muted};`});
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
    column.add_child(track);
    const unsubscribe = bar._overlay.services.subscribe(() => {
        glyph.icon_name = iconName();
        track.queue_repaint();
    });
    column.connect('destroy', unsubscribe);
    return column;
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
