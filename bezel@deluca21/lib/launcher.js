import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {dndControl, darkStyleControl, nightLightControl, openSettings, settingsPanels, activateScreenshot} from './tools.js';
import {calculate, convertUnits, filterMatches, webSearch, websiteUrl, BANGS, compareSearchResults, parseLauncherQuery} from './search.js';
import {activateApp, appWindows} from './appActivation.js';
import {bezelSearchResults, searchFiles, commandArgv, runCommand} from './launcherProviders.js';
import {gnomePicker, watchLauncherDevices, wallpaperResults, gnomeSubgroups,
    GNOME_PICKERS, GNOME_NESTED, GNOME_PARENT, BEZEL_NESTED, TAB_COLLECTIONS, LIVE_COLLECTIONS} from './launcherDevices.js';
import {motionDuration, pageMotion, preparePage} from './pageMotion.js';

const MODE_ORDER = ['', '>', '/', '?', '$', '> settings', '> gnome'];
const IDLE_HINTS = {
    '': 'Search apps, settings and files',
    '>': 'Lock, power and session actions',
    '/': 'Type a name or path',
    '?': 'Search the web or choose a bang',
    '$': 'Type a program and arguments',
    '> settings': 'Browse Bezel settings',
    '> gnome': 'Browse GNOME settings',
};
const COLLECTION_NAMES = {
    settings: 'Bezel', gnome: 'GNOME', themes: 'Themes', layouts: 'Layouts', bangs: 'Bangs',
    wifi: 'Wi-Fi', bluetooth: 'Bluetooth', wallpaper: 'Wallpaper', sound: 'Sound', output: 'Sound output',
    input: 'Sound input', power: 'Power', vpn: 'VPN', keyboard: 'Keyboard', appearance: 'Appearance',
    scheme: 'Colour scheme', accent: 'Accent colour', notifications: 'Notifications',
    accessibility: 'Accessibility', multitasking: 'Multitasking', mouse: 'Mouse', touchpad: 'Touchpad',
    pointer: 'Mouse', datetime: 'Date & Time', displays: 'Displays',
};
const COLLECTIONS = new Set(['themes', 'layouts', 'settings', 'gnome', 'bangs', ...GNOME_NESTED]);

