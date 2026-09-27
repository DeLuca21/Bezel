import {switchOn} from './config.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const devices = {output: 'Sound output', network: 'Wi-Fi', bluetooth: 'Bluetooth'};
function controlFor(id) {
    const quick = Main.panel.statusArea.quickSettings;
    return id === 'output' ? quick?._volumeOutput?.quickSettingsItems?.[0]
        : id === 'network' ? quick?._network?._wirelessToggle : quick?._bluetooth?.quickSettingsItems?.[0];
}
export function deviceAvailable(id) {
    const control = controlFor(id);
    return Boolean(control?.menu && (id === 'output' || control.visible));
}

export function activateDeviceControl(id, control) {
    if (!control?.reactive) return;
    if (id === 'network' && control._client)
        control._client.wireless_enabled = !control._client.wireless_enabled;
    else if (id === 'bluetooth' && control._client?.toggleActive)
        control._client.toggleActive();
    else if (typeof control.activate === 'function') control.activate();
    else control.emit('clicked');
}

// Each mount returns borrowed GNOME actors before destroying its own children.
// This applies equally to tab switches, popup close, and extension teardown.
export function buildDevicePanel(bar, id, options = null) {
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;', x_expand: true});
    const control = controlFor(id);
    if (!deviceAvailable(id)) {
        root.add_child(new St.Label({text: `${devices[id]} unavailable`, style: `color: ${bar._theme.muted};`}));
        return root;
    }
    const menu = control.menu;
    menu.close(PopupAnimation.NONE);
    const list = menu.box;
    const parent = list.get_parent();
    const position = parent.get_children().indexOf(list);
    const style = list.get_style();
    const opacity = list.opacity;
    parent.remove_child(list);
    list.opacity = 255;
    list.set_style(`background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; border-radius: 14px; padding: 10px;`);
    const signals = [];
    const module = bar._state.modules.find(item => item.id === id) || {id, ...options};
    if (id !== 'output' && switchOn(module, bar._state, 'showToggle')) {
        const toggle = new St.Button({can_focus: true, style_class: 'bezel-action', x_expand: true, style: `padding: 12px 10px; border-radius: 14px; background-color: ${bar._theme.surface}; color: ${bar._theme.fg};`});
        const sync = () => { toggle.label = `${devices[id]} · ${control.checked ? 'On' : 'Off'}`; toggle.reactive = control.reactive; };
        for (const signal of ['notify::checked', 'notify::reactive']) signals.push(control.connect(signal, sync));
        toggle.connect('clicked', () => {
            if (!control.reactive) return;
            activateDeviceControl(id, control);
            sync();
        });
        sync(); root.add_child(toggle);
    }
    const host = new St.ScrollView({overlay_scrollbars: true, x_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, height: 160});
    host.set_child(list); root.add_child(host);
    let timer = 0;
    let released = false;
    const fit = () => {
        timer = 0;
        if (released || !host.get_stage()) return GLib.SOURCE_REMOVE;
        let bottom = 0;
        for (const child of list.get_children())
            if (child.visible && child.height > 4) bottom = Math.max(bottom, child.y + child.height);
        const height = Math.min(220, Math.max(64, (bottom || 56) + 12));
        if (Math.abs(host.height - height) > 2) { host.height = height; bar._fitPopup(); }
        return GLib.SOURCE_REMOVE;
    };
    const queueFit = () => { if (!timer && !released) timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, fit); };
    const allocation = list.connect('notify::allocation', queueFit);
    const quick = Main.panel.statusArea.quickSettings;
    const nativeOpen = quick.menu.connect('open-state-changed', (_menu, open) => { if (open) bar._close(); });
    if (id === 'network') control._startScanning?.();
    if (id === 'bluetooth') control._reorderDeviceItems?.();
    const release = () => {
        if (released) return;
        released = true;
        if (timer) GLib.source_remove(timer);
        timer = 0;
        list.disconnect(allocation);
        quick.menu.disconnect(nativeOpen);
        signals.forEach(signal => control.disconnect(signal));
        if (id === 'network') control._stopScanning?.();
        list.get_parent()?.remove_child(list);
        list.set_style(style); list.opacity = opacity;
        parent.insert_child_at_index(list, position);
    };
    root.connect('destroy', release);
    bar._popupCleanups.push(release);
    queueFit();
    return root;
}

export function groupTabStyle(theme, selected) {
    return `padding: 12px 10px; border-radius: 12px; background-color: ${selected ? theme.accent : theme.surface}; color: ${selected ? theme.bg : theme.fg};`;
}

export function buildDeviceControls(bar) {
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
    const tabs = new St.BoxLayout({style: 'spacing: 6px;'});
    const body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
    root.add_child(tabs); root.add_child(body);
    const entries = Object.keys(devices).filter(deviceAvailable);
    const buttons = [];
    let cleanup = [];
    const clear = () => { cleanup.splice(0).forEach(fn => fn()); body.destroy_all_children(); };
    const select = index => {
        if (!entries[index]) return;
        clear();
        buttons.forEach((button, i) => button.set_style(groupTabStyle(bar._theme, i === index)));
        const start = bar._popupCleanups.length;
        body.add_child(buildDevicePanel(bar, entries[index]));
        cleanup = bar._popupCleanups.splice(start);
    };
    entries.forEach((id, index) => {
        const button = new St.Button({label: devices[id], can_focus: true, x_expand: true});
        button.connect('clicked', () => select(index)); buttons.push(button); tabs.add_child(button);
    });
    bar._popupCleanups.push(clear);
    root.connect('destroy', () => cleanup.splice(0).forEach(fn => fn()));
    root._selectDeviceTab = select;
    if (entries.length) select(0);
    else root.add_child(new St.Label({text: 'No device controls available'}));
    return root;
}
