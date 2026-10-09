import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {openSettings, dndControl, nightLightControl} from './tools.js';
import {filePreview} from './launcherProviders.js';

export const GNOME_PICKERS = {
    wifi: {collection: 'wifi', detail: 'Browse nearby networks'},
    bluetooth: {collection: 'bluetooth', detail: 'Connect paired devices'},
    background: {collection: 'appearance', detail: 'Colour scheme, accent and wallpaper'},
    sound: {collection: 'sound', detail: 'Choose output or input'},
    power: {collection: 'power', detail: 'Choose a power profile'},
    keyboard: {collection: 'keyboard', detail: 'Switch keyboard layout'},
    network: {collection: 'vpn', detail: 'Connect a VPN'},
    notifications: {collection: 'notifications', detail: 'Do Not Disturb and banners'},
    'universal-access': {collection: 'accessibility', detail: 'Large text, contrast and assistive features'},
    multitasking: {collection: 'multitasking', detail: 'Workspaces, hot corners and tiling'},
    mouse: {collection: 'mouse', detail: 'Pointer, touchpad and scrolling'},
    display: {collection: 'displays', detail: 'Night Light'},
    datetime: {collection: 'datetime', detail: 'Clock format'},
};

export const GNOME_PARENT = {
    output: 'sound', input: 'sound',
    scheme: 'appearance', accent: 'appearance', wallpaper: 'appearance',
    touchpad: 'mouse', pointer: 'mouse',
};
export const GNOME_NESTED = new Set([...Object.values(GNOME_PICKERS).map(item => item.collection),
    'wallpaper', 'output', 'input', 'scheme', 'accent', 'touchpad', 'pointer']);
export const BEZEL_NESTED = new Set(['themes', 'layouts']);
export const TAB_COLLECTIONS = new Set(['settings', 'gnome']);
export const LIVE_COLLECTIONS = new Set(['wifi', 'bluetooth', 'sound', 'output', 'input', 'power', 'vpn', 'keyboard',
    'appearance', 'scheme', 'accent', 'notifications', 'accessibility', 'multitasking', 'mouse', 'touchpad', 'pointer',
    'datetime', 'displays']);

const POWER_PROFILES = [
    ['power-saver', 'Power Saver', 'power-profile-power-saver-symbolic'],
    ['balanced', 'Balanced', 'power-profile-balanced-symbolic'],
    ['performance', 'Performance', 'power-profile-performance-symbolic'],
];

const schemaCache = new Map();
let vpnCache = null;
let vpnError = null;
let powerProxy = null;
let powerIface = '';

function schema(id) {
    if (schemaCache.has(id))
        return schemaCache.get(id);
    let settings = null;
    try {
        if (Gio.SettingsSchemaSource.get_default().lookup(id, true))
            settings = new Gio.Settings({schema_id: id});
    } catch { /* Schema missing on this host. */ }
    schemaCache.set(id, settings);
    return settings;
}

function panelAction(panel, label = 'Settings') {
    return {alternate: () => openSettings(panel), alternateLabel: label};
}

function unavailable(name, panel, icon) {
    const open = () => openSettings(panel);
    return [{name: `${name} unavailable`, detail: 'Open Settings to check this feature',
        icon: icon || 'preferences-system-symbolic', run: open, primaryLabel: 'Open settings',
        ...panelAction(panel)}];
}

function flagRow(name, icon, settings, key, panel, {invert = false, doubleOn = null} = {}) {
    if (!settings?.settings_schema.has_key(key))
        return null;
    let on;
    let run;
    if (doubleOn !== null) {
        on = settings.get_double(key) > 1.05;
        run = () => settings.set_double(key, on ? 1.0 : doubleOn);
    } else {
        on = invert ? !settings.get_boolean(key) : settings.get_boolean(key);
        run = () => settings.set_boolean(key, invert ? on : !on);
    }
    return {
        id: `${settings.schema_id}:${key}`, name, icon, selected: on,
        detail: `${on ? 'On' : 'Off'} · Enter to turn ${on ? 'off' : 'on'}`,
        primaryLabel: on ? 'Turn off' : 'Turn on', run, keepOpen: true, ...panelAction(panel),
    };
}

