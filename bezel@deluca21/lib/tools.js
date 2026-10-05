import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FALLBACK_PANELS = [
    ['Wi-Fi', 'network-wireless-symbolic', ['wifi']],
    ['Network', 'network-wired-symbolic', ['network']],
    ['Bluetooth', 'bluetooth-symbolic', ['bluetooth']],
    ['Appearance', 'preferences-desktop-appearance-symbolic', ['background']],
    ['Notifications', 'preferences-system-notifications-symbolic', ['notifications']],
    ['Sound', 'audio-volume-high-symbolic', ['sound']],
    ['Power', 'power-profile-balanced-symbolic', ['power']],
    ['Displays', 'video-display-symbolic', ['display']],
    ['Mouse & Touchpad', 'input-mouse-symbolic', ['mouse']],
    ['Keyboard', 'input-keyboard-symbolic', ['keyboard']],
    ['Privacy & Security', 'preferences-system-privacy-symbolic', ['privacy']],
    ['Users', 'system-users-symbolic', ['system', 'users']],
    ['Date & Time', 'preferences-system-time-symbolic', ['system', 'datetime']],
    ['Region & Language', 'preferences-desktop-locale-symbolic', ['system', 'region']],
    ['Search', 'system-search-symbolic', ['search']],
    ['Apps', 'view-app-grid-symbolic', ['applications']],
    ['Online Accounts', 'goa-panel-symbolic', ['online-accounts']],
    ['Sharing', 'folder-remote-symbolic', ['sharing']],
    ['Printers', 'printer-symbolic', ['printers']],
    ['Accessibility', 'preferences-desktop-accessibility-symbolic', ['universal-access']],
    ['Multitasking', 'preferences-desktop-multitasking-symbolic', ['multitasking']],
    ['System', 'preferences-system-symbolic', ['system']],
    ['About', 'help-about-symbolic', ['system', 'about']],
];

let panelCache = null;

