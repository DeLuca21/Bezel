import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import {DASHBOARD_WIDGETS, readDashboard, saveDashboard, DATE_FORMATS, timePattern, settingChoice, settingFlag} from './config.js';
import {allowsMotion} from './compat.js';
import {profileAvatar} from './profile.js';
import {weatherWidget} from './weather.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const text = (theme, value, size = 14, muted = false) => new St.Label({text: value,
    x_align: Clutter.ActorAlign.CENTER, style: `color: ${muted ? theme.muted : theme.fg}; font-size: ${size}px;`});
const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;', x_expand: true});
const card = theme => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
    style: `background-color: ${theme.surface}; border-radius: 20px; padding: 18px; spacing: 12px;`});

export function buildDashboard(bar) {
    const theme = bar._theme;
    const settings = bar._overlay._settings;
    let layout = readDashboard(settings);
    let editing = false;
    const root = column();
    const tabs = new St.BoxLayout({style: `spacing: 8px; border-bottom: 1px solid ${theme.border}; padding-bottom: 10px;`});
    const stage = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
    root.add_child(tabs);
    root.add_child(stage);
    const buttons = new Map();
    const order = ['overview', 'media', 'performance', 'workspaces'];
    let current = null;
    let viewCleanups = [];
    let pendingCleanups = [];
    const reader = metricsReader();
    const reset = () => {
        bar._cancel('_dashboardTimer');
        for (const cleanup of [...viewCleanups, ...pendingCleanups])
            cleanup();
        viewCleanups = [];
        pendingCleanups = [];
        stage.destroy_all_children();
    };
    bar._popupCleanups.push(reset);
    const persist = () => bar._overlay.skipRebuild(() => saveDashboard(settings, layout));
    const sizePage = view => {
        bar._persistPopup();
        const width = Math.max(1, (bar._popout?.width ?? 480) - 36);
        const height = bar._stackHeight(tabs, width, 200) + bar._stackHeight(view, width, 900) + 48;
        bar._popupLockedHeight = false;
        bar._setPopupHeight(height);
        bar._popupLockedHeight = true;
    };
    const fill = (id, host) => {
        const items = layout[id] ?? [];
        const row = new St.BoxLayout({
            orientation: bar._popout.width < 740 || items.filter(item => item.size !== 2).length <= 1
                ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 12px;', x_expand: true,
        });
        const rest = column();
        for (const item of items) {
            const widget = widgetFor(bar, item.id, theme, reader, pendingCleanups, () => {
                editing = !editing;
                syncEdit();
                show(id, true);
            }, editing);
            if (!widget)
                continue;
            const wrapped = editing ? editWrap(bar, theme, item, id, layout, persist, () => show(id, true), widget) : widget;
            if (item.size === 2 || ['actions', 'weather', 'workspaces'].includes(item.id))
                rest.add_child(wrapped);
            else
                row.add_child(wrapped);
        }
        if (row.get_n_children())
            host.add_child(row);
        if (rest.get_n_children())
            host.add_child(rest);
        if (editing)
            host.add_child(addRow(bar, theme, id, layout, persist, () => show(id, true)));
    };
    const show = (id, instant = false) => {
        if (id === current && stage.get_n_children() && !instant)
            return;
        bar._cancel('_dashboardTimer');
        for (const [key, button] of buttons)
            button.style = `padding: 10px 12px; border-radius: 12px; color: ${key === id ? theme.accent : theme.muted}; ${key === id ? `background-color: ${theme.surface};` : ''}`;
        pendingCleanups = [];
        const view = column();
        fill(id, view);
        const previous = stage.get_first_child();
        const commit = () => {
            for (const cleanup of viewCleanups)
                cleanup();
            viewCleanups = pendingCleanups;
            pendingCleanups = [];
        };
        while (stage.get_n_children() > 1)
            stage.get_first_child().destroy();
        const motion = !instant && previous && allowsMotion(St.Settings.get(), St.ReducedMotion);
        const onStage = Boolean(bar._popout?.get_stage?.());
        if (!motion) {
            commit();
            previous?.destroy();
            stage.add_child(view);
            current = id;
            if (onStage)
                sizePage(view);
            return;
        }
        const dir = order.indexOf(id) >= order.indexOf(current) ? 1 : -1;
        const width = Math.max(80, (bar._popout?.width ?? 480) - 36);
        view.translation_x = dir * width;
        stage.add_child(view);
        if (onStage)
            sizePage(view);
        previous.ease({
            translation_x: -dir * width, duration: 240, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { previous.destroy(); commit(); },
        });
        view.ease({
            translation_x: 0, duration: 240, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        current = id;
    };
    for (const [id, title, icon] of [
        ['overview', 'Dashboard', 'view-grid-symbolic'], ['media', 'Media', 'audio-x-generic-symbolic'],
        ['performance', 'Performance', 'utilities-system-monitor-symbolic'], ['workspaces', 'Workspaces', 'view-paged-symbolic'],
    ]) {
        const content = new St.BoxLayout({orientation: bar._popout.width < 740 ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL, style: 'spacing: 8px;', x_align: Clutter.ActorAlign.CENTER});
        content.add_child(new St.Icon({icon_name: icon, icon_size: 16, x_align: Clutter.ActorAlign.CENTER}));
        content.add_child(new St.Label({text: title}));
        const button = new St.Button({child: content, can_focus: true, x_expand: true});
        button.connect('clicked', () => show(id));
        tabs.add_child(button);
        buttons.set(id, button);
    }
    const edit = new St.Button({
        can_focus: true, accessible_name: 'Customize dashboard',
        style: 'padding: 8px;',
        child: new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 14, style: `color: ${theme.muted};`}),
    });
    const syncEdit = () => {
        edit.child.icon_name = editing ? 'object-select-symbolic' : 'document-edit-symbolic';
        edit.child.style = `color: ${editing ? theme.accent : theme.muted};`;
    };
    edit.connect('clicked', () => {
        editing = !editing;
        syncEdit();
        if (current)
            show(current, true);
    });
    tabs.add_child(edit);
    root._selectTab = id => show(id, true);
    show('overview', true);
    return root;
}