function enumRows(settings, key, choices, panel, icon) {
    if (!settings?.settings_schema.has_key(key))
        return [];
    const current = settings.get_string(key);
    return choices.map(([value, name, itemIcon]) => ({
        id: `${key}:${value}`, name, icon: itemIcon || icon, selected: current === value,
        detail: current === value ? 'Selected' : 'Select',
        primaryLabel: current === value ? 'Selected' : 'Use',
        run: () => settings.set_string(key, value), keepOpen: true, ...panelAction(panel),
    }));
}

function controlRow(name, icon, control, panel) {
    if (!control)
        return null;
    const on = control.active();
    return {
        name, icon, selected: on, detail: `${on ? 'On' : 'Off'} · Enter to turn ${on ? 'off' : 'on'}`,
        primaryLabel: on ? 'Turn off' : 'Turn on', run: () => control.toggle(), keepOpen: true,
        ...panelAction(panel),
    };
}

function accentChoices(settings) {
    const names = {
        blue: 'Blue', teal: 'Teal', green: 'Green', yellow: 'Yellow', orange: 'Orange',
        red: 'Red', pink: 'Pink', purple: 'Purple', slate: 'Slate',
    };
    try {
        const unpacked = settings?.settings_schema.get_key('accent-color').get_range().deepUnpack();
        if (unpacked[0] === 'enum')
            return unpacked[1].map(id => [id, names[id] || id[0].toUpperCase() + id.slice(1)]);
    } catch { /* Fall back to the common GNOME accents. */ }
    return Object.entries(names);
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

// Use GNOME's existing network objects so authentication and enterprise-network
// setup keep their native flows. Never borrow or reparent the native menu actors.
export function deviceResults(kind, quick = Main.panel.statusArea.quickSettings) {
    const panel = kind === 'wifi' ? 'wifi' : 'bluetooth';
    const settings = () => openSettings(panel);
    const secondary = panelAction(panel);
    const missing = name => unavailable(name, panel, kind === 'wifi' ? 'network-wireless-symbolic' : 'bluetooth-symbolic');
    if (kind === 'wifi') {
        const toggle = quick?._network?._wirelessToggle;
        const client = toggle?._client;
        if (!client || !toggle._items?.size) return missing('Wi-Fi');
        if (!client.wireless_enabled) return [{name: 'Turn on Wi-Fi', detail: client.wireless_hardware_enabled === false
            ? 'Blocked by the hardware switch' : 'Show nearby networks', icon: 'network-wireless-symbolic',
            run: () => { if (client.wireless_hardware_enabled !== false) client.wireless_enabled = true; },
            keepOpen: true, ...secondary}];
        const rows = [];
        for (const [device, section] of toggle._items) {
            for (const network of section._networkItems?.keys() ?? []) {
                if (!network.hasAccessPoints?.()) continue;
                rows.push({id: `wifi:${device.get_iface?.()}:${network.name}:${network.secure}`, name: network.name,
                    selected: network.is_active,
                    detail: `${network.is_active ? 'Connected' : network.secure ? 'Secured' : 'Open network'} · ${network.signal_strength}%${toggle._items.size > 1 ? ` · ${device.get_iface()}` : ''}`,
                    icon: network.icon_name || 'network-wireless-symbolic', primaryLabel: network.is_active ? 'Settings' : 'Connect',
                    run: () => {
                        if (!section._networkItems.has(network)) throw new Error('This network is no longer available');
                        if (network.is_active) settings(); else network.activate();
                    }, ...secondary});
            }
        }
        return rows.length ? rows : [{name: 'Scanning for networks…', detail: 'Open Settings for hidden networks',
            icon: 'network-wireless-symbolic', run: settings, ...secondary}];
    }
    const client = quick?._bluetooth?.quickSettingsItems?.[0]?._client;
    if (!client?.available) return missing('Bluetooth');
    if (!client.active) return [{name: 'Turn on Bluetooth', detail: 'Show paired devices', icon: 'bluetooth-symbolic',
        run: () => client.toggleActive(), keepOpen: true, ...secondary}];
    const rows = [...(client.getDevices?.() ?? [])].filter(device => device.connectable).map(device => ({
        id: device.get_object_path(), name: device.alias || device.name, selected: device.connected,
        detail: device.connected ? 'Connected · Disconnect' : 'Paired · Connect', icon: device.icon || 'bluetooth-symbolic',
        primaryLabel: device.connected ? 'Disconnect' : 'Connect', run: () => client.toggleDevice(device), ...secondary,
    }));
    rows.push({name: 'Pair a new device', detail: 'Discover and pair in Bluetooth Settings', icon: 'list-add-symbolic',
        primaryLabel: 'Open settings', run: settings, ...secondary});
    return rows;
}

function soundIndex(mixer) {
    const secondary = panelAction('sound', 'Sound settings');
    return [
        {name: 'Sound output', collection: 'output', icon: 'audio-speakers-symbolic',
            keywords: 'sound output speaker headphones playback audio sink',
            detail: mixer?.get_default_sink?.()?.get_description?.() || 'Choose a playback device',
            primaryLabel: 'Browse', ...secondary},
        {name: 'Sound input', collection: 'input', icon: 'audio-input-microphone-symbolic',
            keywords: 'sound input microphone mic recording source',
            detail: mixer?.get_default_source?.()?.get_description?.() || 'Choose a recording device',
            primaryLabel: 'Browse', ...secondary},
    ];
}

export function audioResults(mixer, input = false) {
    const secondary = panelAction('sound', 'Sound settings');
    if (!mixer)
        return unavailable('Sound', 'sound', input ? 'audio-input-microphone-symbolic' : 'audio-volume-high-symbolic');
    const rows = [];
    const stream = input ? mixer.get_default_source?.() : mixer.get_default_sink?.();
    if (stream?.change_is_muted) {
        const muted = stream.is_muted;
        rows.push({
            id: `mute:${input ? 'input' : 'output'}`, name: input ? 'Mute input' : 'Mute output',
            icon: muted
                ? (input ? 'microphone-sensitivity-muted-symbolic' : 'audio-volume-muted-symbolic')
                : (input ? 'audio-input-microphone-symbolic' : 'audio-volume-high-symbolic'),
            selected: muted,
            detail: muted ? 'Muted · Enter to unmute' : 'On · Enter to mute',
            primaryLabel: muted ? 'Unmute' : 'Mute',
            run: () => stream.change_is_muted(!stream.is_muted), keepOpen: true, ...secondary,
        });
    }
    const current = input ? mixer.get_default_source?.() : mixer.get_default_sink?.();
    for (const device of (input ? mixer.get_sources?.() : mixer.get_sinks?.()) ?? []) {
        if (device.is_virtual) continue;
        const selected = device === current;
        rows.push({
            id: `${input ? 'input' : 'output'}:${device.get_name?.() || device.get_id?.() || device.get_description?.()}`,
            name: device.get_description?.() || device.get_name?.() || (input ? 'Input' : 'Output'),
            selected,
            detail: selected ? 'Selected' : 'Select',
            icon: input ? 'audio-input-microphone-symbolic' : 'audio-speakers-symbolic',
            primaryLabel: selected ? 'Selected' : 'Use',
            run: () => {
                if (input) mixer.set_default_source(device);
                else mixer.set_default_sink(device);
            }, keepOpen: true, ...secondary,
        });
    }
    if (!input) {
        const over = flagRow('Allow volume above 100%', 'audio-volume-overamplified-symbolic',
            schema('org.gnome.desktop.sound'), 'allow-volume-above-100-percent', 'sound');
        if (over) rows.push(over);
    }
    return rows.length ? rows : unavailable('Sound', 'sound', input ? 'audio-input-microphone-symbolic' : 'audio-volume-high-symbolic');
}

export function powerResults() {
    const secondary = panelAction('power', 'Power settings');
    if (!powerProxy?.get_name_owner?.())
        return [{name: powerProxy === null ? 'Reading power profiles…' : 'Power profiles unavailable',
            detail: 'Open Power settings', icon: 'power-profile-balanced-symbolic',
            run: () => openSettings('power'), primaryLabel: 'Open settings', ...secondary}];
    const active = powerProxy.get_cached_property('ActiveProfile')?.unpack() ?? '';
    const supported = powerProxy.get_cached_property('Profiles')?.recursiveUnpack() ?? [];
    return POWER_PROFILES.filter(([id]) => supported.some(profile => profile.Profile === id)).map(([id, name, icon]) => ({
        id, name, icon, selected: active === id, detail: active === id ? 'Selected' : 'Select',
        primaryLabel: active === id ? 'Selected' : 'Use',
        run: () => new Promise((resolve, reject) => powerProxy.call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [powerIface, 'ActiveProfile', GLib.Variant.new_string(id)]),
            Gio.DBusCallFlags.NONE, 3000, null, (proxy, result) => {
                try { proxy.call_finish(result); resolve(); } catch (error) { reject(error); }
            })),
        keepOpen: true, ...secondary,
    }));
}