function desktopPanels() {
    const directory = Gio.File.new_for_path('/usr/share/applications');
    const enumerator = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    const found = [];
    try {
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
            const filename = info.get_name();
            if (!/^gnome-.*-panel\.desktop$/.test(filename))
                continue;
            const key = new GLib.KeyFile();
            key.load_from_file(directory.get_child(filename).get_path(), GLib.KeyFileFlags.NONE);
            const name = key.get_locale_string('Desktop Entry', 'Name', null);
            const exec = key.get_string('Desktop Entry', 'Exec');
            let icon = 'preferences-system-symbolic';
            let words = '';
            try { icon = key.get_string('Desktop Entry', 'Icon'); } catch { /* Icon is optional. */ }
            try { words = key.get_string('Desktop Entry', 'Keywords'); } catch { /* Keywords are optional. */ }
            const args = exec.split(/\s+/).slice(1).filter(arg => arg && !arg.startsWith('%'));
            if (!name || !args.length)
                continue;
            found.push({name, icon, args, keywords: `settings gnome control ${name} ${words.replaceAll(';', ' ')}`});
        }
    } finally {
        enumerator.close(null);
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function settingsPanels() {
    if (panelCache)
        return panelCache;
    try {
        const found = desktopPanels();
        panelCache = found.length ? found : null;
    } catch {
        panelCache = null;
    }
    panelCache ??= FALLBACK_PANELS.map(([name, icon, args]) => ({name, icon, args, keywords: `settings gnome control ${name}`}));
    return panelCache;
}

export function openSettings(...parts) {
    const args = parts.flat().filter(Boolean);
    try {
        Gio.Subprocess.new(['gnome-control-center', ...args], Gio.SubprocessFlags.NONE);
    } catch (error) {
        console.warn(`Bezel: could not open Settings: ${error.message}`);
    }
}

const RECORDING_ICON = 'media-record-symbolic';
const RECORDING_COLOR = '#e01b24';

export async function openScreenshot() {
    const screenshot = await import('resource:///org/gnome/shell/ui/screenshot.js');
    screenshot.showScreenshotUI();
}

export function screenshotRecording() {
    return Main.screenshotUI?.screencast_in_progress === true;
}

export function screenshotFace(idleColor) {
    const recording = screenshotRecording();
    return {
        icon: recording ? RECORDING_ICON : 'camera-photo-symbolic',
        color: recording ? RECORDING_COLOR : idleColor,
        name: recording ? 'Stop recording' : 'Screenshot',
        label: recording ? 'Stop recording' : 'Take a screenshot',
    };
}

export function watchScreenshotRecording(actor, sync) {
    const ui = Main.screenshotUI;
    if (!ui)
        return;
    const id = ui.connect('notify::screencast-in-progress', sync);
    actor.connect('destroy', () => ui.disconnect(id));
}

export async function activateScreenshot() {
    const ui = Main.screenshotUI;
    if (ui?.screencast_in_progress) {
        await ui.stopScreencast();
        return;
    }
    await openScreenshot();
}

function desktopSettings(schema) {
    try {
        if (!Gio.SettingsSchemaSource.get_default().lookup(schema, true))
            return null;
        return new Gio.Settings({schema_id: schema});
    } catch {
        return null;
    }
}

export function bindToggle(button, {onIcon, offIcon, name, active, toggle, settings, signal = 'changed'}) {
    const sync = () => {
        const on = active();
        button.child.icon_name = on ? onIcon : offIcon;
        button.accessible_name = `${name}, ${on ? 'on' : 'off'}`;
    };
    const id = settings?.connect(signal, sync);
    if (id)
        button.connect('destroy', () => settings.disconnect(id));
    button._activate = () => { toggle(); sync(); };
    sync();
    return button;
}

export function dndControl() {
    const settings = desktopSettings('org.gnome.desktop.notifications');
    if (!settings)
        return null;
    return {
        settings,
        active: () => !settings.get_boolean('show-banners'),
        toggle: () => settings.set_boolean('show-banners', settings.get_boolean('show-banners') === false),
    };
}

export function nightLightControl() {
    const settings = desktopSettings('org.gnome.settings-daemon.plugins.color');
    if (!settings?.settings_schema.has_key('night-light-enabled'))
        return null;
    return {
        settings,
        signal: 'changed::night-light-enabled',
        active: () => settings.get_boolean('night-light-enabled'),
        toggle: () => settings.set_boolean('night-light-enabled', !settings.get_boolean('night-light-enabled')),
    };
}

export function darkStyleControl() {
    const settings = desktopSettings('org.gnome.desktop.interface');
    if (!settings?.settings_schema.has_key('color-scheme'))
        return null;
    const dark = () => settings.get_string('color-scheme') === 'prefer-dark';
    return {
        settings,
        signal: 'changed::color-scheme',
        active: dark,
        toggle: () => settings.set_string('color-scheme', dark() ? 'default' : 'prefer-dark'),
    };
}

export function moduleSection(bar, id) {
    if (id === 'screenshot')
        return screenshotRow(bar);
    if (id === 'dnd')
        return toggleRow(bar, 'Do Not Disturb', 'notifications-disabled-symbolic', dndControl());
    if (id === 'nightlight')
        return toggleRow(bar, 'Night Light', 'night-light-symbolic', nightLightControl());
    if (id === 'dark')
        return toggleRow(bar, 'Dark style', 'weather-clear-night-symbolic', darkStyleControl());
    if (id === 'performance')
        return performanceMenu(bar);
    if (id === 'vpn')
        return vpnMenu(bar);
    if (id === 'settings')
        return settingsMenu(bar);
    return null;
}

function toggleRow(bar, name, iconName, control) {
    if (!control)
        return null;
    const theme = bar._theme;
    const title = new St.Label({x_expand: true, style: `color: ${theme.fg}; font-size: 14px; font-weight: 600;`});
    const button = new St.Button({
        can_focus: true, x_expand: true, style_class: 'bezel-action',
        style: `background-color: ${theme.surface}; border-radius: 14px; padding: 12px 10px;`,
    });
    const row = new St.BoxLayout({style: 'spacing: 10px;'});
    row.add_child(new St.Icon({icon_name: iconName, icon_size: 18, style: `color: ${theme.fg};`}));
    row.add_child(title);
    button.child = row;
    const sync = () => { title.text = `${name} · ${control.active() ? 'On' : 'Off'}`; };
    const signal = control.settings.connect(control.signal ?? 'changed', sync);
    button.connect('destroy', () => control.settings.disconnect(signal));
    button.connect('clicked', () => { control.toggle(); sync(); });
    sync();
    return button;
}

function screenshotRow(bar) {
    const theme = bar._theme;
    const button = new St.Button({
        can_focus: true, x_expand: true, style_class: 'bezel-action',
        style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 14px; padding: 12px 10px;`,
    });
    const row = new St.BoxLayout({style: 'spacing: 10px;'});
    const icon = new St.Icon({icon_name: 'camera-photo-symbolic', icon_size: 18, style: `color: ${theme.fg};`});
    const title = new St.Label({text: 'Take a screenshot', x_expand: true, style: `color: ${theme.fg}; font-size: 14px; font-weight: 600;`});
    row.add_child(icon);
    row.add_child(title);
    button.child = row;
    const sync = () => {
        const face = screenshotFace(theme.fg);
        icon.icon_name = face.icon;
        icon.style = `color: ${face.color};`;
        title.text = face.label;
        button.accessible_name = face.label;
    };
    watchScreenshotRecording(button, sync);
    sync();
    button.connect('clicked', () => {
        bar._close();
        activateScreenshot().catch(error => console.warn(`Bezel: screenshot UI unavailable: ${error.message}`));
    });
    return button;
}

function actionRow(bar, iconName, title, run) {
    const theme = bar._theme;
    const button = new St.Button({
        can_focus: true, x_expand: true, style_class: 'bezel-action',
        style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 14px; padding: 12px 10px;`,
    });
    const row = new St.BoxLayout({style: 'spacing: 10px;'});
    row.add_child(new St.Icon({icon_name: iconName, icon_size: 18, style: `color: ${theme.fg};`}));
    row.add_child(new St.Label({text: title, x_expand: true, style: `color: ${theme.fg}; font-size: 14px; font-weight: 600;`}));
    button.child = row;
    button.connect('clicked', () => { bar._close(); run(); });
    return button;
}

export function settingsMenu(bar) {
    const box = new St.BoxLayout({orientation: 1, style: 'spacing: 8px;'});
    box.add_child(actionRow(bar, 'preferences-system-symbolic', 'All Settings', () => openSettings()));
    for (const panel of settingsPanels())
        box.add_child(actionRow(bar, panel.icon, panel.name, () => openSettings(panel.args)));
    return box;
}

const PROFILES = [
    ['power-saver', 'Power Saver', 'power-profile-power-saver-symbolic'],
    ['balanced', 'Balanced', 'power-profile-balanced-symbolic'],
    ['performance', 'Performance', 'power-profile-performance-symbolic'],
];

function popupRequest(bar, actor) {
    const cancellable = new Gio.Cancellable();
    const cleanups = [];
    let active = true;
    const close = () => {
        if (!active) return;
        active = false;
        cancellable.cancel();
        for (const cleanup of cleanups) cleanup();
        cleanups.length = 0;
    };
    actor.connect('destroy', close);
    bar._popupCleanups.push(close);
    return {cancellable, cleanups, get active() { return active; }};
}

export function performanceMenu(bar) {
    const theme = bar._theme;
    const box = new St.BoxLayout({orientation: 1, style: 'spacing: 8px;'});
    const status = new St.Label({text: 'Reading power profiles…', style: `color: ${theme.muted}; padding: 8px;`});
    box.add_child(status);
    const request = popupRequest(bar, box);
    Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
        'org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles', 'org.freedesktop.UPower.PowerProfiles',
        request.cancellable, (_source, result) => {
            let proxy;
            let iface = 'org.freedesktop.UPower.PowerProfiles';
            try {
                proxy = Gio.DBusProxy.new_for_bus_finish(result);
                if (!request.active) return;
                if (!proxy.get_name_owner())
                    throw new Error('no owner');
            } catch {
                if (!request.active) return;
                Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                    'net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles',
                    request.cancellable, (_source2, result2) => {
                        try {
                            proxy = Gio.DBusProxy.new_for_bus_finish(result2);
                            if (!request.active) return;
                            iface = 'net.hadess.PowerProfiles';
                            if (!proxy.get_name_owner())
                                throw new Error('no owner');
                            showProfiles(proxy, iface);
                        } catch {
                            if (request.active) status.text = 'Power profiles are not available';
                        }
                    });
                return;
            }
            showProfiles(proxy, iface);
        });
    const showProfiles = (proxy, iface) => {
        if (!request.active) return;
        const paint = () => {
            if (!request.active) return;
            box.destroy_all_children();
            const active = proxy.get_cached_property('ActiveProfile')?.unpack() ?? '';
            for (const [id, title, icon] of PROFILES) {
                const on = active === id;
                const button = actionRow(bar, icon, on ? `${title}  ·  on` : title, () => {
                    proxy.call('org.freedesktop.DBus.Properties.Set',
                        new GLib.Variant('(ssv)', [iface, 'ActiveProfile', GLib.Variant.new_string(id)]),
                        Gio.DBusCallFlags.NONE, 3000, null, () => {});
                });
                if (on)
                    button.style = button.style.replace(theme.surface, theme.accent);
                box.add_child(button);
            }
        };
        const changed = proxy.connect('g-properties-changed', paint);
        request.cleanups.push(() => proxy.disconnect(changed));
        paint();
    };
    return box;
}

