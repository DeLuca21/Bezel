import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {dndControl, darkStyleControl, nightLightControl, openSettings, settingsPanels} from './tools.js';
import {calculate, convertUnits, filterMatches, webSearch, websiteUrl, BANGS, compareSearchResults, parseLauncherQuery} from './search.js';
import {activateApp, appWindows} from './appActivation.js';
import {bezelResults, searchFiles, commandArgv, runCommand} from './launcherProviders.js';

export function buildLauncher(bar) {
    const theme = bar._theme, settings = bar._overlay._settings;
    const system = Shell.AppSystem.get_default();
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
    const heading = new St.Label({text: 'Launcher', style: `color: ${theme.accent}; font-size: 18px;`});
    const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 4px;'});
    const hint = new St.Label({text: '', style: `color: ${theme.muted}; font-size: 11px;`});
    hint.clutter_text.line_wrap = true;
    const entry = new St.Entry({hint_text: 'Search apps, Bezel settings, files or the web…', can_focus: true, track_hover: true,
        style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 16px; padding: 12px;`});
    entry.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 18}));
    const header = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px; padding-bottom: 4px;'});
    header.add_child(heading); header.add_child(entry);
    const modes = new St.BoxLayout({style: 'spacing: 6px;'});
    header.add_child(modes);
    const footer = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'padding-top: 10px; spacing: 3px;', y_expand: false});
    const status = new St.Label({text: '', style: `color: ${theme.muted}; font-size: 11px;`});
    status.clutter_text.line_wrap = true;
    footer.add_child(hint); footer.add_child(status);
    root.add_child(list); root._bezelHeader = header; root._bezelFooter = footer;
    root._footerHint = hint;
    const expanded = new Set();
    let selected = 0, matches = [], base = [], fileRows = [], timer = 0, cancel = null, generation = 0, dead = false;
    let filesPending = false, selectionMoved = false, appCatalog = null;
    let renderedRows = [], renderedStart = -1;
    const modeButtons = [];
    const openUri = uri => Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(global.get_current_time(), -1));
    const actions = [
        {name: 'GNOME Overview', detail: 'Windows and workspaces', icon: 'view-paged-symbolic', run: () => Main.overview.show()},
        {name: 'GNOME Applications', detail: 'Open the app grid', icon: 'view-app-grid-symbolic', run: () => Main.overview.showApps()},
        {name: 'Customize Bezel', detail: 'Layouts, launcher and appearance', icon: 'preferences-system-symbolic', keywords: 'bezel preferences settings', run: () => bar._overlay.openPreferences()},
    ];
    const toggles = [
        {name: 'Do Not Disturb', icon: 'notifications-disabled-symbolic', keywords: 'dnd notifications quiet banners', control: dndControl()},
        {name: 'Night Light', icon: 'weather-clear-night-symbolic', keywords: 'night light blue warm color', control: nightLightControl()},
        {name: 'Dark style', icon: 'weather-clear-night-symbolic', keywords: 'dark style theme appearance', control: darkStyleControl()},
    ].filter(item => item.control);
    const activate = (index, alternate = false) => {
        const item = matches[index];
        if (!item) return;
        try {
            // Capture the action before closing destroys the launcher actors.
            const run = alternate && item.alternate ? item.alternate : item.run;
            bar._close(); run();
        } catch (error) { Main.notify('Bezel launcher', error.message); }
    };
    const smallButton = (text, run) => {
        const button = new St.Button({label: text, can_focus: true, style_class: 'bezel-action', style: `font-size: 11px; padding: 6px; border-radius: 8px; color: ${theme.fg};`});
        button.connect('clicked', run); return button;
    };
    const paint = (rebuild = true) => {
        selected = Math.max(0, Math.min(selected, matches.length - 1));
        let selectedRow = null;
        const start = !rebuild && selected >= renderedStart && selected < renderedStart + renderedRows.length
            ? renderedStart : Math.max(0, Math.min(selected - 6, matches.length - 20));
        if (rebuild || renderedStart !== start) {
            list.destroy_all_children(); renderedRows = []; renderedStart = start;
            for (const [offset, item] of matches.slice(start, start + 20).entries()) {
                const index = start + offset;
                const wrap = new St.BoxLayout({style: `spacing: 4px; ${item.parentApp ? 'padding-left: 26px;' : ''}`});
                const row = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});
                row.add_child(item.app ? item.app.create_icon_texture(28) : new St.Icon({icon_name: item.icon, icon_size: 28}));
                const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                for (const [text, color, size] of [[item.name, theme.fg, 14], [item.detail, theme.muted, 11]]) {
                    const label = new St.Label({text: text || '', style: `color: ${color}; font-size: ${size}px;`, x_expand: true});
                    label.clutter_text.ellipsize = Pango.EllipsizeMode.END; labels.add_child(label);
                }
                row.add_child(labels);
                const button = new St.Button({child: row, can_focus: true, x_expand: true, x_align: Clutter.ActorAlign.FILL,
                    style_class: 'bezel-action', style: `padding: 10px; border-radius: 14px; ${selected === index ? `background-color: ${theme.surface};` : ''}`});
                button.connect('clicked', () => activate(index)); wrap.add_child(button);
                if (item.alternate) wrap.add_child(smallButton(item.alternateLabel, () => activate(index, true)));
                if (item.windows?.length > 1) wrap.add_child(smallButton(expanded.has(item.app.get_id()) ? 'Hide windows ▴' : `${item.windows.length} windows ▾`, () => {
                    const id = item.app.get_id();
                    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
                    refreshFiles();
                }));
                renderedRows.push({index, wrap, button, selected: selected === index});
                list.add_child(wrap);
            }
            if (!matches.length) list.add_child(new St.Label({text: filesPending ? 'Searching files…' : 'No matching results', style: `color: ${theme.muted}; padding: 24px;`}));
            root._matches = matches;
            bar._popupLockedHeight = false; bar._fitPopup?.();
        }
        for (const row of renderedRows) {
            const {index, wrap, button} = row;
            if (row.selected !== (selected === index)) button.style = `padding: 10px; border-radius: 14px; ${selected === index ? `background-color: ${theme.surface};` : ''}`;
            row.selected = selected === index;
            if (index === selected) selectedRow = wrap;
        }
        bar._later('_launcherScroll', 30, () => {
            if (dead || !selectedRow?.get_stage()) return;
            const adjustment = bar._popupScroll?.vadjustment;
            if (!adjustment) return;
            const top = selectedRow.y, bottom = top + selectedRow.height;
            const value = top < adjustment.value ? top : bottom > adjustment.value + adjustment.page_size ? bottom - adjustment.page_size : adjustment.value;
            adjustment.value = Math.max(adjustment.lower, Math.min(value, adjustment.upper - adjustment.page_size));
        });
    };
    const refreshFiles = () => {
        const current = selectionMoved ? matches[selected] : null;
        matches = [...base.filter(item => !item.webFallback), ...fileRows]
            .sort((a, b) => entry.get_text().trim() ? compareSearchResults(a, b) : 0);
        matches = matches.filter(item => !item.window || !expanded.has(item.app.get_id())).flatMap(item => {
            if (!item.windows?.length || !expanded.has(item.app.get_id())) return [item];
            return [item, ...appWindows(item.app).map(win => ({name: win.get_title() || item.name, app: item.app, window: win, parentApp: item.app.get_id(),
                detail: `Workspace ${(win.get_workspace()?.index() ?? 0) + 1}${win.minimized ? ' · Minimized' : ''}`,
                run: () => Main.activateWindow(win)}))];
        });
        matches.push(...base.filter(item => item.webFallback));
        if (!selectionMoved) selected = 0;
        if (current) { const index = matches.findIndex(item => item === current || (current.window && item.window === current.window && item.parentApp === current.parentApp)); if (index >= 0) selected = index; }
        paint();
    };
    const stopFiles = () => {
        generation++; cancel?.cancel(); cancel = null;
        if (timer) GLib.source_remove(timer); timer = 0;
    };
    const search = () => {
        stopFiles(); expanded.clear(); selectionMoved = false; selected = 0; matches = []; fileRows = [];
        status.text = ''; status.visible = false;
        const query = entry.get_text().trim();
        const {mode, text} = parseLauncherQuery(entry.get_text());
        heading.text = ({'>': 'Actions · Bezel, settings, session', '$': 'Commands', '/': 'Files · names and paths', '?': 'Web search'})[mode] || 'Launcher';
        hint.text = mode === '/' ? 'Type a filename or full path · Shift+Enter opens the containing folder' : mode === '$' ? 'Program and arguments (no shell pipelines) · Enter: terminal · Shift+Enter: background'
            : mode === '>' ? 'GNOME settings, logout and power, and Bezel'
            : '↑↓ select · Enter opens · Shift+Enter: secondary action · !g !yt !gh';
        for (const [button, prefix] of modeButtons) button.style = `font-size: 11px; padding: 6px 8px; border-radius: 10px; color: ${theme.fg}; ${mode === prefix ? `background-color: ${theme.surface};` : ''}`;
        // Application metadata is stable until installed-changed; window state is
        // sampled for each all-mode search without reloading every desktop entry.
        if (!mode && !appCatalog) appCatalog = system.get_installed()
            .map(info => system.lookup_app(info.get_id())).filter(app => app?.get_app_info()?.should_show())
            .map(app => ({app, name: app.get_name(),
                keywords: `${app.get_app_info().get_keywords()?.join(' ') ?? ''} ${app.get_id()}`,
                run: () => activateApp(app), alternate: () => activateApp(app, true), alternateLabel: 'New window'}));
        const apps = !mode ? appCatalog.map(item => {
            const windows = appWindows(item.app);
            return {...item, windows, detail: windows.length ? `Switch to app · ${windows.length} window${windows.length === 1 ? '' : 's'}` : 'Launch application'};
        }) : [];
        const options = (mode === '>' || (!mode && text)) ? (() => {
            const session = SystemActions.getDefault();
            const sessionActions = [
                ['Log out', 'system-log-out-symbolic', 'logout log out sign out session', session.can_logout, () => session.activateLogout()],
                ['Lock screen', 'system-lock-screen-symbolic', 'lock screen lockscreen', session.can_lock_screen, () => session.activateLockScreen()],
                ['Suspend', 'system-suspend-symbolic', 'suspend sleep', session.can_suspend, () => session.activateSuspend()],
                ['Hibernate', 'system-hibernate-symbolic', 'hibernate', session.can_hibernate, () => session.activateHibernate()],
                ['Restart', 'system-reboot-symbolic', 'restart reboot', session.can_restart, () => session.activateRestart()],
                ['Power off', 'system-shutdown-symbolic', 'power off shutdown poweroff turn off halt', session.can_power_off, () => session.activatePowerOff()],
                ['Switch user', 'system-switch-user-symbolic', 'switch user', session.can_switch_user, () => session.activateSwitchUser()],
            ].filter(([, , , allowed]) => allowed).map(([name, icon, keywords, , run]) => ({name, icon, keywords: `gnome session ${keywords}`, detail: 'Session', run}));
            return [...actions, ...sessionActions, ...bezelResults(bar),
                {name: 'GNOME Settings', icon: 'preferences-system-symbolic', detail: 'Open Settings', keywords: 'settings gnome control center preferences', run: () => openSettings()},
                ...settingsPanels().map(panel => ({name: panel.name, icon: panel.icon, detail: 'GNOME Settings', keywords: panel.keywords, run: () => openSettings(panel.args)})),
                ...toggles.map(item => ({...item, detail: item.control.active() ? 'On · Enter to turn off' : 'Off · Enter to turn on', run: () => item.control.toggle()}))];
        })() : [];
        const windows = text && !mode ? system.get_running().flatMap(app => appWindows(app).map(win => ({
            name: win.get_title() || app.get_name(), keywords: app.get_name(), app, window: win,
            detail: `Switch to window · ${app.get_name()} · Workspace ${(win.get_workspace()?.index() ?? 0) + 1}`,
            run: () => Main.activateWindow(win),
        }))) : [];
        const items = mode === '>' ? options : mode ? [] : text ? [...apps, ...windows, ...options] : apps;
        base = text ? filterMatches(text, items) : items.sort((a, b) => Number(bar._state.pinned.includes(`app:${b.app?.get_id()}`)) - Number(bar._state.pinned.includes(`app:${a.app?.get_id()}`)) || a.name.localeCompare(b.name));
        if (mode === '$') {
            try {
                const argv = commandArgv(text);
                base = [{name: text, detail: 'Run in terminal · Shift+Enter runs in background', icon: 'utilities-terminal-symbolic', run: () => runCommand(argv, true, error => Main.notify('Bezel command failed', error.message)), alternate: () => runCommand(argv, false, error => Main.notify('Bezel command failed', error.message)), alternateLabel: 'Background'}];
            } catch (error) { hint.text = error.message; }
        }
        if (!mode) {
            for (const [value, name] of [[calculate(text), 'Calculator'], [convertUnits(text), 'Conversion']]) if (value) base.unshift({name: value, detail: `${name} · Enter copies`, icon: 'edit-copy-symbolic', run: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value)});
            const url = websiteUrl(text);
            if (url) base.unshift({name: text, detail: `Open website · ${url}`, icon: 'web-browser-symbolic', run: () => openUri(url)});
        }
        const web = webSearch(query);
        if (web) base = [{name: web.text ? `${web.name} · ${web.text}` : web.name, detail: web.url ? 'Search the web' : 'Type a search after the bang', icon: 'web-browser-symbolic', run: () => { if (web.url) openUri(web.url); }}];
        else if (text && (!mode || mode === '?') && !websiteUrl(text)) {
            const engine = BANGS[settings.get_string('launcher-web-engine')] || BANGS.ddg;
            base.push({name: `Search ${engine[0]} for “${text}”`, detail: 'Search the web', icon: 'web-browser-symbolic', webFallback: true, run: () => openUri(engine[1] + encodeURIComponent(text))});
        }
        if (text && !mode) for (const item of base) if (item.windows?.length > 1) expanded.add(item.app.get_id());
        filesPending = (!mode || mode === '/') && !web && text.length >= 2 && settings.get_boolean('launcher-files');
        refreshFiles();
        if ((!mode || mode === '/') && !web && text.length >= 2 && settings.get_boolean('launcher-files')) {
            const request = generation;
            status.text = 'Searching files…'; status.visible = true; bar._fitPopup?.();
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                timer = 0; cancel = new Gio.Cancellable();
                const updateFiles = (files, complete) => {
                    if (dead || request !== generation) return;
                    filesPending = !complete;
                    // Reuse existing rows so newly discovered hits do not move keyboard selection.
                    const previous = new Map(fileRows.map(item => [item.file.get_uri(), item]));
                    fileRows = files.map(item => previous.get(item.file.get_uri()) ?? ({...item, icon: item.folder ? 'folder-symbolic' : 'text-x-generic-symbolic', run: () => openUri(item.file.get_uri()),
                        alternate: () => openUri(item.file.get_parent().get_uri()), alternateLabel: 'Show folder'}));
                    status.text = `${files.length} file matches · ${complete ? 'Search folders in Bezel settings' : 'Searching…'}`;
                    refreshFiles();
                };
                searchFiles(text, settings.get_strv('launcher-file-roots'), cancel, files => updateFiles(files, false))
                    .then(files => updateFiles(files, true)).catch(error => {
                        if (dead || request !== generation) return;
                        filesPending = false;
                        status.text = `File search unavailable: ${error.message}`;
                        refreshFiles();
                    });
                return GLib.SOURCE_REMOVE;
            });
        }
    };
    for (const [name, prefix] of [['All', ''], ['Actions >', '>'], ['Files /', '/'], ['Web ?', '?'], ['Commands $', '$']]) {
        const button = smallButton(name, () => {
            const {text} = parseLauncherQuery(entry.get_text());
            entry.set_text(prefix === '/' ? `/ ${text}` : prefix ? `${prefix} ${text}` : /^[\/~]/.test(text) ? '' : text);
            entry.grab_key_focus();
        }); modeButtons.push([button, prefix]); modes.add_child(button);
    }
    root._modeButtons = modeButtons;
    entry.clutter_text.connect('text-changed', search);
    entry.clutter_text.connect('activate', () => activate(selected));
    entry.clutter_text.connect('key-press-event', (_text, event) => {
        const key = event.get_key_symbol(), state = event.get_state();
        if ((key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) && (state & Clutter.ModifierType.SHIFT_MASK)) { activate(selected, true); return Clutter.EVENT_STOP; }
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down) return Clutter.EVENT_PROPAGATE;
        selectionMoved = true;
        selected = Math.max(0, Math.min(matches.length - 1, selected + (key === Clutter.KEY_Up ? -1 : 1))); paint(false); return Clutter.EVENT_STOP;
    });
    const changed = system.connect('installed-changed', () => { appCatalog = null; search(); });
    bar._popupCleanups.push(() => { dead = true; stopFiles(); bar._cancel('_launcherScroll'); system.disconnect(changed); });
    bar._onPopupScroll = step => { if (!matches.length) return false; selectionMoved = true; selected = Math.max(0, Math.min(matches.length - 1, selected + step)); paint(false); return true; };
    bar._popupCleanups.push(() => { bar._onPopupScroll = null; });
    bar._launcherEntry = entry; bar._launcherWidget = root;
    search(); return root;
}