export function vpnResults() {
    const secondary = panelAction('network', 'Network settings');
    if (vpnError) return [{name: 'VPN connections unavailable', detail: vpnError,
        icon: 'network-vpn-symbolic', run: () => openSettings('network'), ...secondary}];
    if (!vpnCache)
        return [{name: 'Reading VPN connections…', detail: 'Saved NetworkManager profiles',
            icon: 'network-vpn-symbolic', run: () => openSettings('network'), ...secondary}];
    if (!vpnCache.length)
        return [{name: 'No VPN connections', detail: 'Add a VPN in Network Settings',
            icon: 'network-vpn-symbolic', run: () => openSettings('network'), primaryLabel: 'Open settings', ...secondary}];
    return vpnCache;
}

export function keyboardResults() {
    const secondary = panelAction('keyboard', 'Keyboard settings');
    try {
        const manager = Keyboard.getInputSourceManager?.();
        const sources = manager ? Object.values(manager.inputSources ?? {}) : [];
        if (sources.length < 2)
            return [{name: sources[0]?.displayName || 'Keyboard layout',
                detail: sources.length ? 'Only one layout is configured' : 'Open Settings to add layouts',
                icon: 'input-keyboard-symbolic', run: () => openSettings('keyboard'),
                primaryLabel: 'Open settings', ...secondary}];
        return sources.map(source => ({
            id: source.id, name: source.displayName || source.shortName || source.id,
            selected: source === manager.currentSource,
            detail: source === manager.currentSource ? 'Selected' : 'Select',
            icon: 'input-keyboard-symbolic',
            primaryLabel: source === manager.currentSource ? 'Selected' : 'Use',
            run: () => source.activate?.(true), keepOpen: true, ...secondary,
        }));
    } catch {
        return unavailable('Keyboard', 'keyboard', 'input-keyboard-symbolic');
    }
}

