import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gio from 'gi://Gio';
import {dndControl, darkStyleControl, nightLightControl, openSettings, settingsPanels} from './tools.js';
import {calculate, convertUnits, filterMatches, webSearch} from './search.js';

function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

export function buildLauncher(bar) {
    const theme = bar._theme;
    const system = Shell.AppSystem.get_default();
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
    const heading = new St.Label({text: 'Launcher', style: `color: ${theme.accent}; font-size: 18px;`});
    const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 4px;'});
    const hint = new St.Label({text: 'Math · 12 km to mi · !g !yt !r !w !gh', style: `color: ${theme.muted}; font-size: 11px;`});
    const entry = new St.Entry({hint_text: 'Search apps, settings, or toggles…', can_focus: true, track_hover: true,
        style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 16px; padding: 12px;`});
    entry.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 18}));
    const header = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px; padding-bottom: 4px;'});
    header.add_child(heading);
    header.add_child(entry);
    root.add_child(list);
    root.add_child(hint);
    root._bezelHeader = header;
    let selected = 0;
    let matches = [];
    const actions = [
        {name: 'GNOME Overview', detail: 'Windows and workspaces', icon: 'view-paged-symbolic', run: () => Main.overview.show()},
        {name: 'GNOME Applications', detail: 'Open the app grid', icon: 'view-app-grid-symbolic', run: () => Main.overview.showApps()},
        {name: 'Customize Bezel', detail: 'Layouts, launcher and appearance', icon: 'preferences-system-symbolic', keywords: 'bezel preferences settings', run: () => bar._overlay.openPreferences()},
    ];
    const toggles = [
        {name: 'Do Not Disturb', icon: 'notifications-disabled-symbolic', keywords: 'dnd notifications quiet banners', control: dndControl()},
        {name: 'Night Light', icon: 'night-light-symbolic', keywords: 'night light blue warm color', control: nightLightControl()},
        {name: 'Dark style', icon: 'weather-clear-night-symbolic', keywords: 'dark style theme appearance', control: darkStyleControl()},
    ].filter(item => item.control);
    const activate = index => {
        const item = matches[index];
        if (!item) return;
        bar._close();
        item.run();
    };
    const paint = () => {
        list.destroy_all_children();
        const start = Math.max(0, Math.min(selected - 5, Math.max(0, matches.length - 6)));
        for (const [offset, item] of matches.slice(start, start + 6).entries()) {
            const index = start + offset;
            const row = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});
            row.add_child(item.app ? item.app.create_icon_texture(28) : new St.Icon({icon_name: item.icon, icon_size: 28}));
            const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            labels.add_child(new St.Label({text: item.name, style: `color: ${theme.fg};`}));
            labels.add_child(new St.Label({text: item.detail, style: `color: ${theme.muted}; font-size: 11px;`}));
            row.add_child(labels);
            const button = new St.Button({child: row, can_focus: true, x_align: Clutter.ActorAlign.FILL,
                style_class: 'bezel-action', style: `padding: 10px; border-radius: 14px; ${selected === index ? `background-color: ${theme.surface};` : ''}`});
            button.connect('clicked', () => activate(index));
            list.add_child(button);
        }
        if (!matches.length)
            list.add_child(new St.Label({text: 'No matching applications', style: `color: ${theme.muted}; padding: 24px;`}));
        root._matches = matches;
    };
    const search = () => {
        selected = 0;
        const query = entry.get_text().trim();
        const command = query.startsWith('>');
        const text = command ? query.slice(1) : query;
        heading.text = 'Launcher';
        const apps = system.get_installed().map(info => system.lookup_app(info.get_id())).filter(app => app?.get_app_info()?.should_show()).map(app => {
            const info = app.get_app_info();
            return {app, name: app.get_name(), detail: info.get_description() || 'Open application',
                keywords: `${info.get_keywords()?.join(' ') ?? ''} ${app.get_id()}`, run: () => app.activate()};
        });
        const settings = settingsPanels().map(panel => ({
            name: panel.name, icon: panel.icon, detail: 'Settings', keywords: panel.keywords,
            run: () => openSettings(panel.panel),
        }));
        const switches = toggles.map(item => ({
            name: item.name, icon: item.icon, keywords: item.keywords,
            detail: item.control.active() ? 'On · Enter to turn off' : 'Off · Enter to turn on',
            run: () => item.control.toggle(),
        }));
        const items = command ? [...actions, ...settings, ...switches]
            : text ? [...apps, ...actions, ...settings, ...switches] : apps;
        const ranked = text ? filterMatches(text, items) : items.map(item => ({...item, score: 0})).sort((a, b) =>
            Number(bar._state.pinned.includes(`app:${b.app?.get_id()}`)) - Number(bar._state.pinned.includes(`app:${a.app?.get_id()}`)) || a.name.localeCompare(b.name));
        const extra = [];
        const math = text && !command ? calculate(text) : null;
        if (math)
            extra.push({name: math, icon: 'accessories-calculator-symbolic', detail: 'Calculator · Enter copies', keywords: text, run: () => copyText(math)});
        const units = text && !command ? convertUnits(text) : null;
        if (units)
            extra.push({name: units, icon: 'edit-copy-symbolic', detail: 'Conversion · Enter copies', keywords: text, run: () => copyText(units)});
        const web = webSearch(query);
        if (web)
            extra.push({name: web.text ? `${web.name} · ${web.text}` : web.name, icon: 'web-browser-symbolic',
                detail: web.url ? `Search ${web.name}` : `Type a search after !${query.trim().slice(1).split(/\s+/)[0]}`,
                keywords: query, run: () => { if (web.url) Gio.AppInfo.launch_default_for_uri(web.url, null); }});
        matches = [...extra, ...ranked];
        paint();
        bar._popupLockedHeight = false;
        bar._fitPopup?.();
    };
    entry.clutter_text.connect('text-changed', search);
    entry.clutter_text.connect('activate', () => activate(selected));
    entry.clutter_text.connect('key-press-event', (_text, event) => {
        const key = event.get_key_symbol();
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down)
            return Clutter.EVENT_PROPAGATE;
        selected = Math.max(0, Math.min(matches.length - 1, selected + (key === Clutter.KEY_Up ? -1 : 1)));
        paint();
        return Clutter.EVENT_STOP;
    });
    const changed = system.connect('installed-changed', search);
    bar._popupCleanups.push(() => system.disconnect(changed));
    bar._onPopupScroll = step => {
        if (!matches.length)
            return false;
        selected = Math.max(0, Math.min(matches.length - 1, selected + step));
        paint();
        return true;
    };
    bar._popupCleanups.push(() => { bar._onPopupScroll = null; });
    bar._launcherEntry = entry;
    bar._launcherWidget = root;
    search();
    return root;
}
