import Gio from 'gi://Gio';

// Same names GNOME Settings uses: Mutter's display-name on each connector.

function unpack(value) {
    if (value == null)
        return value;
    return typeof value.deep_unpack === 'function' ? value.deep_unpack() : value;
}

function mutterDisplays() {
    try {
        const reply = Gio.DBus.session.call_sync(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'GetCurrentState',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            1500,
            null);
        const [, monitors, logical] = reply.deep_unpack();
        const names = new Map();
        for (const entry of monitors ?? []) {
            const spec = entry[0];
            const connector = unpack(Array.isArray(spec) ? spec[0] : spec);
            const props = (Array.isArray(spec) ? entry[2] : entry[4]) ?? {};
            names.set(connector, unpack(props['display-name']) || connector);
        }
        const displays = [];
        for (const entry of logical ?? []) {
            const connector = unpack(entry[5]?.[0]?.[0]);
            if (!connector)
                continue;
            displays.push({
                connector,
                name: names.get(connector) || connector,
                primary: Boolean(unpack(entry[4])),
                x: unpack(entry[0]),
                y: unpack(entry[1]),
            });
        }
        displays.sort((a, b) => a.x - b.x || a.y - b.y);
        displays.forEach((item, index) => { item.number = index + 1; });
        return displays;
    } catch {
        return [];
    }
}

function gdkDisplays(display) {
    const list = display?.get_monitors?.();
    if (!list)
        return [];
    const displays = [];
    for (let i = 0; i < list.get_n_items(); i++) {
        const monitor = list.get_item(i);
        const connector = monitor.get_connector?.() || `display-${i}`;
        const name = monitor.get_description?.()
            || [monitor.get_manufacturer?.(), monitor.get_model?.()].filter(Boolean).join(' ')
            || connector;
        const geometry = monitor.get_geometry?.();
        displays.push({
            connector,
            name,
            number: i + 1,
            primary: i === 0,
            x: geometry?.x ?? 0,
            y: geometry?.y ?? 0,
        });
    }
    return displays;
}

export function listDisplays(fallbackDisplay = null) {
    const listed = mutterDisplays();
    return listed.length ? listed : gdkDisplays(fallbackDisplay);
}

export function displayLabel(display) {
    if (!display)
        return '';
    return display.name ? `${display.number}  ${display.name}` : display.connector;
}

export function preferredDisplay(displays, connector) {
    if (connector) {
        const match = displays.find(item => item.connector === connector);
        if (match)
            return match;
    }
    return displays.find(item => item.primary) ?? displays[0] ?? null;
}