function appearanceIndex() {
    const settings = schema('org.gnome.desktop.interface');
    const secondary = panelAction('background', 'Appearance settings');
    const scheme = settings?.settings_schema.has_key('color-scheme') ? settings.get_string('color-scheme') : '';
    const accent = settings?.settings_schema.has_key('accent-color') ? settings.get_string('accent-color') : '';
    const schemeName = {default: 'Default', 'prefer-dark': 'Dark', 'prefer-light': 'Light'}[scheme] || 'Style';
    const accents = Object.fromEntries(accentChoices(settings));
    return [
        {name: 'Colour scheme', collection: 'scheme', icon: 'weather-clear-night-symbolic',
            keywords: 'appearance colour color scheme dark light style default',
            detail: schemeName, primaryLabel: 'Browse', ...secondary},
        {name: 'Accent colour', collection: 'accent', icon: 'applications-graphics-symbolic',
            keywords: 'appearance accent colour color highlight',
            detail: accents[accent] || 'Choose a colour', primaryLabel: 'Browse', ...secondary},
        {name: 'Wallpaper', collection: 'wallpaper', icon: 'preferences-desktop-wallpaper-symbolic',
            keywords: 'wallpaper background pictures desktop appearance',
            detail: 'Choose from Pictures and system wallpapers', primaryLabel: 'Browse', ...secondary},
    ];
}

function schemeResults() {
    return enumRows(schema('org.gnome.desktop.interface'), 'color-scheme', [
        ['default', 'Default style'], ['prefer-dark', 'Dark style'], ['prefer-light', 'Light style'],
    ], 'background', 'weather-clear-night-symbolic');
}

function accentResults() {
    const settings = schema('org.gnome.desktop.interface');
    return enumRows(settings, 'accent-color', accentChoices(settings), 'background', 'applications-graphics-symbolic');
}

