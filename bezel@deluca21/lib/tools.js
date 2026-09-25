import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const PANELS = [
    ['Wi-Fi', 'network-wireless-symbolic', 'wifi'],
    ['Network', 'network-wired-symbolic', 'network'],
    ['Bluetooth', 'bluetooth-symbolic', 'bluetooth'],
    ['Appearance', 'preferences-desktop-appearance-symbolic', 'appearance'],
    ['Notifications', 'preferences-system-notifications-symbolic', 'notifications'],
    ['Sound', 'audio-volume-high-symbolic', 'sound'],
    ['Power', 'power-profile-balanced-symbolic', 'power'],
    ['Displays', 'video-display-symbolic', 'display'],
    ['Mouse & Touchpad', 'input-mouse-symbolic', 'mouse'],
    ['Keyboard', 'input-keyboard-symbolic', 'keyboard'],
    ['Privacy', 'preferences-system-privacy-symbolic', 'privacy'],
    ['Users', 'system-users-symbolic', 'system'],
    ['Date & Time', 'preferences-system-time-symbolic', 'datetime'],
    ['Search', 'system-search-symbolic', 'search'],
    ['Apps', 'view-app-grid-symbolic', 'applications'],
    ['About', 'help-about-symbolic', 'info-overview'],
];

export function settingsPanels() {
    return PANELS.map(([name, icon, panel]) => ({name, icon, panel, detail: 'Open Settings', keywords: `settings gnome control ${name}`}));
}

export function openSettings(panel) {
    try {
        Gio.Subprocess.new(['gnome-control-center', ...(panel ? [panel] : [])], Gio.SubprocessFlags.NONE);
    } catch (error) {
        console.warn(`Bezel: could not open Settings: ${error.message}`);
    }
}

export async function openScreenshot() {
    const screenshot = await import('resource:///org/gnome/shell/ui/screenshot.js');
    screenshot.showScreenshotUI();
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
        return actionRow(bar, 'camera-photo-symbolic', 'Take a screenshot', () => openScreenshot().catch(() => {}));
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
    for (const [name, icon, panel] of PANELS)
        box.add_child(actionRow(bar, icon, name, () => openSettings(panel)));
    return box;
}

const PROFILES = [
    ['power-saver', 'Power Saver', 'power-profile-power-saver-symbolic'],
    ['balanced', 'Balanced', 'power-profile-balanced-symbolic'],
    ['performance', 'Performance', 'power-profile-performance-symbolic'],
];

export function performanceMenu(bar) {
    const theme = bar._theme;
    const box = new St.BoxLayout({orientation: 1, style: 'spacing: 8px;'});
    const status = new St.Label({text: 'Reading power profiles…', style: `color: ${theme.muted}; padding: 8px;`});
    box.add_child(status);
    Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
        'org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles', 'org.freedesktop.UPower.PowerProfiles',
        null, (_source, result) => {
            let proxy;
            let iface = 'org.freedesktop.UPower.PowerProfiles';
            try {
                proxy = Gio.DBusProxy.new_for_bus_finish(result);
                if (!proxy.get_name_owner())
                    throw new Error('no owner');
            } catch {
                Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                    'net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles',
                    null, (_source2, result2) => {
                        try {
                            proxy = Gio.DBusProxy.new_for_bus_finish(result2);
                            iface = 'net.hadess.PowerProfiles';
                            if (!proxy.get_name_owner())
                                throw new Error('no owner');
                            showProfiles(proxy, iface);
                        } catch {
                            status.text = 'Power profiles are not available';
                        }
                    });
                return;
            }
            showProfiles(proxy, iface);
        });
    const showProfiles = (proxy, iface) => {
        const paint = () => {
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
        bar._popupCleanups.push(() => proxy.disconnect(changed));
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
    let subprocess;
    try {
        subprocess = Gio.Subprocess.new(['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show'], Gio.SubprocessFlags.STDOUT_PIPE);
    } catch (error) {
        status.text = 'NetworkManager is not available';
        return box;
    }
    subprocess.communicate_utf8_async(null, null, (_proc, result) => {
        let text = '';
        try {
            [, text] = subprocess.communicate_utf8_finish(result);
        } catch (error) {
            status.text = 'Could not list VPN connections';
            return;
        }
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