export function buildLauncher(bar) {
    const theme = bar._theme, settings = bar._overlay._settings;
    const system = Shell.AppSystem.get_default();
    const width = Math.max(160, bar._popupWidth - 36);
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;',
        y_expand: false, y_align: Clutter.ActorAlign.START});
    const entry = new St.Entry({hint_text: 'Search apps, settings, files…', can_focus: true, track_hover: true,
        style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 16px; padding: 12px;`});
    entry.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 18}));
    const modes = new St.BoxLayout({style: 'spacing: 2px;', y_align: Clutter.ActorAlign.CENTER});
    const footer = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'padding-top: 8px; spacing: 6px;', y_expand: false});
    const status = new St.Label({text: '', width: 72, y_align: Clutter.ActorAlign.CENTER, style: `color: ${theme.muted}; font-size: 11px;`});
    // Status shares the fixed control row; it never adds another line.
    status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    status.clutter_text.line_alignment = Pango.Alignment.RIGHT;
    const hint = new St.Label({text: '', x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: `color: ${theme.muted}; font-size: 11px;`});
    hint.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    const stage = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true,
        y_align: Clutter.ActorAlign.START});
    root.add_child(stage);
    root._bezelFooter = footer;
    root._footerHint = hint;
    bar._launcherControllers ??= new Set();
    const motion = pageMotion(stage, bar, bar._launcherControllers);
    const expanded = new Set();
    let selected = 0, matches = [], base = [], fileRows = [], timer = 0, cancel = null, generation = 0, dead = false;
    let filesPending = false, selectionMoved = false, appCatalog = null, retainedSelection = null;
    let renderedRows = [], renderedStart = -1, currentMode = null, list = null, rowHighlight = null;
    const modeButtons = [];
    let collection = null, currentPageKey = null, highlightedTab = null;
    const history = [];
    let watchedCollection = null, stopDevices = null, wallpaperCancel = null, wallpapers = null;
    const collectionQuery = () => {
        const match = /^>\s*(\S+)\s*(.*)$/.exec(entry.get_text());
        if (!match) return null;
        const name = match[1].toLowerCase();
        if (!COLLECTIONS.has(name) && !/^bar-\d+$/.test(name)) return null;
        return [match[0], name, match[2]];
    };
    const collectionLabel = name => {
        if (COLLECTION_NAMES[name]) return COLLECTION_NAMES[name];
        const bar = /^bar-(\d+)$/.exec(name ?? '');
        return bar ? `Bar ${Number(bar[1]) + 1}` : 'results';
    };
    const tabKey = () => {
        if (GNOME_NESTED.has(collection) || collection === 'gnome') return '> gnome';
        if (BEZEL_NESTED.has(collection) || collection === 'settings' || /^bar-\d+$/.test(collection)) return '> settings';
        if (collection === 'bangs' || /^!/.test(entry.get_text())) return '?';
        return currentMode;
    };
    const isNested = () => collection && !TAB_COLLECTIONS.has(collection);
    const rowKey = item => item.id ?? `${item.category ?? ''}:${item.collection ?? ''}:${item.name}`;
    const actionStates = new Map();
    let orderQuery = null;
    const rowOrder = new Map();
    const preferSelected = list => {
        if (!collection) { orderQuery = null; rowOrder.clear(); return list; }
        const query = entry.get_text();
        if (orderQuery !== query) { orderQuery = query; rowOrder.clear(); }
        list.sort((a, b) => (rowOrder.get(rowKey(a)) ?? Infinity) - (rowOrder.get(rowKey(b)) ?? Infinity)
            || Number(Boolean(b.selected)) - Number(Boolean(a.selected)));
        for (const item of list) if (!rowOrder.has(rowKey(item))) rowOrder.set(rowKey(item), rowOrder.size);
        return list;
    };
    const openUri = uri => Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(global.get_current_time(), -1));
    const bangItems = () => Object.entries(BANGS).map(([bang, [name]]) => ({name: `!${bang} · ${name}`,
        keywords: name, detail: `Search ${name} with !${bang} your search`, icon: 'web-browser-symbolic',
        primaryLabel: 'Use bang', fillQuery: `!${bang} `}));
    const actions = [
        {name: 'GNOME Overview', detail: 'Windows and workspaces', icon: 'view-paged-symbolic', run: () => Main.overview.show()},
        {name: 'GNOME Applications', detail: 'Open the app grid', icon: 'view-app-grid-symbolic', run: () => Main.overview.showApps()},
        {name: 'Screenshot', detail: 'Capture the screen', icon: 'camera-photo-symbolic',
            keywords: 'screenshot capture record', run: () => activateScreenshot()},
        {name: 'Customize Bezel', detail: 'Layouts, launcher and appearance', icon: 'preferences-system-symbolic', keywords: 'bezel preferences settings', run: () => bar._overlay.openPreferences()},
    ];
    const toggles = [
        {name: 'Do Not Disturb', icon: 'notifications-disabled-symbolic', keywords: 'dnd notifications quiet banners', control: dndControl()},
        {name: 'Night Light', icon: 'weather-clear-night-symbolic', keywords: 'night light blue warm color', control: nightLightControl()},
        {name: 'Dark style', icon: 'weather-clear-night-symbolic', keywords: 'dark style theme appearance', control: darkStyleControl()},
    ].filter(item => item.control);
    const activate = (index, alternate = false) => {
        const item = matches[index];
        if (!item || (!alternate && actionStates.get(rowKey(item))?.pending)) return;
        if (alternate && !item.alternate) return;
        if (item.fillQuery && !alternate) {
            history.push(entry.get_text()); entry.set_text(item.fillQuery); entry.grab_key_focus(); return;
        }
        if (item.collection && !alternate) {
            history.push(entry.get_text());
            entry.set_text(`> ${item.collection} `);
            entry.grab_key_focus();
            return;
        }
        try {
            // Capture the action before dismissing the launcher.
            const run = alternate && item.alternate ? item.alternate : item.run;
            if (!item.keepOpen || alternate) bar._close(true);
            const key = rowKey(item);
            const result = run();
            if (item.keepOpen && !alternate) {
                actionStates.delete(key);
                if (result?.then) {
                    actionStates.set(key, {pending: true, detail: item.pendingLabel ?? 'Applying…'});
                    Promise.resolve(result).then(() => actionStates.delete(key), error => {
                        actionStates.set(key, {detail: `Failed: ${error.message}`});
                    }).finally(() => { if (!dead) search(true); });
                }
                search(true);
            } else Promise.resolve(result).catch(error => Main.notify('Bezel launcher', error.message));
        } catch (error) {
            if (item.keepOpen && !alternate && !dead) {
                actionStates.set(rowKey(item), {detail: `Failed: ${error.message}`});
                search(true);
            } else Main.notify('Bezel launcher', error.message);
        }
    };
    const smallButton = (text, run) => {
        const button = new St.Button({label: text, can_focus: true, style_class: 'bezel-action', style: `font-size: 11px; padding: 6px; border-radius: 8px; color: ${theme.fg};`});
        button.connect('clicked', run); return button;
    };
    // Sliding surface behind a peer control. Same interpolation as group tabs.
    const attachHighlight = (host, radius, name, expand = false) => {
        const layer = new St.Widget({layout_manager: new Clutter.BinLayout(), clip_to_allocation: true, x_expand: expand});
        const overlay = new St.Widget({width: 0, height: 0, reactive: false, x_expand: false, y_expand: false,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START});
        const highlight = new St.Widget({name, reactive: false, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START,
            opacity: 0, width: 1, height: 1, style: `background-color: ${theme.surface}; border-radius: ${radius}px;`});
        overlay.add_child(highlight); layer.add_child(overlay); layer.add_child(host);
        let timeline = null, disposed = false, targetActor = null, targetSignal = 0;
        const stop = () => {
            timeline?.stop(); timeline = null;
            if (targetSignal) targetActor.disconnect(targetSignal);
            targetActor = null; targetSignal = 0;
        };
        layer.connect('destroy', () => { disposed = true; stop(); });
        const sync = target => {
            if (dead || disposed || timeline) return;
            if (!target?.get_stage() || !overlay.get_stage() || target.width <= 0) {
                highlight.opacity = 0;
                return;
            }
            const [sx, sy] = target.get_transformed_position();
            const [ox, oy] = overlay.get_transformed_position();
            const parent = overlay.get_parent();
            const [pw, ph] = parent.get_transformed_size();
            const scaleX = parent.width > 0 && pw > 0 ? pw / parent.width : 1;
            const scaleY = parent.height > 0 && ph > 0 ? ph / parent.height : 1;
            const x = (sx - ox) / scaleX, y = (sy - oy) / scaleY;
            if (![x, y, target.width, target.height].every(Number.isFinite)) return;
            highlight.set_position(x, y); highlight.set_size(target.width, target.height); highlight.opacity = 255;
        };
        const move = (target, duration) => {
            stop();
            if (disposed) return;
            if (!target?.get_stage()) { highlight.opacity = 0; return; }
            if (!duration || !highlight.opacity) { sync(target); return; }
            const from = [highlight.x, highlight.y, highlight.width, highlight.height];
            const [sx, sy] = target.get_transformed_position();
            const [ox, oy] = overlay.get_transformed_position();
            const parent = overlay.get_parent();
            const [pw, ph] = parent.get_transformed_size();
            const scaleX = parent.width > 0 && pw > 0 ? pw / parent.width : 1;
            const scaleY = parent.height > 0 && ph > 0 ? ph / parent.height : 1;
            const x = (sx - ox) / scaleX, y = (sy - oy) / scaleY;
            const to = [x, y, target.width, target.height];
            if (!to.every(Number.isFinite)) return;
            const t = new Clutter.Timeline({duration, actor: layer}); timeline = t;
            targetActor = target;
            targetSignal = target.connect('destroy', () => {
                targetSignal = 0; targetActor = null;
                stop();
            });
            t.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            t.connect('new-frame', () => {
                const v = to.map((value, i) => from[i] + (value - from[i]) * t.get_progress());
                highlight.set_position(v[0], v[1]); highlight.set_size(v[2], v[3]);
            });
            t.connect('completed', () => { stop(); sync(target); }); t.start();
        };
        return {layer, highlight, sync, move, stop, get moving() { return timeline !== null; }};
    };
    const modeHighlight = attachHighlight(modes, 10, 'bezel-launcher-mode-highlight');
    const controls = new St.BoxLayout({height: 32, style: 'spacing: 8px;'});
    const goBack = () => {
        const bang = /^!/.test(entry.get_text());
        if (!collectionQuery() && !bang) return false;
        if (TAB_COLLECTIONS.has(collection) && !history.length) return false;
        const parent = GNOME_PARENT[collection];
        const fallback = bang || collection === 'bangs' ? '? '
            : parent ? `> ${parent} `
            : GNOME_NESTED.has(collection) ? '> gnome '
                : BEZEL_NESTED.has(collection) || /^bar-\d+$/.test(collection) ? '> settings ' : '';
        entry.set_text(history.pop() ?? fallback);
        entry.grab_key_focus();
        return true;
    };
    root._handleEscape = goBack;
    const tabScroll = new St.ScrollView({x_expand: true, overlay_scrollbars: true,
        hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.NEVER});
    const tabContent = new St.BoxLayout();
    tabContent.add_child(modeHighlight.layer);
    tabScroll.set_child(tabContent);
    controls.add_child(tabScroll);
    const guidance = new St.BoxLayout({height: 18, style: 'spacing: 8px;'});
    guidance.add_child(hint); guidance.add_child(status);
    footer.add_child(controls);
    footer.add_child(guidance);
    footer.add_child(entry);
    const selectedButton = () => renderedRows.find(row => row.index === selected)?.button ?? null;
    const selectedMode = () => modeButtons.find(([, prefix]) => prefix === tabKey())?.[0] ?? null;
    const createBreadcrumb = () => {
        if (!isNested()) return null;
        const parent = GNOME_PARENT[collection];
        const ancestry = GNOME_NESTED.has(collection) ? ['gnome', ...(parent ? [parent] : []), collection]
            : collection === 'bangs' ? ['web', collection] : ['settings', collection];
        const trail = new St.BoxLayout({name: 'bezel-launcher-breadcrumb', style: 'spacing: 4px; padding: 0 6px 8px;'});
        const shortNames = {web: 'Web', output: 'Output', input: 'Input', pointer: 'Pointer'};
        trail.accessible_name = ancestry.map(name => shortNames[name] ?? collectionLabel(name)).join(' › ');
        for (const [index, name] of ancestry.entries()) {
            const label = shortNames[name] ?? collectionLabel(name);
            if (index) trail.add_child(new St.Label({text: '›', y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${theme.muted}; font-size: 11px;`}));
            if (index === ancestry.length - 1) {
                const current = new St.Label({text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
                    style: `color: ${theme.fg}; font-size: 11px; padding: 4px;`});
                current.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                trail.add_child(current);
            } else {
                const button = new St.Button({label, can_focus: true, accessible_name: `Go to ${label}`,
                    style_class: 'bezel-action', style: `color: ${theme.muted}; font-size: 11px; padding: 4px; border-radius: 6px;`});
                button.connect('clicked', () => {
                    history.length = 0;
                    entry.set_text(name === 'web' ? '? ' : `> ${name} `);
                    entry.grab_key_focus();
                });
                trail.add_child(button);
            }
        }
        return trail;
    };
    const createPage = () => {
        const results = new St.BoxLayout({name: 'bezel-launcher-results', orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 4px;', x_expand: true});
        const row = attachHighlight(results, 14, 'bezel-launcher-row-highlight', true);
        const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        page._breadcrumb = createBreadcrumb();
        if (page._breadcrumb) page.add_child(page._breadcrumb);
        page.add_child(row.layer);
        page.width = width;
        page.y_align = Clutter.ActorAlign.START;
        page.clip_to_allocation = true;
        page._launcherList = results;
        page._rowHighlight = row;
        page._refreshPageHeight = () => {
            page.height = -1;
            page.height = Math.ceil(page.get_preferred_height(width)[1]);
            stage.height = page.height;
        };
        results.connect('notify::allocation', () => {
            if (stage.get_last_child() === page) row.sync(selectedButton());
        });
        return page;
    };
    const bindPage = page => {
        list = page._launcherList;
        rowHighlight = page._rowHighlight;
        renderedRows = [];
        renderedStart = -1;
        root._list = list;
        root._breadcrumb = page._breadcrumb;
    };
    const refit = (duration = motionDuration(bar)) => {
        if (dead || !root.get_stage() || !bar._popout) return;
        stage.get_last_child()?._refreshPageHeight?.();
        bar._popupLockedHeight = false;
        const height = bar._fitPopup(true);
        if (Number.isFinite(height)) bar._setDashboardSize(bar._popupWidth, height, duration);
    };
    const paint = (rebuild = true, fit = true) => {
        selected = Math.max(0, Math.min(selected, matches.length - 1));
        let selectedRow = null;
        const start = !rebuild && selected >= renderedStart && selected < renderedStart + renderedRows.length
            ? renderedStart : Math.max(0, Math.min(selected - 6, matches.length - 20));
        const rebuilt = rebuild || renderedStart !== start;
        if (rebuilt) {
            list.destroy_all_children(); renderedRows = []; renderedStart = start;
            for (const [offset, item] of matches.slice(start, start + 20).entries()) {
                const index = start + offset;
                const wrap = new St.BoxLayout({style: `spacing: 4px; ${item.parentApp ? 'padding-left: 26px;' : ''}`});
                const row = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});
                if (item.swatch) {
                    const swatch = new St.BoxLayout({width: 28, height: 28, y_align: Clutter.ActorAlign.CENTER,
                        style: `background-color: ${item.swatch.bg}; border: 1px solid ${item.swatch.muted}; border-radius: 8px; padding: 6px;`});
                    swatch.add_child(new St.Widget({x_expand: true, y_expand: true,
                        style: `background-color: ${item.swatch.accent}; border-radius: 4px;`}));
                    row.add_child(swatch);
                } else if (item.app)
                    row.add_child(item.app.create_icon_texture(28));
                else {
                    const icon = new St.Icon({icon_size: 28, y_align: Clutter.ActorAlign.CENTER});
                    if (item.gicon) icon.gicon = item.gicon;
                    else icon.icon_name = item.icon || 'text-x-generic-symbolic';
                    if (item.media) {
                        icon.clip_to_allocation = true;
                        icon.style = 'border-radius: 6px;';
                    }
                    row.add_child(icon);
                }
                const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                for (const [text, color, size] of [[item.name, item.selected ? theme.accent : theme.fg, 14], [item.detail, theme.muted, 11]]) {
                    const label = new St.Label({text: text || '', style: `color: ${color}; font-size: ${size}px;`, x_expand: true});
                    label.clutter_text.ellipsize = Pango.EllipsizeMode.END; labels.add_child(label);
                }
                row.add_child(labels);
                if (item.selected) row.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 16,
                    style: `color: ${theme.accent};`, y_align: Clutter.ActorAlign.CENTER}));
                if (item.collection) row.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 14,
                    style: `color: ${theme.muted};`}));
                const button = new St.Button({child: row, can_focus: true, track_hover: true, x_expand: true, x_align: Clutter.ActorAlign.FILL,
                    style_class: 'bezel-action', style: 'padding: 10px; border-radius: 14px;'});
                // A rebuilt list can keep its allocation while its new buttons
                // still need theirs. Follow the selected button itself.
                button.connect('notify::allocation', () => {
                    if (selectedButton() === button) rowHighlight?.sync(button);
                });
                button.connect('notify::hover', () => {
                    if (dead || !button.hover || selected === index) return;
                    selectionMoved = true;
                    selected = index;
                    paint(false);
                });
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
        }
        for (const row of renderedRows) {
            row.selected = row.index === selected;
            if (row.index === selected) selectedRow = row.wrap;
        }
        const active = matches[selected];
        const nested = isNested();
        const parts = [];
        if (active) {
            const enter = active.fillQuery ? 'Use bang'
                : active.collection ? 'Browse'
                : active.primaryLabel
                || (active.window ? 'Switch'
                    : active.file ? 'Open'
                    : active.webFallback || active.detail === 'Search the web' ? 'Search'
                    : /copies$/.test(active.detail ?? '') ? 'Copy'
                    : /Open website/.test(active.detail ?? '') ? 'Open'
                    : active.app ? (active.windows?.length ? 'Switch' : 'Launch')
                    : active.keepOpen ? (/turn off/i.test(active.detail) ? 'Turn off' : 'Turn on')
                    : 'Run');
            parts.push(`Enter: ${enter}`);
            if (active.alternate) parts.push(`Shift+Enter: ${active.alternateLabel}`);
        } else
            parts.push(IDLE_HINTS[tabKey()] ?? IDLE_HINTS[currentMode] ?? 'Type to filter');
        if (nested) parts.push('Esc: back');
        hint.text = parts.join(' · ');
        rowHighlight?.move(selectedButton(), rebuilt ? 0 : motionDuration(bar));
        if (rebuilt && fit && bar._popupContent) refit();
        bar._later('_launcherScroll', 30, () => {
            if (dead || !selectedRow?.get_stage()) return;
            const adjustment = bar._popupScroll?.vadjustment;
            if (!adjustment) return;
            const top = selectedRow.y, bottom = top + selectedRow.height;
            const value = top < adjustment.value ? top : bottom > adjustment.value + adjustment.page_size ? bottom - adjustment.page_size : adjustment.value;
            adjustment.value = Math.max(adjustment.lower, Math.min(value, adjustment.upper - adjustment.page_size));
        });
    };
    const refreshFiles = (fit = true) => {
        const current = retainedSelection ?? (selectionMoved ? matches[selected] : null);
        retainedSelection = null;
        matches = preferSelected([...base.filter(item => !item.webFallback), ...fileRows]
            .sort((a, b) => entry.get_text().trim() ? compareSearchResults(a, b) : 0));
        matches = matches.filter(item => !item.window || !expanded.has(item.app.get_id())).flatMap(item => {
            if (!item.windows?.length || !expanded.has(item.app.get_id())) return [item];
            return [item, ...appWindows(item.app).map(win => ({name: win.get_title() || item.name, app: item.app, window: win, parentApp: item.app.get_id(),
                detail: `Workspace ${(win.get_workspace()?.index() ?? 0) + 1}${win.minimized ? ' · Minimized' : ''}`,
                run: () => Main.activateWindow(win)}))];
        });
        matches.push(...base.filter(item => item.webFallback));
        matches = matches.map(item => {
            const state = actionStates.get(rowKey(item));
            return state ? {...item, detail: state.detail, primaryLabel: state.pending ? 'Please wait' : item.primaryLabel} : item;
        });
        if (!selectionMoved) selected = 0;
        if (current) {
            const index = matches.findIndex(item => item === current
                || (current.window ? item.window === current.window && item.parentApp === current.parentApp
                    : item.name === current.name && item.app === current.app && item.category === current.category
                        && item.collection === current.collection && item.id === current.id && item.file?.get_uri() === current.file?.get_uri()));
            if (index >= 0) selected = index;
        }
        paint(true, fit);
    };
    const showMode = (mode, fit) => {
        const previous = currentPageKey;
        currentMode = mode;
        currentPageKey = collection ? `> ${collection}` : mode;
        const tabChanged = highlightedTab !== tabKey();
        highlightedTab = tabKey();
        for (const [button, prefix] of modeButtons)
            button.style = `font-size: 11px; padding: 6px 7px; border-radius: 10px; color: ${prefix === tabKey() ? theme.accent : theme.muted};`;
        bar._later('_launcherTabs', 30, () => {
            if (dead) return;
            const button = selectedMode(), adjustment = tabScroll.hadjustment;
            if (!button || !adjustment) return;
            const left = button.x, right = left + button.width;
            if (left >= adjustment.value && right <= adjustment.value + adjustment.page_size) return;
            adjustment.value = Math.max(adjustment.lower, Math.min(left < adjustment.value ? left
                : right > adjustment.value + adjustment.page_size ? right - adjustment.page_size : adjustment.value,
            adjustment.upper - adjustment.page_size));
        });
        if (previous === null) {
            const page = createPage();
            bindPage(page);
            refreshFiles(false);
            motion.show(page, 1, 0);
            modeHighlight.move(selectedMode(), 0);
            return;
        }
        if (previous === currentPageKey) {
            refreshFiles(fit);
            if (tabChanged) modeHighlight.move(selectedMode(), motionDuration(bar));
            return;
        }
        const page = createPage();
        bindPage(page);
        refreshFiles(false);
        const before = MODE_ORDER.indexOf(previous), after = MODE_ORDER.indexOf(currentPageKey);
        motion.show(page, before >= 0 && after >= 0 ? (after >= before ? 1 : -1) : collection ? 1 : -1);
        modeHighlight.move(selectedMode(), motionDuration(bar));
    };
    const stopFiles = () => {
        generation++; cancel?.cancel(); cancel = null;
        if (timer) GLib.source_remove(timer); timer = 0;
    };
    const gnomeResults = (text = '') => {
        const rows = settingsPanels().map(panel => {
            const key = panel.args.find(arg => GNOME_PICKERS[arg]) ?? panel.args[0];
            const picker = GNOME_PICKERS[key];
            return {
                name: panel.name, icon: panel.icon,
                keywords: `${panel.keywords} ${picker ? `${picker.collection} ${picker.detail}` : ''}`,
                detail: picker?.detail ?? 'GNOME Settings', collection: picker?.collection,
                run: () => openSettings(panel.args), primaryLabel: picker ? 'Browse' : 'Open settings',
                alternate: () => openSettings(picker ? panel.args : []),
                alternateLabel: picker ? `${panel.name} settings` : 'All GNOME settings',
            };
        });
        if (!rows.some(item => item.collection === 'wallpaper'))
            rows.unshift({
                name: 'Wallpaper', collection: 'wallpaper', icon: 'preferences-desktop-wallpaper-symbolic',
                keywords: 'wallpaper background pictures desktop appearance',
                detail: 'Choose from Pictures and system wallpapers', primaryLabel: 'Browse',
                alternate: () => openSettings('background'), alternateLabel: 'Appearance settings',
            });
        return text.trim() ? [...gnomeSubgroups(bar._overlay.services.mixer), ...rows] : rows;
    };
    const updateCollection = () => {
        if (watchedCollection === collection) return;
        stopDevices?.(); stopDevices = null;
        wallpaperCancel?.cancel(); wallpaperCancel = null;
        watchedCollection = collection;
        if (LIVE_COLLECTIONS.has(collection))
            stopDevices = watchLauncherDevices(collection, () => { if (!dead) search(true); },
                {mixer: bar._overlay.services.mixer});
        if (collection === 'wallpaper' && !wallpapers) {
            const request = new Gio.Cancellable(); wallpaperCancel = request;
            wallpaperResults(request).then(rows => {
                if (dead || request.is_cancelled()) return;
                wallpapers = rows;
                if (collection === 'wallpaper') search(true);
            }).catch(error => { if (!dead && !request.is_cancelled()) Main.notify('Wallpaper search', error.message); });
        }
    };
    const collectionResults = text => {
        if (collection === 'gnome') return gnomeResults(text);
        if (collection === 'wallpaper') return wallpapers?.length ? wallpapers : [{name: wallpapers ? 'No wallpapers found' : 'Loading wallpapers…',
            detail: 'Browse Pictures or open Appearance settings', icon: 'preferences-desktop-wallpaper-symbolic',
            run: () => openSettings('background'), alternate: () => openSettings('background'), alternateLabel: 'Appearance settings'}];
        if (collection === 'bangs') return bangItems();
        if (GNOME_NESTED.has(collection))
            return gnomePicker(collection, {mixer: bar._overlay.services.mixer});
        return bezelSearchResults(bar, text, collection);
    };
    const search = (preserveSelection = false) => {
        retainedSelection = preserveSelection ? matches[selected] : null;
        stopFiles(); expanded.clear(); selectionMoved = Boolean(retainedSelection); selected = 0; matches = []; fileRows = [];
        status.text = '';
        const query = entry.get_text().trim();
        const parsed = parseLauncherQuery(entry.get_text());
        const scoped = collectionQuery();
        collection = scoped?.[1].toLowerCase() ?? null;
        if (!collection && !/^!/.test(entry.get_text())) history.length = 0;
        const mode = parsed.mode, text = scoped ? scoped[2].trim() : parsed.text;
        modeHighlight.layer.visible = true;
        updateCollection();
        entry.hint_text = ({'>': 'Search system actions…', '/': 'Search files or enter a path…',
            '?': 'Search the web…', '$': 'Program and arguments…'})[mode] ?? 'Search apps, settings, files…';
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
        const options = (() => {
            if (mode !== '>' && !(!mode && text)) return [];
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
            const systemOptions = [...actions, ...sessionActions, ...toggles.map(item => ({
                ...item, selected: item.control.active(),
                detail: item.control.active() ? 'On · Enter to turn off' : 'Off · Enter to turn on',
                run: () => item.control.toggle(), keepOpen: true,
                alternate: item.name === 'Do Not Disturb' ? () => openSettings('notifications')
                    : item.name === 'Night Light' ? () => openSettings('display')
                        : () => openSettings('background'),
                alternateLabel: item.name === 'Do Not Disturb' ? 'Notification settings'
                    : item.name === 'Night Light' ? 'Display settings' : 'Appearance settings',
            }))];
            if (mode === '>') return systemOptions;
            return [...systemOptions, ...bezelSearchResults(bar, text),
                {name: 'GNOME Settings', icon: 'preferences-system-symbolic', detail: 'Open Settings',
                    keywords: 'settings gnome control center preferences', run: () => openSettings()},
                ...gnomeResults(text)];
        })();
        const windows = text && !mode ? system.get_running().flatMap(app => appWindows(app).map(win => ({
            name: win.get_title() || app.get_name(), keywords: app.get_name(), app, window: win,
            detail: `Switch to window · ${app.get_name()} · Workspace ${(win.get_workspace()?.index() ?? 0) + 1}`,
            run: () => Main.activateWindow(win),
        }))) : [];
        const items = collection ? collectionResults(text) : mode === '>' ? options : mode === '?' && !text ? bangItems()
            : mode ? [] : text ? [...apps, ...windows, ...options] : apps;
        base = preferSelected(text ? filterMatches(text, items) : items.sort((a, b) => Number(bar._state.pinned.includes(`app:${b.app?.get_id()}`)) - Number(bar._state.pinned.includes(`app:${a.app?.get_id()}`)) || a.name.localeCompare(b.name)));
        if (mode === '$' && text) {
            try {
                const argv = commandArgv(text);
                base = [{name: text, detail: 'Run in terminal · Shift+Enter runs in background', icon: 'utilities-terminal-symbolic', run: () => runCommand(argv, true, error => Main.notify('Bezel command failed', error.message)), alternate: () => runCommand(argv, false, error => Main.notify('Bezel command failed', error.message)), alternateLabel: 'Background'}];
            } catch (error) { status.text = error.message; }
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
        if (filesPending) status.text = 'Searching files…';
        showMode(mode, true);
        if ((!mode || mode === '/') && !web && text.length >= 2 && settings.get_boolean('launcher-files')) {
            const request = generation;
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                timer = 0; cancel = new Gio.Cancellable();
                const updateFiles = (files, complete) => {
                    if (dead || request !== generation) return;
                    filesPending = !complete;
                    // Reuse existing rows so newly discovered hits do not move keyboard selection.
                    const previous = new Map(fileRows.map(item => [item.file.get_uri(), item]));
                    fileRows = files.map(item => previous.get(item.file.get_uri()) ?? ({...item,
                        icon: item.folder ? 'folder-symbolic' : item.media ? 'image-x-generic-symbolic' : 'text-x-generic-symbolic',
                        run: () => openUri(item.file.get_uri()),
                        alternate: () => openUri(item.file.get_parent().get_uri()), alternateLabel: 'Show folder'}));
                    status.text = complete ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Searching…';
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
    const switchTab = prefix => {
        const scoped = collectionQuery();
        let text = scoped ? scoped[2] : parseLauncherQuery(entry.get_text()).text;
        history.length = 0;
        // `> settings` is the Bezel tab. Don't treat a leftover "settings" query as that collection.
        if (prefix === '>' && COLLECTIONS.has(text.trim().split(/\s+/)[0]?.toLowerCase()))
            text = '';
        entry.set_text(prefix ? `${prefix} ${text}` : /^[\/~]/.test(text) ? '' : text);
        entry.grab_key_focus();
    };
    const cycleTab = step => switchTab(MODE_ORDER[(MODE_ORDER.indexOf(tabKey()) + step + MODE_ORDER.length) % MODE_ORDER.length]);
    for (const [name, prefix] of [['All', ''], ['System', '>'], ['Files', '/'], ['Web', '?'], ['Run', '$'],
        ['Bezel', '> settings'], ['GNOME', '> gnome']]) {
        const button = smallButton(name, () => switchTab(prefix));
        button.accessible_name = `${name} category; Tab for next category`;
        modeButtons.push([button, prefix]); modes.add_child(button);
    }
    root._modeButtons = modeButtons;
    entry.clutter_text.connect('text-changed', () => search());
    entry.clutter_text.connect('activate', () => activate(selected));
    entry.clutter_text.connect('key-press-event', (_text, event) => {
        const key = event.get_key_symbol(), state = event.get_state();
        if (key === Clutter.KEY_Tab || key === Clutter.KEY_ISO_Left_Tab) {
            const step = key === Clutter.KEY_ISO_Left_Tab || (state & Clutter.ModifierType.SHIFT_MASK) ? -1 : 1;
            cycleTab(step);
            return Clutter.EVENT_STOP;
        }
        if ((key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) && (state & Clutter.ModifierType.SHIFT_MASK)) { activate(selected, true); return Clutter.EVENT_STOP; }
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down) return Clutter.EVENT_PROPAGATE;
        selectionMoved = true;
        selected = Math.max(0, Math.min(matches.length - 1, selected + (key === Clutter.KEY_Up ? -1 : 1))); paint(false); return Clutter.EVENT_STOP;
    });
    const changed = system.connect('installed-changed', () => {
        appCatalog = null;
        if (!parseLauncherQuery(entry.get_text()).mode) search(true);
    });
    const extras = {
        stop() {
            modeHighlight.stop();
            for (const page of stage.get_children()) page._rowHighlight?.stop();
        },
        get moving() {
            return modeHighlight.moving || [...stage.get_children()].some(page => page._rowHighlight?.moving);
        },
    };
    bar._launcherControllers.add(extras);
    const stop = () => {
        if (dead) return;
        dead = true;
        stopFiles();
        stopDevices?.(); wallpaperCancel?.cancel();
        bar._cancel('_launcherTabs');
        extras.stop();
        motion.stop();
        bar._launcherControllers.delete(extras);
        bar._cancel('_launcherScroll');
        system.disconnect(changed);
        bar._onPopupScroll = null;
    };
    bar._popupCleanups.push(stop);
    root.connect('destroy', stop);
    bar._onPopupScroll = step => { if (!matches.length) return false; selectionMoved = true; selected = Math.max(0, Math.min(matches.length - 1, selected + step)); paint(false); return true; };
    root._preparePopup = () => {
        const page = stage.get_last_child();
        if (page?.get_stage()) {
            preparePage(page);
            page.width = width;
            page._refreshPageHeight?.();
        }
        modeHighlight.sync(selectedMode());
        rowHighlight?.sync(selectedButton());
    };
    modes.connect('notify::allocation', () => modeHighlight.sync(selectedMode()));
    bar._launcherEntry = entry; bar._launcherWidget = root;
    search(); return root;
}