function orOpen(rows, name, panel, icon) {
    return rows.length ? rows : unavailable(name, panel, icon);
}

function notificationResults() {
    const settings = schema('org.gnome.desktop.notifications');
    return orOpen([
        controlRow('Do Not Disturb', 'notifications-disabled-symbolic', dndControl(), 'notifications'),
        flagRow('Show notifications on the lock screen', 'system-lock-screen-symbolic',
            settings, 'show-in-lock-screen', 'notifications'),
    ].filter(Boolean), 'Notifications', 'notifications', 'preferences-system-notifications-symbolic');
}

function accessibilityResults() {
    const apps = schema('org.gnome.desktop.a11y.applications');
    const iface = schema('org.gnome.desktop.a11y.interface');
    const desktop = schema('org.gnome.desktop.interface');
    const wm = schema('org.gnome.desktop.wm.preferences');
    return orOpen([
        flagRow('Large text', 'font-x-generic-symbolic', desktop, 'text-scaling-factor', 'universal-access', {doubleOn: 1.25}),
        flagRow('High contrast', 'video-display-symbolic', iface, 'high-contrast', 'universal-access'),
        flagRow('Screen reader', 'audio-headphones-symbolic', apps, 'screen-reader-enabled', 'universal-access'),
        flagRow('Screen magnifier', 'zoom-in-symbolic', apps, 'screen-magnifier-enabled', 'universal-access'),
        flagRow('On-screen keyboard', 'input-keyboard-symbolic', apps, 'screen-keyboard-enabled', 'universal-access'),
        flagRow('Visual alerts', 'alarm-symbolic', wm, 'visual-bell', 'universal-access'),
    ].filter(Boolean), 'Accessibility', 'universal-access', 'preferences-desktop-accessibility-symbolic');
}

function multitaskingResults() {
    const iface = schema('org.gnome.desktop.interface');
    const mutter = schema('org.gnome.mutter');
    return orOpen([
        flagRow('Hot corner', 'input-touchpad-symbolic', iface, 'enable-hot-corners', 'multitasking'),
        flagRow('Dynamic workspaces', 'view-paged-symbolic', mutter, 'dynamic-workspaces', 'multitasking'),
        flagRow('Workspaces on primary display only', 'video-display-symbolic', mutter, 'workspaces-only-on-primary', 'multitasking'),
        flagRow('Active screen edges', 'view-dual-symbolic', mutter, 'edge-tiling', 'multitasking'),
    ].filter(Boolean), 'Multitasking', 'multitasking', 'preferences-desktop-multitasking-symbolic');
}

function mouseIndex() {
    const secondary = panelAction('mouse', 'Mouse settings');
    return [
        {name: 'Touchpad', collection: 'touchpad', icon: 'input-touchpad-symbolic',
            keywords: 'touchpad tap click natural scroll typing',
            detail: 'Tap to click, scrolling and typing', primaryLabel: 'Browse', ...secondary},
        {name: 'Mouse', collection: 'pointer', icon: 'input-mouse-symbolic',
            keywords: 'mouse pointer natural scroll left handed buttons',
            detail: 'Scrolling and buttons', primaryLabel: 'Browse', ...secondary},
    ];
}

function touchpadResults() {
    const touchpad = schema('org.gnome.desktop.peripherals.touchpad');
    return orOpen([
        flagRow('Touchpad natural scrolling', 'input-touchpad-symbolic', touchpad, 'natural-scroll', 'mouse'),
        flagRow('Tap to click', 'input-touchpad-symbolic', touchpad, 'tap-to-click', 'mouse'),
        flagRow('Disable touchpad while typing', 'input-keyboard-symbolic', touchpad, 'disable-while-typing', 'mouse'),
    ].filter(Boolean), 'Touchpad', 'mouse', 'input-touchpad-symbolic');
}

function pointerResults() {
    const mouse = schema('org.gnome.desktop.peripherals.mouse');
    return orOpen([
        flagRow('Mouse natural scrolling', 'input-mouse-symbolic', mouse, 'natural-scroll', 'mouse'),
        flagRow('Left-handed mouse', 'input-mouse-symbolic', mouse, 'left-handed', 'mouse'),
    ].filter(Boolean), 'Mouse', 'mouse', 'input-mouse-symbolic');
}