function widgetFor(bar, id, theme, reader, pendingCleanups, toggleEdit, editing) {
    if (id === 'identity') {
        const identity = card(theme);
        identity.add_child(profileAvatar(theme));
        identity.add_child(text(theme, GLib.get_real_name(), 16));
        identity.add_child(text(theme, 'GNOME · Bezel', 12, true));
        const clock = text(theme, '', 38);
        const date = text(theme, '', 12, true);
        identity.add_child(clock);
        identity.add_child(date);
        const update = () => {
            const settings = bar._overlay._settings;
            const twelve = settingChoice(settings, 'dashboard-time-format', '24h', ['24h', '12h']) === '12h';
            const seconds = settingFlag(settings, 'dashboard-clock-seconds');
            const dateKey = settingChoice(settings, 'dashboard-date-format', 'long', Object.keys(DATE_FORMATS));
            const now = GLib.DateTime.new_now_local();
            clock.text = (now.format(timePattern(twelve, seconds)) ?? '').replace(/^0/, '');
            date.text = (now.format(DATE_FORMATS[dateKey]?.format ?? DATE_FORMATS.long.format) ?? '').replace(/\s+/g, ' ').trim();
            bar._later('_dashboardTimer', seconds ? 1000 : 10000, update);
        };
        update();
        return identity;
    }
    if (id === 'calendar') {
        const calendar = card(theme);
        calendar.add_child(bar._monthGrid());
        return calendar;
    }
    if (id === 'media') {
        const before = bar._popupCleanups.length;
        const media = bar._mediaCard(true, bar._popoutId === 'dashboard' && bar._popout?.width ? 84 : 84);
        pendingCleanups.push(...bar._popupCleanups.splice(before));
        return media;
    }
    if (id === 'actions') {
        const actions = new St.BoxLayout({style: 'spacing: 10px;'});
        const chip = (title, icon, run, close = false) => {
            const button = new St.Button({
                can_focus: true, x_expand: true,
                style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 14px; padding: 12px 10px;`,
                child: new St.BoxLayout({style: 'spacing: 8px;'}),
            });
            button.child.add_child(new St.Icon({icon_name: icon, icon_size: 16, style: `color: ${theme.fg};`}));
            button.child.add_child(new St.Label({text: title}));
            button.connect('clicked', () => { if (close) bar._close(); run(); });
            return button;
        };
        actions.add_child(chip('Applications', 'view-app-grid-symbolic', () => Main.overview.showApps(), true));
        actions.add_child(chip('Settings', 'preferences-system-symbolic', () => {
            try {
                bar._overlay.openPreferences();
            } catch (error) {
                Main.notifyError('Could not open Settings', error.message);
            }
        }, true));
        actions.add_child(chip(editing ? 'Done' : 'Customize dashboard',
            editing ? 'object-select-symbolic' : 'document-edit-symbolic', toggleEdit));
        return actions;
    }
    if (id === 'weather')
        return weatherWidget(bar);
    if (['cpu', 'memory', 'temp'].includes(id)) {
        const meterSize = Math.min(150, Math.max(72, (bar._popout.width - 108) / 3 - 36));
        const titles = {cpu: 'CPU usage', memory: 'Memory', temp: 'CPU temperature'};
        const meter = ring(theme, titles[id], meterSize);
        const update = () => {
            const stats = reader();
            if (id === 'cpu')
                meter.update(stats.cpu, stats.cpu === null ? '…' : `${Math.round(stats.cpu * 100)}%`);
            else if (id === 'memory')
                meter.update(stats.memoryRatio, `${stats.memoryUsed.toFixed(1)} GiB`);
            else
                meter.update(stats.temperature === null ? 0 : stats.temperature / 100,
                    stats.temperature === null ? 'N/A' : `${Math.round(stats.temperature)}°C`);
            bar._later('_dashboardTimer', 1500, update);
        };
        update();
        return meter.actor;
    }
    if (id === 'workspaces') {
        const manager = global.workspace_manager;
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout(), x_expand: true});
        const layout = grid.layout_manager;
        layout.column_spacing = 12;
        layout.row_spacing = 12;
        for (let i = 0; i < manager.n_workspaces; i++) {
            const workspace = manager.get_workspace_by_index(i);
            const box = card(theme);
            const active = i === manager.get_active_workspace_index();
            box.add_child(text(theme, `Workspace ${i + 1}${active ? ' · Active' : ''}`, 16));
            const windows = workspace.list_windows().filter(win => !win.skip_taskbar);
            const icons = new St.BoxLayout({style: 'spacing: 8px;', x_align: Clutter.ActorAlign.CENTER});
            for (const win of windows.slice(0, 6)) {
                const app = Shell.WindowTracker.get_default().get_window_app(win);
                if (app)
                    icons.add_child(app.create_icon_texture(28));
            }
            box.add_child(icons);
            box.add_child(text(theme, windows.length ? `${windows.length} open windows` : 'Empty workspace', 12, true));
            const button = new St.Button({child: box, can_focus: true, x_expand: true, style_class: 'bezel-action'});
            button.connect('clicked', () => { workspace.activate(global.get_current_time()); bar._close(true); });
            layout.attach(button, i % 2, Math.floor(i / 2), 1, 1);
        }
        return grid;
    }
    return null;
}

function editWrap(bar, theme, item, tab, layout, persist, refresh, child) {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 6px;'});
    const tools = new St.BoxLayout({style: 'spacing: 6px;', x_align: Clutter.ActorAlign.END});
    const shift = delta => {
        const list = layout[tab];
        const index = list.findIndex(entry => entry.id === item.id);
        const next = index + delta;
        if (index < 0 || next < 0 || next >= list.length)
            return;
        [list[index], list[next]] = [list[next], list[index]];
        persist();
        refresh();
    };
    for (const [label, run] of [
        ['‹', () => shift(-1)],
        [item.size === 2 ? 'Narrow' : 'Wide', () => {
            item.size = item.size === 2 ? 1 : 2;
            persist();
            refresh();
        }],
        ['›', () => shift(1)],
        ['Remove', () => {
            layout[tab] = layout[tab].filter(entry => entry.id !== item.id);
            persist();
            refresh();
        }],
    ]) {
        const button = new St.Button({
            label, can_focus: true,
            style: `padding: 4px 8px; border-radius: 8px; color: ${theme.muted}; background-color: ${theme.surface};`,
        });
        button.connect('clicked', run);
        tools.add_child(button);
    }
    box.add_child(tools);
    box.add_child(child);
    return box;
}

function addRow(bar, theme, tab, layout, persist, refresh) {
    const used = new Set(layout[tab].map(item => item.id));
    const addable = Object.entries(DASHBOARD_WIDGETS)
        .filter(([id, spec]) => spec.tabs.includes(tab) && !used.has(id));
    const row = new St.BoxLayout({style: 'spacing: 8px;', x_align: Clutter.ActorAlign.START});
    row.add_child(text(theme, addable.length ? 'Add' : 'This page has every widget', 12, true));
    for (const [id, spec] of addable) {
        const button = new St.Button({
            label: spec.label, can_focus: true,
            style: `padding: 6px 10px; border-radius: 10px; background-color: ${theme.surface}; color: ${theme.fg};`,
        });
        button.connect('clicked', () => {
            layout[tab].push({id, size: 1});
            persist();
            refresh();
        });
        row.add_child(button);
    }
    return row;
}

function ring(theme, title, size = 150) {
    const actor = card(theme);
    const stack = new St.Widget({width: size, height: size, layout_manager: new Clutter.BinLayout()});
    const paint = new St.DrawingArea({width: size, height: size});
    const value = text(theme, '…', size < 120 ? 16 : 24);
    stack.add_child(paint);
    stack.add_child(value);
    actor.add_child(stack);
    actor.add_child(text(theme, title, 13, true));
    let ratio = 0;
    paint.connect('repaint', area => {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            cr.translate(w / 2, h / 2);
            cr.setLineWidth(7);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (const [color, end] of [[theme.border, 1], [theme.accent, ratio]]) {
                cr.setSourceRGB(...[1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255));
                cr.arc(0, 0, Math.min(w, h) / 2 - 8, Math.PI * .75, Math.PI * (.75 + 1.5 * end));
                cr.stroke();
            }
        } finally { cr.$dispose(); }
    });
    return {actor, update: (next, label) => { ratio = Math.max(0, Math.min(1, next ?? 0)); value.text = label; paint.queue_repaint(); }};
}

function read(path) {
    try { return new TextDecoder().decode(GLib.file_get_contents(path)[1]); } catch { return ''; }
}

function metricsReader() {
    let previous = null;
    let temperaturePath = null;
    for (let i = 0; i < 32; i++) {
        const path = `/sys/class/thermal/thermal_zone${i}`;
        if (/x86_pkg_temp|cpu|k10temp/i.test(read(`${path}/type`))) { temperaturePath = `${path}/temp`; break; }
    }
    return () => {
        const values = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
        const total = values.reduce((a, b) => a + b, 0);
        const idle = (values[3] ?? 0) + (values[4] ?? 0);
        const cpu = previous && total > previous.total ? 1 - (idle - previous.idle) / (total - previous.total) : null;
        previous = {total, idle};
        const mem = read('/proc/meminfo');
        const memoryTotal = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1] ?? 0) / 1048576;
        const available = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1] ?? 0) / 1048576;
        const up = Number(read('/proc/uptime').split(' ')[0]);
        const temp = temperaturePath ? Number(read(temperaturePath)) / 1000 : null;
        return {cpu, memoryTotal, memoryUsed: memoryTotal - available,
            memoryRatio: memoryTotal ? (memoryTotal - available) / memoryTotal : 0,
            uptime: `${Math.floor(up / 3600)}h ${Math.floor(up % 3600 / 60)}m`,
            temperature: temp && Number.isFinite(temp) ? temp : null};
    };
}
