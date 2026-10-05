import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {moduleLook, switchOn} from './config.js';

export function buildValueButton(bar, id, iconName, size, fallback) {
    const look = moduleLook(bar._state.modules.find(item => item.id === id), bar._state);
    const row = new St.BoxLayout({
        orientation: bar._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        style: 'spacing: 4px;', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    const icon = new St.Icon({icon_name: iconName, icon_size: size, style: `color: ${bar._theme.fg};`});
    const text = new St.Label({
        text: fallback,
        style: `color: ${bar._theme.fg}; font-size: ${Math.max(11, Math.round(size * 0.5))}px; font-weight: 600;`,
    });
    text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    icon.visible = look.icon;
    text.visible = look.value;
    row.add_child(icon);
    row.add_child(text);
    const button = new St.Button({reactive: true, can_focus: true, child: row, x_align: Clutter.ActorAlign.CENTER});
    button.accessible_name = fallback;
    if (id === 'performance')
        watchProfile(button, (name, glyph) => {
            text.text = name;
            icon.icon_name = glyph;
            button.accessible_name = name;
        });
    if (id === 'vpn')
        watchVpn(button, name => {
            text.text = name || 'VPN';
            button.accessible_name = name || 'VPN';
        });
    return button;
}

export function buildMediaFace(bar, size) {
    const services = bar._overlay.services;
    const look = moduleLook(bar._state.modules.find(item => item.id === 'media'), bar._state);
    const row = new St.BoxLayout({
        orientation: bar._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        style: 'spacing: 4px;', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    const art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: size, style: `color: ${bar._theme.accent};`});
    const icon = new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: size, style: `color: ${bar._theme.fg};`});
    const title = new St.Label({
        text: 'Now playing',
        style: `color: ${bar._theme.fg}; font-size: ${Math.max(11, Math.round(size * 0.5))}px; font-weight: 600;`,
    });
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    if (!bar._vertical) {
        title.width = 120;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    art.visible = look.art;
    icon.visible = look.icon;
    title.visible = look.value;
    row.add_child(art);
    row.add_child(icon);
    row.add_child(title);
    const button = new St.Button({reactive: true, can_focus: true, child: row, x_align: Clutter.ActorAlign.CENTER});
    let paintedArt = null;
    const unsubscribe = services.subscribe(() => {
        const media = services.media;
        icon.icon_name = media?.playing ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        title.text = media?.title ?? 'Nothing playing';
        button.accessible_name = media ? `${media.title}${media.artist ? ` · ${media.artist}` : ''}` : 'Nothing playing';
        const artUrl = media?.artUrl?.startsWith('file://') ? media.artUrl : '';
        if (look.art && artUrl !== paintedArt) {
            paintedArt = artUrl;
            art.gicon = media?.artUrl?.startsWith('file://')
                ? new Gio.FileIcon({file: Gio.File.new_for_uri(media.artUrl)})
                : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        }
        if (bar._box)
            bar._place();
    });
    button.connect('destroy', unsubscribe);
    return button;
}

export function buildMicFace(bar, size) {
    const services = bar._overlay.services;
    const look = moduleLook(bar._state.modules.find(item => item.id === 'microphone'), bar._state);
    const row = new St.BoxLayout({
        orientation: bar._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        style: 'spacing: 4px;', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    const icon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', icon_size: size, style: `color: ${bar._theme.fg};`});
    const text = new St.Label({
        text: '',
        style: `color: ${bar._theme.fg}; font-size: ${Math.max(11, Math.round(size * 0.5))}px; font-weight: 600;`,
    });
    icon.visible = look.icon;
    text.visible = look.value;
    row.add_child(icon);
    row.add_child(text);
    const button = new St.Button({reactive: true, can_focus: true, child: row, x_align: Clutter.ActorAlign.CENTER});
    const unsubscribe = services.subscribe(() => {
        icon.icon_name = services.micIcon;
        text.text = services.source?.is_muted ? 'Muted' : `${Math.round(services.micVolume * 100)}%`;
        button.accessible_name = `Microphone · ${text.text}`;
    });
    button.connect('destroy', unsubscribe);
    return button;
}

export function buildMicPanel(bar, options = null) {
    const services = bar._overlay.services;
    const module = bar._state.modules.find(item => item.id === 'microphone') || {id: 'microphone', ...options};
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
    const row = new St.BoxLayout({style: 'spacing: 8px;', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', icon_size: 16, style: `color: ${bar._theme.muted};`});
    icon.visible = switchOn(module, bar._state, 'showIcon');
    const reading = new St.Label({text: '', style: `color: ${bar._theme.fg}; font-size: 12px; font-weight: 600;`});
    reading.visible = switchOn(module, bar._state, 'showValue');
    const slider = new Slider.Slider(0);
    slider.accessible_name = 'Microphone';
    slider.x_expand = true;
    slider.style = `height: 28px; min-width: 160px; -barlevel-height: 24px; color: ${bar._theme.accent}; -barlevel-active-background-color: ${bar._theme.accent}; -barlevel-background-color: ${bar._theme.border};`;
    let updating = false;
    slider.connect('notify::value', () => {
        if (!updating)
            services.setMicVolume(slider.value);
    });
    const mute = new St.Button({
        can_focus: true, label: 'Mute microphone', style_class: 'bezel-action',
        style: `background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; border-radius: 14px; padding: 10px;`,
    });
    mute.connect('clicked', () => services.toggleMicMute());
    row.add_child(icon);
    row.add_child(slider);
    row.add_child(reading);
    box.add_child(row);
    if (switchOn(module, bar._state, 'showMute')) box.add_child(mute);
    else mute.destroy();
    const unsubscribe = services.subscribe(() => {
        updating = true;
        slider.value = services.source?.is_muted ? 0 : services.micVolume;
        slider.reactive = Boolean(services.source);
        icon.icon_name = services.micIcon;
        reading.text = services.source ? (services.source.is_muted ? 'Muted' : `${Math.round(services.micVolume * 100)}%`) : 'No microphone';
        updating = false;
    });
    box.connect('destroy', unsubscribe);
    return box;
}

export function buildClipboardPanel(bar) {
    const services = bar._overlay.services;
    const theme = bar._theme;
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
    const entry = new St.Entry({
        hint_text: 'Search clipboard',
        x_expand: true,
        style: `color: ${theme.fg};`,
    });
    const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 6px;'});
    let paintedHistory = null;
    let paintedQuery = null;
    const paint = () => {
        const query = entry.get_text().trim().toLowerCase();
        const history = services.clipboard;
        if (history === paintedHistory && query === paintedQuery) return;
        paintedHistory = history;
        paintedQuery = query;
        list.destroy_all_children();
        const items = services.clipboard.filter(item => !query || item.toLowerCase().includes(query));
        if (!items.length) {
            list.add_child(new St.Label({
                text: services.clipboard.length ? 'No matches' : 'Clipboard history is empty',
                style: `color: ${theme.muted}; font-size: 13px; padding: 8px;`,
            }));
            return;
        }
        for (const item of items.slice(0, 12)) {
            const button = new St.Button({
                can_focus: true, x_expand: true, style_class: 'bezel-action',
                style: `background-color: ${theme.surface}; border-radius: 12px; padding: 10px;`,
                child: new St.Label({
                    text: item.length > 80 ? `${item.slice(0, 80)}…` : item,
                    x_expand: true,
                    style: `color: ${theme.fg}; font-size: 13px;`,
                }),
            });
            button.child.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            button.connect('clicked', () => {
                services.copyText(item);
                bar._close();
            });
            list.add_child(button);
        }
    };
    entry.clutter_text.connect('text-changed', paint);
    const unsubscribe = services.subscribe(paint);
    box.connect('destroy', unsubscribe);
    box.add_child(entry);
    box.add_child(list);
    return box;
}

export function buildKeyboardFace(bar, size) {
    const button = new St.Button({
        reactive: true, can_focus: true, x_align: Clutter.ActorAlign.CENTER,
        child: new St.Label({
            text: '—',
            style: `color: ${bar._theme.fg}; font-size: ${Math.max(11, Math.round(size * 0.5))}px; font-weight: 700;`,
        }),
    });
    const paint = () => {
        const source = keyboardManager()?.currentSource;
        button.child.text = source?.shortName || source?.id || '—';
        button.accessible_name = source?.displayName || 'Keyboard layout';
    };
    paint();
    const manager = keyboardManager();
    const signals = [];
    if (manager) {
        for (const name of ['current-source-changed', 'sources-changed']) {
            try {
                signals.push(manager.connect(name, paint));
            } catch {
            }
        }
    }
    button.connect('destroy', () => {
        for (const id of signals)
            manager.disconnect(id);
    });
    button._activate = () => cycleLayout(1);
    bar._hoverDrawer('keyboard', button, () => buildKeyboardPanel(bar), bar._hoverFor('keyboard'));
    button.connect('scroll-event', (_actor, event) => {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            cycleLayout(-1);
        else
            cycleLayout(1);
        paint();
        return Clutter.EVENT_STOP;
    });
    return button;
}

export function buildKeyboardPanel(bar) {
    const theme = bar._theme;
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
    const manager = keyboardManager();
    const sources = manager ? Object.values(manager.inputSources ?? {}) : [];
    if (!sources.length) {
        box.add_child(new St.Label({text: 'One keyboard layout', style: `color: ${theme.muted}; padding: 8px;`}));
        return box;
    }
    for (const source of sources) {
        const on = source === manager.currentSource;
        const button = new St.Button({
            can_focus: true, x_expand: true, style_class: 'bezel-action',
            style: `background-color: ${on ? theme.accent : theme.surface}; color: ${theme.fg}; border-radius: 12px; padding: 10px;`,
            label: source.displayName || source.shortName || source.id,
        });
        button.connect('clicked', () => {
            source.activate?.(true);
            bar._close();
        });
        box.add_child(button);
    }
    return box;
}

export function buildAwakeFace(bar, size) {
    const services = bar._overlay.services;
    const button = new St.Button({
        reactive: true, can_focus: true, x_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: 'system-suspend-symbolic', icon_size: size, style: `color: ${bar._theme.fg};`}),
    });
    const sync = () => {
        const on = services.awake;
        button.child.icon_name = on ? 'system-run-symbolic' : 'system-suspend-symbolic';
        button.accessible_name = on ? 'Keep awake on' : 'Keep awake off';
    };
    const unsubscribe = services.subscribe(sync);
    button.connect('destroy', unsubscribe);
    button._activate = () => services.setAwake(!services.awake);
    bar._hoverDrawer('awake', button, () => awakeRow(bar), bar._hoverFor('awake'));
    return button;
}

function awakeRow(bar) {
    const services = bar._overlay.services;
    const theme = bar._theme;
    const title = new St.Label({x_expand: true, style: `color: ${theme.fg}; font-size: 14px; font-weight: 600;`});
    const button = new St.Button({
        can_focus: true, x_expand: true, style_class: 'bezel-action',
        style: `background-color: ${theme.surface}; border-radius: 14px; padding: 12px 10px;`,
        child: title,
    });
    const sync = () => { title.text = `Keep awake · ${services.awake ? 'On' : 'Off'}`; };
    const unsubscribe = services.subscribe(sync);
    button.connect('destroy', unsubscribe);
    button.connect('clicked', () => services.setAwake(!services.awake));
    return button;
}

function keyboardManager() {
    try {
        return Keyboard.getInputSourceManager?.() ?? null;
    } catch {
        return null;
    }
}

function cycleLayout(step) {
    const manager = keyboardManager();
    const sources = Object.values(manager?.inputSources ?? {});
    if (sources.length < 2)
        return;
    const index = Math.max(0, sources.indexOf(manager.currentSource));
    sources[(index + step + sources.length) % sources.length].activate?.(true);
}

function watchProfile(button, paint) {
    const cancel = new Gio.Cancellable();
    let proxy = null;
    let changed = 0;
    button.connect('destroy', () => {
        cancel.cancel();
        if (changed) proxy.disconnect(changed);
        changed = 0;
        proxy = null;
    });
    const load = (name, path, iface) => {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            name, path, iface, cancel, (_source, result) => {
                let candidate;
                try {
                    candidate = Gio.DBusProxy.new_for_bus_finish(result);
                    if (!candidate.get_name_owner())
                        throw new Error('no owner');
                } catch {
                    if (!cancel.is_cancelled() && name !== 'net.hadess.PowerProfiles')
                        load('net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles');
                    return;
                }
                if (cancel.is_cancelled()) return;
                proxy = candidate;
                const names = {
                    'power-saver': ['Power Saver', 'power-profile-power-saver-symbolic'],
                    balanced: ['Balanced', 'power-profile-balanced-symbolic'],
                    performance: ['Performance', 'power-profile-performance-symbolic'],
                };
                const sync = () => {
                    if (cancel.is_cancelled()) return;
                    const active = proxy.get_cached_property('ActiveProfile')?.unpack() ?? '';
                    const [label, icon] = names[active] ?? [active || 'Performance', 'power-profile-balanced-symbolic'];
                    paint(label, icon);
                };
                changed = proxy.connect('g-properties-changed', sync);
                sync();
            });
    };
    load('org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles', 'org.freedesktop.UPower.PowerProfiles');
}

function watchVpn(button, paint) {
    const cancel = new Gio.Cancellable();
    let pending = null;
    const refresh = () => {
        if (cancel.is_cancelled() || pending)
            return;
        let subprocess;
        try {
            subprocess = Gio.Subprocess.new(['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show'], Gio.SubprocessFlags.STDOUT_PIPE);
        } catch {
            paint('');
            return;
        }
        pending = subprocess;
        subprocess.communicate_utf8_async(null, cancel, (_proc, result) => {
            try {
                const [, text] = subprocess.communicate_utf8_finish(result);
                const active = text.split('\n').map(line => line.split(':')).find(([, type, device]) => /vpn|wireguard|tun/i.test(type ?? '') && device && device !== '--');
                if (!cancel.is_cancelled())
                    paint(active?.[0] ?? '');
            } catch {
                if (!cancel.is_cancelled())
                    paint('');
            } finally {
                pending = null;
            }
        });
    };
    refresh();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
        refresh();
        return GLib.SOURCE_CONTINUE;
    });
    button.connect('destroy', () => {
        cancel.cancel();
        GLib.source_remove(timer);
        if (pending) {
            try { pending.force_exit(); } catch {}
            pending = null;
        }
    });
}