function datetimeResults() {
    return orOpen(enumRows(schema('org.gnome.desktop.interface'), 'clock-format', [
        ['24h', '24-hour clock'], ['12h', '12-hour clock'],
    ], ['system', 'datetime'], 'preferences-system-time-symbolic'),
    'Date & Time', ['system', 'datetime'], 'preferences-system-time-symbolic');
}

function displayResults() {
    return orOpen([controlRow('Night Light', 'night-light-symbolic', nightLightControl(), 'display')].filter(Boolean),
        'Displays', 'display', 'video-display-symbolic');
}

export function gnomeSubgroups(mixer) {
    return [...soundIndex(mixer), ...appearanceIndex().filter(item => item.collection !== 'wallpaper'), ...mouseIndex()];
}

export function gnomePicker(kind, {quick, mixer} = {}) {
    if (kind === 'wifi' || kind === 'bluetooth')
        return deviceResults(kind, quick ?? Main.panel.statusArea.quickSettings);
    if (kind === 'sound')
        return soundIndex(mixer);
    if (kind === 'output')
        return audioResults(mixer, false);
    if (kind === 'input')
        return audioResults(mixer, true);
    if (kind === 'power')
        return powerResults();
    if (kind === 'vpn')
        return vpnResults();
    if (kind === 'keyboard')
        return keyboardResults();
    if (kind === 'appearance')
        return appearanceIndex();
    if (kind === 'scheme')
        return schemeResults();
    if (kind === 'accent')
        return accentResults();
    if (kind === 'notifications')
        return notificationResults();
    if (kind === 'accessibility')
        return accessibilityResults();
    if (kind === 'multitasking')
        return multitaskingResults();
    if (kind === 'mouse')
        return mouseIndex();
    if (kind === 'touchpad')
        return touchpadResults();
    if (kind === 'pointer')
        return pointerResults();
    if (kind === 'datetime')
        return datetimeResults();
    if (kind === 'displays')
        return displayResults();
    return [];
}

function snapshot(kind, options) {
    return JSON.stringify(gnomePicker(kind, options).map(item => [item.id, item.name, item.detail, item.collection, item.selected]));
}

function watchPower(changed, cancellable) {
    const cleanups = [];
    const load = (name, path, iface, fallback) => {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            name, path, iface, cancellable, (_source, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (cancellable.is_cancelled()) return;
                    if (!proxy.get_name_owner()) throw new Error('no owner');
                    powerProxy = proxy;
                    powerIface = iface;
                    const id = proxy.connect('g-properties-changed', changed);
                    cleanups.push(() => { try { proxy.disconnect(id); } catch { /* Proxy already gone. */ } });
                    changed();
                } catch {
                    if (!cancellable.is_cancelled() && fallback) fallback();
                    else if (!cancellable.is_cancelled()) {
                        powerProxy = false;
                        changed();
                    }
                }
            });
    };
    load('org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles',
        'org.freedesktop.UPower.PowerProfiles',
        () => load('net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles'));
    return () => {
        for (const stop of cleanups) stop();
        powerProxy = null;
        powerIface = '';
    };
}

