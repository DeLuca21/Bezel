import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Host GNOME's live device lists, retaining its network authentication agent,
// mixer routing and Bluetooth connection state. Return every actor on teardown.
export function buildDeviceControls(bar) {
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
    const tabs = new St.BoxLayout({style: 'spacing: 6px;'});
    const body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
    root.add_child(tabs);
    root.add_child(body);
    const quick = Main.panel.statusArea.quickSettings;
    const entries = [
        ['Output', quick?._volumeOutput?.quickSettingsItems?.[0]],
        ['Wi-Fi', quick?._network?._wirelessToggle],
        ['Bluetooth', quick?._bluetooth?.quickSettingsItems?.[0]],
    ];
    let release = () => {};
    const buttons = [];
    const select = index => {
        release();
        release = () => {};
        body.destroy_all_children();
        buttons.forEach((button, i) => button.set_style(`padding: 12px 10px; border-radius: 12px; background-color: ${i === index ? bar._theme.accent : bar._theme.surface}; color: ${i === index ? bar._theme.bg : bar._theme.fg};`));
        const [name, control] = entries[index];
        if (!control?.menu || (index !== 0 && !control.visible)) {
            body.add_child(new St.Label({text: `${name} unavailable`, style: `padding: 12px; color: ${bar._theme.muted};`}));
            return;
        }
        const menu = control.menu;
        menu.close(PopupAnimation.NONE);
        const list = menu.box;
        const parent = list.get_parent();
        const position = parent.get_children().indexOf(list);
        const style = list.get_style();
        const opacity = list.opacity;
        list.opacity = 255;
        parent.remove_child(list);
        list.set_style(`background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; border-radius: 14px; padding: 10px;`);
        if (index !== 0) {
            const toggle = new St.Button({can_focus: true, style_class: 'bezel-action', style: 'padding: 12px 10px;'});
            const sync = () => {
                toggle.label = `${name} · ${control.checked ? 'On' : 'Off'}`;
                toggle.reactive = control.reactive;
            };
            const signals = ['notify::checked', 'notify::reactive'].map(name => control.connect(name, sync));
            toggle.connect('clicked', () => control.emit('clicked'));
            toggle.connect('destroy', () => signals.forEach(signal => control.disconnect(signal)));
            sync();
            body.add_child(toggle);
        }
        body.add_child(hostBorrowedList(bar, list));

        if (index === 1) control._startScanning?.();
        if (index === 2) control._reorderDeviceItems?.();
        release = () => {
            if (index === 1) control._stopScanning?.();
            list.get_parent()?.remove_child(list);
            list.set_style(style);
            list.opacity = opacity;
            parent.insert_child_at_index(list, position);
        };
    };
    entries.forEach(([name], index) => {
        const button = new St.Button({label: name, can_focus: true, x_expand: true});
        button.connect('clicked', () => select(index));
        buttons.push(button);
        tabs.add_child(button);
    });
    // Opening the native menu must first return the borrowed content.
    const nativeOpen = quick?.menu.connect('open-state-changed', (_menu, open) => {
        if (open) bar._close();
    });
    bar._popupCleanups.push(() => {
        release();
        release = () => {};
        if (nativeOpen) quick.menu.disconnect(nativeOpen);
    });
    root._selectDeviceTab = select;
    select(0);
    return root;
}

// Native QS menus report the full panel height. Measure visible rows and scroll
// the overflow so the drawer can hug the controls above.
function hostBorrowedList(bar, list, max = 220) {
    const host = new St.ScrollView({
        style_class: 'bezel-popout-scroll', overlay_scrollbars: true,
        hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.NEVER, x_expand: true,
    });
    host.set_child(list);
    const fit = () => {
        if (!host.get_parent() || !host.contains(list))
            return;
        let bottom = 0;
        for (const child of list.get_children()) {
            if (child.visible && child.height > 4)
                bottom = Math.max(bottom, child.y + child.height);
        }
        const next = Math.min(max, Math.max(64, (bottom || 56) + 12));
        if (!host.height_set || Math.abs(host.height - next) > 2) {
            host.height = next;
            bar._fitPopup();
        }
    };
    const signal = list.connect('notify::allocation', () => bar._later('_deviceListFitId', 30, fit));
    bar._popupCleanups.push(() => {
        try {
            list.disconnect(signal);
        } catch {
        }
    });
    bar._later('_deviceListFitId', 30, fit);
    return host;
}