function splitNmcli(line) {
    const parts = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') {
            current += line[i + 1] ?? '';
            i += 1;
            continue;
        }
        if (line[i] === ':') {
            parts.push(current);
            current = '';
            continue;
        }
        current += line[i];
    }
    if (current)
        parts.push(current);
    return parts;
}

export function vpnMenu(bar) {
    const theme = bar._theme;
    const box = new St.BoxLayout({orientation: 1, style: 'spacing: 8px;'});
    const status = new St.Label({text: 'Reading VPN connections…', style: `color: ${theme.muted}; padding: 8px;`});
    box.add_child(status);
    const request = popupRequest(bar, box);
    let subprocess;
    let finished = false;
    try {
        subprocess = Gio.Subprocess.new(['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show'], Gio.SubprocessFlags.STDOUT_PIPE);
    } catch (error) {
        status.text = 'NetworkManager is not available';
        return box;
    }
    request.cleanups.push(() => { if (!finished) subprocess.force_exit(); });
    subprocess.communicate_utf8_async(null, request.cancellable, (_proc, result) => {
        let text = '';
        try {
            [, text] = subprocess.communicate_utf8_finish(result);
            finished = true;
        } catch (error) {
            if (request.active) status.text = 'Could not list VPN connections';
            return;
        }
        if (!request.active) return;
        const vpns = text.split('\n').map(splitNmcli).filter(([, type]) => /vpn|wireguard|tun/i.test(type ?? ''));
        box.destroy_all_children();
        if (!vpns.length)
            box.add_child(new St.Label({text: 'No VPN connections saved', style: `color: ${theme.muted}; padding: 8px;`}));
        for (const [name, , device] of vpns) {
            const active = device && device !== '--';
            box.add_child(actionRow(bar, 'network-vpn-symbolic', active ? `${name}  ·  connected` : name, () => {
                try {
                    Gio.Subprocess.new(['nmcli', 'connection', active ? 'down' : 'up', name], Gio.SubprocessFlags.NONE);
                } catch (error) {
                    console.warn(`Bezel: VPN ${name}: ${error.message}`);
                }
            }));
        }
        box.add_child(actionRow(bar, 'preferences-system-network-symbolic', 'Network Settings', () => openSettings('network')));
    });
    return box;
}