function watchVpn(changed, cancellable) {
    let pending = false;
    const refresh = () => {
        if (cancellable.is_cancelled() || pending) return;
        let subprocess;
        try {
            subprocess = Gio.Subprocess.new(['nmcli', '-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            vpnError = error.message;
            vpnCache = [];
            changed();
            return;
        }
        pending = true;
        subprocess.communicate_utf8_async(null, cancellable, (_proc, result) => {
            pending = false;
            try {
                const [, text, stderr] = subprocess.communicate_utf8_finish(result);
                if (cancellable.is_cancelled()) return;
                if (!subprocess.get_successful()) throw new Error(stderr.trim() || 'Could not read VPN connections');
                vpnError = null;
                vpnCache = text.split('\n').map(splitNmcli).filter(([, , type]) => /vpn|wireguard|tun/i.test(type ?? ''))
                    .map(([name, uuid, , device]) => {
                        const active = device && device !== '--';
                        return {
                            id: `vpn:${uuid}`, name, selected: active,
                            detail: active ? 'Connected · Disconnect' : 'Disconnected · Connect',
                            icon: 'network-vpn-symbolic', primaryLabel: active ? 'Disconnect' : 'Connect',
                            pendingLabel: active ? 'Disconnecting…' : 'Connecting…',
                            run: () => new Promise((resolve, reject) => {
                                const process = Gio.Subprocess.new(['nmcli', '--wait', '30', 'connection', active ? 'down' : 'up', 'uuid', uuid],
                                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                                process.communicate_utf8_async(null, null, (proc, result) => {
                                    try {
                                        const [, , stderr] = proc.communicate_utf8_finish(result);
                                        if (!proc.get_successful()) throw new Error(stderr.trim() || 'VPN action failed');
                                        resolve();
                                        refresh();
                                    } catch (error) { reject(error); }
                                });
                            }),
                            keepOpen: true, ...panelAction('network', 'Network settings'),
                        };
                    });
                changed();
            } catch (error) {
                if (!cancellable.is_cancelled()) {
                    vpnError = error.message;
                    vpnCache = [];
                    changed();
                }
            }
        });
    };
    refresh();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
        refresh();
        return cancellable.is_cancelled() ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
    });
    return () => GLib.source_remove(timer);
}

function watchKeyboard(changed) {
    try {
        const manager = Keyboard.getInputSourceManager?.();
        if (!manager) return () => {};
        const ids = ['current-source-changed', 'sources-changed'].flatMap(name => {
            try { return [manager.connect(name, changed)]; } catch { return []; }
        });
        return () => ids.forEach(id => manager.disconnect(id));
    } catch {
        return () => {};
    }
}

function watchSchemas(entries, changed) {
    const ids = [];
    for (const [settings, signal] of entries) {
        if (!settings) continue;
        ids.push([settings, settings.connect(signal, changed)]);
    }
    return () => ids.forEach(([settings, id]) => settings.disconnect(id));
}

export function watchLauncherDevices(kind, changed, options = {}) {
    const quick = options.quick ?? Main.panel.statusArea.quickSettings;
    const mixer = options.mixer;
    let cancelled = false;
    const guarded = () => { if (!cancelled) changed(); };
    const cancellable = new Gio.Cancellable();
    const stop = [];
    if (['sound', 'output', 'input'].includes(kind)) {
        if (mixer) {
            let streamSignals = [];
            const bindStreams = () => {
                streamSignals.forEach(([stream, id]) => stream.disconnect(id));
                streamSignals = [];
                for (const stream of [mixer.get_default_sink?.(), mixer.get_default_source?.()]) {
                    if (stream?.connect) streamSignals.push([stream, stream.connect('notify::is-muted', guarded)]);
                }
            };
            bindStreams();
            stop.push(() => streamSignals.forEach(([stream, id]) => stream.disconnect(id)));
            for (const name of ['default-sink-changed', 'default-source-changed', 'stream-added', 'stream-removed']) {
                try {
                    const id = mixer.connect(name, () => { bindStreams(); guarded(); });
                    stop.push(() => mixer.disconnect(id));
                } catch { /* Mixer API varies. */ }
            }
        }
        stop.push(watchSchemas([[schema('org.gnome.desktop.sound'), 'changed']], guarded));
    } else if (kind === 'wifi' || kind === 'bluetooth') {
        let ticks = 0, signature = '';
        const update = () => {
            if (cancelled) return GLib.SOURCE_REMOVE;
            if (kind === 'wifi' && ticks++ % 10 === 0) {
                const toggle = quick?._network?._wirelessToggle;
                if (toggle?._client?.wireless_enabled) for (const device of toggle._items?.keys() ?? []) {
                    device.request_scan_async(cancellable, (source, result) => {
                        try { source.request_scan_finish(result); } catch { /* Cached networks remain usable. */ }
                    });
                }
            }
            const next = snapshot(kind, {quick, mixer});
            if (signature && next !== signature) changed();
            signature = next;
            return GLib.SOURCE_CONTINUE;
        };
        update();
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, update);
        stop.push(() => GLib.source_remove(timer));
    } else if (kind === 'power')
        stop.push(watchPower(guarded, cancellable));
    else if (kind === 'vpn')
        stop.push(watchVpn(guarded, cancellable));
    else if (kind === 'keyboard')
        stop.push(watchKeyboard(guarded));
    else if (['appearance', 'scheme', 'accent'].includes(kind))
        stop.push(watchSchemas([[schema('org.gnome.desktop.interface'), 'changed']], guarded));
    else if (kind === 'notifications')
        stop.push(watchSchemas([[schema('org.gnome.desktop.notifications'), 'changed']], guarded));
    else if (kind === 'accessibility') {
        stop.push(watchSchemas([
            [schema('org.gnome.desktop.a11y.applications'), 'changed'],
            [schema('org.gnome.desktop.a11y.interface'), 'changed'],
            [schema('org.gnome.desktop.interface'), 'changed::text-scaling-factor'],
            [schema('org.gnome.desktop.wm.preferences'), 'changed::visual-bell'],
        ], guarded));
    } else if (kind === 'multitasking') {
        stop.push(watchSchemas([
            [schema('org.gnome.desktop.interface'), 'changed::enable-hot-corners'],
            [schema('org.gnome.mutter'), 'changed'],
        ], guarded));
    } else if (['mouse', 'touchpad', 'pointer'].includes(kind)) {
        stop.push(watchSchemas([
            [schema('org.gnome.desktop.peripherals.touchpad'), 'changed'],
            [schema('org.gnome.desktop.peripherals.mouse'), 'changed'],
        ], guarded));
    } else if (kind === 'datetime')
        stop.push(watchSchemas([[schema('org.gnome.desktop.interface'), 'changed::clock-format']], guarded));
    else if (kind === 'displays')
        stop.push(watchSchemas([[schema('org.gnome.settings-daemon.plugins.color'), 'changed::night-light-enabled']], guarded));
    return () => {
        cancelled = true;
        cancellable.cancel();
        for (const fn of stop) fn();
    };
}

export async function wallpaperResults(cancellable) {
    const paths = ['/usr/share/backgrounds', GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES)].filter(Boolean);
    const queue = paths.map(path => [Gio.File.new_for_path(path), 0]);
    const rows = [], seen = new Set();
    let currentUri = '';
    try { currentUri = new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri'); } catch { /* Schema missing. */ }
    let visited = 0;
    while (queue.length && visited < 3000 && !cancellable.is_cancelled()) {
        const [folder, depth] = queue.shift();
        if (seen.has(folder.get_uri())) continue;
        seen.add(folder.get_uri());
        let enumerator;
        try {
            enumerator = await new Promise((resolve, reject) => folder.enumerate_children_async(
                'standard::name,standard::type,standard::is-symlink,standard::icon,standard::content-type,standard::size,thumbnail::path', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                    try { resolve(source.enumerate_children_finish(result)); } catch (error) { reject(error); }
                }));
            while (!cancellable.is_cancelled()) {
                const batch = await new Promise((resolve, reject) => enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable,
                    (source, result) => { try { resolve(source.next_files_finish(result)); } catch (error) { reject(error); } }));
                if (!batch.length) break;
                for (const info of batch) {
                    if (++visited > 3000) break;
                    const name = info.get_name(), file = folder.get_child(name);
                    if (name.startsWith('.') || info.get_is_symlink()) continue;
                    if (info.get_file_type() === Gio.FileType.DIRECTORY && depth < 3) queue.push([file, depth + 1]);
                    else if (info.get_file_type() === Gio.FileType.REGULAR && /\.(jpe?g|png|webp|svg)$/i.test(name))
                        rows.push({id: file.get_uri(), name, detail: file.get_path(), icon: 'preferences-desktop-wallpaper-symbolic',
                            selected: file.get_uri() === currentUri, ...filePreview(info, file),
                            primaryLabel: 'Set wallpaper', keepOpen: true, run: () => {
                                const uri = file.get_uri();
                                const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
                                background.set_string('picture-uri', uri);
                                background.set_string('picture-uri-dark', uri);
                                for (const row of rows) row.selected = row.id === uri;
                            }, ...panelAction('background', 'Appearance settings')});
                }
                if (visited >= 3000) break;
            }
        } catch { /* Missing/unreadable folders do not hide other wallpapers. */ }
        finally { enumerator?.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => { try { source.close_finish(result); } catch {} }); }
    }
    return rows;
}
