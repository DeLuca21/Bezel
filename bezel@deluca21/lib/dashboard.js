import Cairo from 'cairo';
import {applyWidth, cellWidths, cloneRows, dropTarget, findCard, moveCard, pageColumns, removeCard, shareLabel, spanOf} from './dashboardGeometry.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import {DASHBOARD_WIDGETS, dashboardPages, readDashboard, saveDashboard, DATE_FORMATS, timePattern, settingChoice, settingFlag} from './config.js';
import {allowsMotion} from './compat.js';
import {profileAvatar} from './profile.js';
import {weatherWidget, forecastCard} from './weather.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UNIT = 272;
const GAP = 12;
const text = (theme, value, size = 14, muted = false) => new St.Label({text: value,
    x_align: Clutter.ActorAlign.CENTER, style: `color: ${muted ? theme.muted : theme.fg}; font-size: ${size}px;`});
const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;', x_expand: true});
const card = theme => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
    style: `background-color: ${theme.surface}; border-radius: 16px; padding: 12px; spacing: 8px;`});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function buildDashboard(bar) {
    const theme = bar._theme;
    const settings = bar._overlay._settings;
    let layout = readDashboard(settings);
    let editing = false;
    const root = column();
    const tabs = new St.BoxLayout({style: `spacing: 8px; border-bottom: 1px solid ${theme.border}; padding-bottom: 10px;`});
    const stage = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
    const tabHeader = new St.BoxLayout({style: 'spacing: 8px;', x_expand: false, x_align: Clutter.ActorAlign.CENTER});
    const tabScroll = new St.ScrollView({name: 'bezel-dashboard-tabs', hscrollbar_policy: St.PolicyType.AUTOMATIC,
        vscrollbar_policy: St.PolicyType.NEVER, width: 1, x_expand: false});
    tabScroll.set_child(tabs);
    const tabLayer = new St.Widget({layout_manager: new Clutter.BinLayout(),
        x_expand: false, clip_to_allocation: true});
    const highlight = new St.Widget({name: 'bezel-dashboard-tab-highlight', reactive: false, x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START, opacity: 0, width: 1, height: 1,
        style: `background-color: ${theme.surface}; border-radius: 12px;`});
    // A zero-sized overlay keeps the highlight out of preferred-size negotiation.
    const highlightLayer = new St.Widget({width: 0, height: 0,
        x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START});
    highlightLayer.add_child(highlight);
    tabLayer.add_child(highlightLayer);
    tabLayer.add_child(tabScroll);
    const headerBalance = new St.Widget({width: 30});
    tabHeader.add_child(headerBalance);
    tabHeader.add_child(tabLayer);
    root.add_child(tabHeader);
    root.add_child(stage);
    const buttons = new Map();
    const pages = dashboardPages(layout);
    layout._pages = pages;
    const order = () => pages.map(page => page.id);
    let current = null;
    let highlightTimeline = null;
    let highlightFrom = null;
    let highlightProgress = 1;
    let pageDuration = 0;
    let pageTimeline = null;
    let closed = false;
    root._stopDashboardMotion = () => {
        pageTimeline?.stop();
        highlightTimeline?.stop();
        pageTimeline = highlightTimeline = null;
        pageDuration = 0;
    };
    const syncHighlight = () => {
        if (closed) return;
        const button = buttons.get(current);
        if (!button?.get_stage() || button.width <= 0) return;
        const [bx, by] = button.get_transformed_position();
        const [lx, ly] = highlightLayer.get_transformed_position();
        const target = [bx - lx, by - ly, button.width, button.height];
        if (!target.every(Number.isFinite)) return;
        const from = highlightFrom ?? target;
        const values = target.map((value, i) => from[i] + (value - from[i]) * highlightProgress);
        highlight.set_position(values[0], values[1]);
        highlight.set_size(values[2], values[3]);
        highlight.opacity = 255;
    };
    const moveHighlight = duration => {
        highlightTimeline?.stop();
        highlightTimeline = null;
        highlightFrom = highlight.opacity ? [highlight.x, highlight.y, highlight.width, highlight.height] : null;
        highlightProgress = duration ? 0 : 1;
        syncHighlight();
        if (!duration) return;
        const timeline = new Clutter.Timeline({duration, actor: tabLayer});
        highlightTimeline = timeline;
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        timeline.connect('new-frame', () => { highlightProgress = timeline.get_progress(); syncHighlight(); });
        timeline.connect('completed', () => {
            highlightTimeline = null;
            highlightProgress = 1;
            highlightFrom = null;
            syncHighlight();
        });
        timeline.start();
    };
    // ScrollView minimum sizes can exceed the animated viewport while two pages
    // coexist. Anchor the header to the actual drawer, not that allocation.
    const centerHeader = () => {
        if (closed || !bar._popout || !tabHeader.get_stage() || tabHeader.width <= 0) return;
        const [x] = tabScroll.get_transformed_position();
        const desired = bar._popout.x + bar._popout.width / 2;
        const offset = desired - (x + tabScroll.width / 2);
        if (Number.isFinite(offset) && Math.abs(offset) > 0.01)
            tabHeader.translation_x += offset;
    };
    root._syncDashboardHeader = centerHeader;
    root.connect('notify::allocation', centerHeader);
    tabHeader.connect('notify::allocation', centerHeader);
    tabScroll.connect('notify::allocation', centerHeader);
    tabScroll.hadjustment.connectObject('notify::value', syncHighlight, root);
    const reader = metricsReader();
    const disposeView = view => {
        if (!view || view._dashDisposed) return;
        view?._dashCleanup?.();
        view?.remove_all_transitions();
        view?.destroy();
    };
    const reset = () => {
        closed = true;
        pageTimeline?.stop();
        pageTimeline = null;
        highlightTimeline?.stop();
        highlightTimeline = null;
        for (const view of stage.get_children())
            disposeView(view);
        // Cancelling a gesture can reflow once; cancel its tab-scroll callback
        // after view cleanup so nothing touches the popup after destruction.
        bar._cancel('_dashboardTabScroll');
    };
    bar._popupCleanups.push(reset);
    root.connect('destroy', () => { closed = true; pageTimeline?.stop(); highlightTimeline?.stop(); });
    const persist = () => bar._overlay.skipRebuild(() => saveDashboard(settings, layout));
    const pageWidth = slots => {
        const inner = slots * UNIT + Math.max(0, slots - 1) * GAP;
        const available = (bar._monitor?.width || 1400) - (bar._side?.left || 0) - (bar._side?.right || 0) - 32;
        return Math.max(UNIT + 36, Math.min(available, inner + 36));
    };
    const sizePage = (view, id) => {
        const slots = view._dashColumns || pageColumns(layout[id] ?? []);
        const width = pageWidth(slots);
        bar._popupWidth = width;
        // Each page keeps its final layout while the surrounding viewport morphs.
        view.width = width - 36;
        view.x_expand = false;
        view.x_align = Clutter.ActorAlign.CENTER;
        view.y_expand = false;
        view.y_align = Clutter.ActorAlign.START;
        const headerWidth = Math.min(...pages.map(page => pageWidth(pageColumns(layout[page.id] ?? []))));
        const editWidth = edit.get_stage() ? edit.get_preferred_width(-1)[1] : 30;
        headerBalance.width = editWidth;
        const naturalTabs = tabs.get_stage() ? tabs.get_preferred_width(-1)[1] : 1;
        tabScroll.width = Math.min(naturalTabs, Math.max(96, headerWidth - 36 - editWidth * 2 - 16));
        tabHeader.width = tabScroll.width + editWidth * 2 + 16;
        // Building an incoming page must not resize the visible outgoing page.
        if (!view.get_stage() || id !== current) return;
        view._preparePage?.();
        bar._later('_dashboardTabScroll', 20, () => {
            const button = buttons.get(id);
            const adjustment = tabScroll.hadjustment;
            if (!button || current !== id || !adjustment)
                return;
            const left = button.x;
            const right = left + button.width;
            if (left < adjustment.value)
                adjustment.value = left;
            else if (right > adjustment.value + adjustment.page_size)
                adjustment.value = Math.max(0, right - adjustment.page_size);
        });
        // Width is known from the rows. Height is measured once the popup
        // exists, not while this view is still being built.
        if (!view.get_stage() || !bar._popout?.get_stage?.() || !bar._popupContent)
            return;
        const others = stage.get_children().filter(child => child !== view && child.visible);
        for (const child of others) child.hide();
        bar._popupLockedHeight = false;
        const height = bar._fitPopup(true, width);
        for (const child of others) child.show();
        if (Number.isFinite(height)) bar._setDashboardSize(width, height, pageDuration);
    };
    const fill = (id, host, updates, cleanups) => {
        host._dashPage = true;
        const rows = layout[id] ?? [];
        const cards = new Map();
        const refresh = () => show(id, true);
        let picker = null;
        const closePicker = () => {
            picker?.destroy();
            picker = null;
        };
        const toolButton = (label, callback) => {
            const button = new St.Button({label, can_focus: true,
                style: `padding: 6px 10px; border-radius: 8px; background-color: ${theme.surface}; color: ${theme.fg};`});
            button.connect('clicked', callback);
            return button;
        };
        const openPicker = (rowIndex, gapIndex, parent) => {
            closePicker();
            const taken = new Set((layout[id] ?? []).flatMap(row => row.map(cell => cell.id).filter(Boolean)));
            const addable = Object.entries(DASHBOARD_WIDGETS).filter(([widgetId]) => !taken.has(widgetId));
            const scroll = new St.ScrollView({
                overlay_scrollbars: true, reactive: true, x_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                height: Math.min(220, Math.max(64, addable.length * 40 || 64)),
            });
            const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 4px;'});
            scroll.set_child(list);
            if (!addable.length)
                list.add_child(text(theme, 'All cards are already on this page', 13, true));
            for (const [widgetId, spec] of addable) {
                const button = new St.Button({label: spec.label, can_focus: true, x_expand: true,
                    style: `padding: 8px 10px; border-radius: 10px; background-color: ${theme.surface}; color: ${theme.fg};`});
                button.connect('clicked', () => {
                    const page = layout[id] ?? [];
                    const row = page[rowIndex] ?? [];
                    if (gapIndex != null && row[gapIndex]?.gap)
                        row[gapIndex] = {id: widgetId, span: spanOf(row[gapIndex])};
                    else
                        row.push({id: widgetId, span: 1});
                    page[rowIndex] = row;
                    layout[id] = page;
                    persist();
                    refresh();
                });
                list.add_child(button);
            }
            parent.add_child(scroll);
            picker = scroll;
            bar._popupLockedHeight = false;
            bar._fitPopup();
            bar._later('_fitPopupId', 40, () => bar._fitPopup());
        };
        const editor = {
            host,
            cards,
            inner: 0,
            later: 0,
            reflow: (entries = layout[id], animate = true) => {
                if (editor.later)
                    global.compositor.get_laters().remove(editor.later);
                editor.later = 0;
                closePicker();
                const positions = new Map();
                const measuredRows = [];
                for (const actor of cards.values()) {
                    if (actor === editor.floating)
                        continue;
                    if (actor.get_stage())
                        positions.set(actor, actor.get_transformed_position());
                    actor.remove_all_transitions();
                    actor.translation_x = actor.translation_y = 0;
                    actor.get_parent()?.remove_child(actor);
                }
                editor.placeholder?.get_parent()?.remove_child(editor.placeholder);
                for (const row of host.get_children().filter(actor => actor._dashRow))
                    row.destroy();
                host._dashColumns = pageColumns(entries);
                editor.inner = pageWidth(host._dashColumns) - 36;
                ensureGapIds(entries);
                entries.forEach((rowItems, rowIndex) => {
                    const shell = new St.BoxLayout({
                        orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                        style: editing
                            ? `spacing: 6px; padding: 6px; border: 1px dashed ${theme.border}; border-radius: 14px;`
                            : 'spacing: 0;',
                    });
                    shell._dashRow = true;
                    const band = new St.BoxLayout({style: `spacing: ${GAP}px;`, x_expand: true});
                    band._dashBand = true;
                    const widths = cellWidths(editor.inner - (editing ? 14 : 0), rowItems, GAP);
                    const placed = [];
                    rowItems.forEach((entry, cellIndex) => {
                        let actor;
                        if (entry.id && entry.id === editor.floating?._dashId)
                            actor = editor.placeholder;
                        else if (entry.gap) {
                            actor = gapCell(theme, editing, widths[cellIndex], entry, () => openPicker(rowIndex, cellIndex, shell), () => {
                                layout[id][rowIndex] = layout[id][rowIndex].filter((_, index) => index !== cellIndex);
                                layout[id] = layout[id].filter(row => row.length);
                                persist();
                                refresh();
                            }, (box, event) => editor.startMove?.(box, entry, event));
                        } else
                            actor = cards.get(entry.id);
                        if (!actor)
                            return;
                        actor.width = widths[cellIndex];
                        actor._dashCell = true;
                        actor._dashGap = Boolean(entry.gap);
                        actor.y_align = Clutter.ActorAlign.START;
                        actor.y_expand = false;
                        band.add_child(actor);
                        placed.push({entry, actor, width: widths[cellIndex]});
                    });
                    shell.add_child(band);
                    if (editing && !editor.floating) {
                        const tools = new St.BoxLayout({style: 'spacing: 6px;'});
                        tools.add_child(toolButton('Add card', () => openPicker(rowIndex, null, shell)));
                        tools.add_child(toolButton('Add gap', () => {
                            layout[id][rowIndex].push({gap: true, span: 1});
                            persist();
                            refresh();
                        }));
                        if (!rowItems.some(cell => cell.id && !cell.gap)) {
                            tools.add_child(toolButton('Remove row', () => {
                                layout[id].splice(rowIndex, 1);
                                persist();
                                refresh();
                            }));
                        }
                        shell.add_child(tools);
                    }
                    host.insert_child_at_index(shell, rowIndex);
                    measuredRows.push(placed);
                });
                let prepared = false;
                host._preparePage = () => {
                    if (prepared || !host.get_stage()) return;
                    prepared = true;
                    for (const placed of measuredRows) {
                        for (const item of placed) {
                            if (!item.entry.gap)
                                applyCardSize(item.actor, item.entry, item.width, placed.map(cell => cell.entry));
                        }
                        equalizeRow(placed);
                    }
                };
                sizePage(host, id);
                editor.later = global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
                    editor.later = 0;
                    host._preparePage();
                    sizePage(host, id);
                    if (!animate || editor.floating || !allowsMotion(St.Settings.get(), St.ReducedMotion))
                        return GLib.SOURCE_REMOVE;
                    for (const [actor, [x, y]] of positions) {
                        const [nx, ny] = actor.get_transformed_position();
                        if (![x, y, nx, ny].every(Number.isFinite))
                            continue;
                        actor.translation_x = x - nx;
                        actor.translation_y = y - ny;
                        actor.ease({translation_x: 0, translation_y: 0, duration: 150,
                            mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                    }
                    return GLib.SOURCE_REMOVE;
                });
            },
        };
        editor.startMove = (box, entry, event) => startDashboardDrag({
            bar, theme, editor, tab: id, layout, persist, refresh, box, item: entry,
        }, event);
        const toggleEdit = () => {
            editing = !editing;
            syncEdit();
            show(id, true);
        };
        cleanups.push(() => {
            editor.cancel?.();
            closePicker();
            if (editor.later)
                global.compositor.get_laters().remove(editor.later);
            editor.later = 0;
        });
        for (const rowItems of rows) {
            for (const item of rowItems) {
                if (!item.id || cards.has(item.id))
                    continue;
                const widget = widgetFor(bar, item.id, theme, updates, cleanups, toggleEdit, editing, {
                    slots: pageColumns(rows),
                });
                if (!widget)
                    continue;
                const wrapped = editing ? editWrap(bar, theme, item, id, layout, persist, refresh, widget, editor) : widget;
                wrapped.x_expand = false;
                cards.set(item.id, wrapped);
            }
        }
        editor.reflow(rows, false);
        if (editing) {
            const addRow = toolButton('Add row', () => {
                layout[id].push([{gap: true, span: 1}]);
                persist();
                refresh();
            });
            addRow.x_align = Clutter.ActorAlign.START;
            host.add_child(addRow);
            const controls = new St.BoxLayout({style: 'spacing: 8px; padding-top: 8px;'});
            const page = pages.find(entry => entry.id === id);
            const name = new St.Entry({hint_text: page.title, can_focus: true,
                accessible_name: 'Page name', x_expand: true, style: `padding: 8px; background-color: ${theme.surface}; border-radius: 8px;`});
            const rename = () => {
                const title = name.text.trim().slice(0, 40) || 'Page';
                if (!pages.includes(page) || title === page.title)
                    return;
                page.title = title;
                const button = buttons.get(id);
                button.child.get_last_child().text = title;
                button.accessible_name = title;
                persist();
            };
            name.clutter_text.connect('key-focus-in', () => { if (!name.text) name.text = page.title; });
            name.clutter_text.connect('activate', rename);
            name.clutter_text.connect('key-focus-out', rename);
            controls.add_child(name);
            const action = (label, callback) => {
                const button = new St.Button({label, can_focus: true,
                    style: `padding: 8px 10px; background-color: ${theme.surface}; border-radius: 8px;`});
                button.connect('clicked', callback);
                controls.add_child(button);
                return button;
            };
            action('Add page', () => {
                const key = `page-${GLib.get_monotonic_time()}`;
                pages.push({id: key, title: `Page ${pages.length + 1}`});
                layout[key] = [];
                persist();
                syncTabs();
                show(key, true);
            });
            const remove = action('Remove page', () => {
                if (pages.length <= 1)
                    return;
                const index = pages.findIndex(entry => entry.id === id);
                pages.splice(index, 1);
                delete layout[id];
                persist();
                syncTabs();
                show(pages[Math.min(index, pages.length - 1)].id, true);
            });
            remove.reactive = pages.length > 1;
            remove.opacity = pages.length > 1 ? 255 : 100;
            host.add_child(controls);
        }
    };
    const show = (id, instant = false) => {
        if (id === current && stage.get_n_children() && !instant)
            return;
        if (current !== null)
            bar._persistPopup();
        for (const [key, button] of buttons)
            button.style = `padding: 10px 12px; border-radius: 12px; color: ${key === id ? theme.accent : theme.muted}; `;
        for (const page of stage.get_children()) page._dashUpdates?.stop();
        pageTimeline?.stop();
        pageTimeline = null;
        const view = column();
        const cleanups = [];
        const updates = pageUpdates(bar, reader);
        view._dashUpdates = updates;
        fill(id, view, updates, cleanups);
        let disposed = false;
        view._dashCleanup = () => {
            if (disposed)
                return;
            disposed = true;
            view._dashDisposed = true;
            updates.stop();
            for (const cleanup of cleanups)
                cleanup();
        };
        view.connect('destroy', view._dashCleanup);
        updates.start();
        while (stage.get_n_children() > 1)
            disposeView(stage.get_first_child());
        const previous = stage.get_first_child();
        previous?.remove_all_transitions();
        const motion = !instant && previous && bar._state.animationDuration > 0 && bar._popupProgress === 1
            && allowsMotion(St.Settings.get(), St.ReducedMotion);
        pageDuration = motion ? bar._state.animationDuration : 0;
        if (!motion) {
            disposeView(previous);
            stage.add_child(view);
            current = id;
            sizePage(view, id);
            moveHighlight(0);
            return;
        }
        const dir = order().indexOf(id) >= order().indexOf(current) ? 1 : -1;
        const width = Math.max(80, pageWidth(pageColumns(layout[id] ?? [])) - 36);
        view.translation_x = dir * width;
        stage.add_child(view);
        current = id;
        sizePage(view, id);
        moveHighlight(pageDuration);
        const from = previous.translation_x;
        const timeline = new Clutter.Timeline({duration: Math.max(1, pageDuration), actor: stage});
        pageTimeline = timeline;
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        timeline.connect('new-frame', () => {
            const progress = timeline.get_progress();
            previous.translation_x = from + (-dir * width - from) * progress;
            view.translation_x = dir * width * (1 - progress);
        });
        timeline.connect('completed', () => {
            pageTimeline = null;
            view.translation_x = 0;
            disposeView(previous);
            pageDuration = 0;
            if (!view._dashDisposed && current === id)
                sizePage(view, id);
        });
        timeline.start();
        current = id;
    };
    const syncTabs = () => {
        for (const button of buttons.values())
            button.destroy();
        buttons.clear();
        for (const [index, {id, title}] of pages.entries()) {
            const content = new St.BoxLayout({style: 'spacing: 8px;', x_align: Clutter.ActorAlign.CENTER});
            const icon = {overview: 'view-grid-symbolic', media: 'audio-x-generic-symbolic',
                performance: 'utilities-system-monitor-symbolic', workspaces: 'view-paged-symbolic'}[id] ?? 'view-grid-symbolic';
            content.add_child(new St.Icon({icon_name: icon, icon_size: 16}));
            content.add_child(new St.Label({text: title}));
            const button = new St.Button({child: content, can_focus: true, x_expand: false, accessible_name: title});
            button.connect('clicked', () => show(id, editing));
            button.connect('notify::allocation', syncHighlight);
            tabs.insert_child_at_index(button, index);
            buttons.set(id, button);
        }
    };
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
    tabHeader.add_child(edit);
    syncTabs();
    root._preparePopup = () => {
        const view = stage.get_last_child();
        if (view) sizePage(view, current);
        syncHighlight();
    };
    root._selectTab = (id, instant = true) => show(layout[id] ? id : pages[0].id, instant);
    show(pages[0].id, true);
    return root;
}

// One timer per visible page, with a single /proc sample for all due meters.
function pageUpdates(bar, reader) {
    const jobs = [];
    let stopped = false;
    const tick = () => {
        if (stopped || !jobs.length) return;
        const now = GLib.get_monotonic_time() / 1000;
        let stats;
        for (const job of jobs) {
            if (job.next > now) continue;
            job.update(job.metrics ? (stats ??= reader()) : undefined);
            job.next = now + job.interval;
        }
        const delay = Math.max(1, Math.ceil(Math.min(...jobs.map(job => job.next)) - now));
        bar._later('_dashboardTimer', delay, tick);
    };
    return {
        add(interval, update, metrics = false) { jobs.push({interval, update, metrics, next: 0}); },
        start: tick,
        stop() { if (!stopped) { stopped = true; bar._cancel('_dashboardTimer'); } },
    };
}

function widgetFor(bar, id, theme, updates, cleanups, toggleEdit, editing, page = {}) {
    if (id === 'identity') {
        const identity = card(theme);
        const avatar = profileAvatar(theme, 64);
        const name = text(theme, GLib.get_real_name(), 15);
        const distro = text(theme, 'GNOME · Bezel', 11, true);
        identity.add_child(avatar);
        identity.add_child(name);
        identity.add_child(distro);
        const clock = text(theme, '', 26);
        const date = text(theme, '', 12, true);
        clock.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        date.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        identity.add_child(clock);
        identity.add_child(date);
        identity._dashFactor = 1;
        const update = () => {
            const settings = bar._overlay._settings;
            const twelve = settingChoice(settings, 'dashboard-time-format', '24h', ['24h', '12h']) === '12h';
            const seconds = settingFlag(settings, 'dashboard-clock-seconds');
            const dateKey = settingChoice(settings, 'dashboard-date-format', 'long', Object.keys(DATE_FORMATS));
            const now = GLib.DateTime.new_now_local();
            const factor = identity._dashFactor || 1;
            const size = Math.round((seconds ? (twelve ? 16 : 20) : 26) * factor);
            const appearance = `${factor}:${size}`;
            if (identity._dashAppearance !== appearance) {
                identity._dashAppearance = appearance;
                clock.style = `color: ${theme.fg}; font-size: ${size}px;`;
                name.style = `color: ${theme.fg}; font-size: ${Math.round(15 * factor)}px;`;
                distro.style = `color: ${theme.muted}; font-size: ${Math.round(11 * factor)}px;`;
                date.style = `color: ${theme.muted}; font-size: ${Math.round(12 * factor)}px;`;
                avatar._bezelAvatarSize?.(Math.round(64 * factor));
            }
            clock.text = (now.format(timePattern(twelve, seconds)) ?? '').replace(/^0/, '');
            date.text = (now.format(DATE_FORMATS[dateKey]?.format ?? DATE_FORMATS.long.format) ?? '').replace(/\s+/g, ' ').trim();
        };
        identity._dashLayout = ({height}) => {
            identity._dashFactor = height ? clamp(height / 210, 0.55, 1.9) : 1;
            update();
        };
        updates.add(settingFlag(bar._overlay._settings, 'dashboard-clock-seconds') ? 1000 : 10000, update);
        return identity;
    }
    if (id === 'calendar') {
        const calendar = card(theme);
        const grid = bar._monthGrid();
        calendar.add_child(grid);
        calendar._dashLayout = ({width, height}) => grid._dashLayout?.({
            width: Math.max(1, width - 24),
            height: height ? Math.max(48, height - 24) : 0,
        });
        return calendar;
    }
    if (id === 'media') {
        return bar._mediaCard(true, 64, undefined, cleanups);
    }
    if (id === 'actions') {
        const actions = new St.BoxLayout({
            orientation: page.narrow ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 8px;',
            x_expand: true,
        });
        const chip = (title, icon, run, close = false) => {
            const button = new St.Button({
                can_focus: true, x_expand: true,
                style: `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 12px; padding: 10px 8px;`,
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
        actions._dashLayout = ({width, height}) => {
            const narrow = width < 220;
            actions.orientation = narrow ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
            const factor = height ? clamp(height / (narrow ? 148 : 44), 0.55, 2.2) : 1;
            const pad = Math.round(10 * factor);
            const iconSize = Math.round(16 * factor);
            const font = Math.round(14 * Math.min(factor, 1.7));
            for (const button of actions.get_children()) {
                button.style = `background-color: ${theme.surface}; color: ${theme.fg}; border-radius: 12px; padding: ${pad}px 8px;`;
                const icon = button.child?.get_children?.()[0];
                const label = button.child?.get_children?.()[1];
                if (icon)
                    icon.icon_size = iconSize;
                if (label)
                    label.style = `color: ${theme.fg}; font-size: ${font}px;`;
            }
        };
        return actions;
    }
    if (id === 'weather')
        return weatherWidget(bar);
    if (['cpu', 'memory', 'temp'].includes(id)) {
        const meterSize = 104;
        const titles = {cpu: 'CPU usage', memory: 'Memory', temp: 'CPU temperature'};
        const meter = ring(theme, titles[id], meterSize);
        const update = stats => {
            if (id === 'cpu')
                meter.update(stats.cpu, stats.cpu === null ? '…' : `${Math.round(stats.cpu * 100)}%`);
            else if (id === 'memory')
                meter.update(stats.memoryRatio, `${stats.memoryUsed.toFixed(1)} GiB`);
            else
                meter.update(stats.temperature === null ? 0 : stats.temperature / 100,
                    stats.temperature === null ? 'N/A' : `${Math.round(stats.temperature)}°C`);
        };
        updates.add(1500, update, true);
        meter.actor._dashLayout = ({height}) => meter.layout(height);
        return meter.actor;
    }
    if (id === 'forecast')
        return forecastCard(bar);
    if (id === 'gpu' || id === 'disk') {
        const titles = {gpu: 'GPU', disk: 'Disk'};
        const meter = ring(theme, titles[id], 104);
        const update = stats => {
            if (id === 'gpu')
                meter.update(stats.gpu, stats.gpu === null ? 'No reading' : `${Math.round(stats.gpu * 100)}%`);
            else
                meter.update(stats.diskRatio, stats.diskTotal ? `${stats.diskUsed.toFixed(0)} / ${stats.diskTotal.toFixed(0)} GiB` : 'No reading');
        };
        updates.add(1500, update, true);
        meter.actor._dashLayout = ({height}) => meter.layout(height);
        return meter.actor;
    }
    if (id === 'network') {
        const actor = card(theme);
        const down = text(theme, '…', 18);
        const up = text(theme, '…', 18);
        actor.add_child(down);
        actor.add_child(up);
        actor.add_child(text(theme, 'Network', 13, true));
        const update = stats => {
            down.text = stats.netDown === null ? '…' : `↓ ${formatRate(stats.netDown)}`;
            up.text = stats.netUp === null ? '…' : `↑ ${formatRate(stats.netUp)}`;
        };
        updates.add(1500, update, true);
        actor._dashLayout = ({height}) => {
            const factor = height ? clamp(height / 110, 0.6, 2.4) : 1;
            down.style = `color: ${theme.fg}; font-size: ${Math.round(18 * factor)}px;`;
            up.style = `color: ${theme.fg}; font-size: ${Math.round(18 * factor)}px;`;
        };
        return actor;
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
            const columns = page.slots > 1 ? 2 : 1;
            layout.attach(button, i % columns, Math.floor(i / columns), 1, 1);
        }
        return grid;
    }
    return null;
}

function gapCell(theme, editing, width, entry, onFill, onRemove, onDrag) {
    if (!editing) {
        const space = new St.Widget({width, reactive: false});
        space._dashGap = true;
        space._dashId = entry?.id;
        return space;
    }
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, width, reactive: true,
        style: `spacing: 6px; padding: 8px; border: 1px dashed ${theme.border}; border-radius: 12px;`,
    });
    const move = new St.Button({
        reactive: true, can_focus: true, accessible_name: 'Drag this gap',
        x_align: Clutter.ActorAlign.START,
        style: `padding: 6px; border-radius: 8px; background-color: ${theme.surface};`,
        child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 16, style: `color: ${theme.fg};`}),
    });
    move.connect('button-press-event', (_actor, event) => onDrag(box, event));
    const fill = new St.Button({label: 'Add card here', can_focus: true,
        style: `padding: 6px 8px; border-radius: 8px; color: ${theme.fg}; background-color: ${theme.surface};`});
    fill.connect('clicked', onFill);
    const remove = new St.Button({label: 'Remove gap', can_focus: true, style: `padding: 6px 8px; color: ${theme.muted};`});
    remove.connect('clicked', onRemove);
    box.add_child(move);
    box.add_child(fill);
    box.add_child(remove);
    box.connect('button-press-event', (_actor, event) => {
        if (pressedControl(event.get_source(), box))
            return Clutter.EVENT_PROPAGATE;
        return onDrag(box, event);
    });
    box._dashBaseStyle = box.style;
    box._dashGap = true;
    box._dashId = entry?.id;
    return box;
}

function pressedControl(source, limit) {
    for (let actor = source; actor && actor !== limit; actor = actor.get_parent?.()) {
        if (actor instanceof St.Button || actor instanceof St.Entry)
            return true;
    }
    return false;
}

function ensureGapIds(rows) {
    const used = new Set();
    for (const row of rows ?? [])
        for (const cell of row)
            if (cell?.id)
                used.add(cell.id);
    let n = 1;
    for (const row of rows ?? []) {
        for (const cell of row) {
            if (!cell?.gap || cell.id)
                continue;
            while (used.has(`gap-${n}`))
                n += 1;
            cell.id = `gap-${n}`;
            used.add(cell.id);
            n += 1;
        }
    }
}

// Let the row's cross-axis allocation follow its tallest child. Keeping auto
// heights unset also handles content that arrives later (weather and media).
function equalizeRow(placed) {
    for (const {entry, actor} of placed) {
        const automatic = entry.gap || !entry.height;
        actor.height = -1;
        actor.y_expand = automatic;
        actor.y_align = automatic ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.START;
    }
}

function rememberScale(actor) {
    if (actor._dashSnap)
        return;
    const icons = [];
    const fonts = [];
    const walk = node => {
        if (node instanceof St.Icon)
            icons.push([node, node.icon_size || 16]);
        const style = node.style || '';
        const match = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(style);
        if (match)
            fonts.push([node, Number(match[1]), style]);
        for (const child of node.get_children?.() ?? [])
            walk(child);
    };
    walk(actor);
    actor._dashSnap = {icons, fonts};
}

function applyScale(actor, factor) {
    const snap = actor._dashSnap;
    if (!snap)
        return;
    for (const [node, size] of snap.icons) {
        if (node.get_parent?.())
            node.icon_size = Math.max(10, Math.round(size * factor));
    }
    for (const [node, size, style] of snap.fonts) {
        if (node.get_parent?.())
            node.style = style.replace(/font-size:\s*\d+(?:\.\d+)?px/, `font-size: ${Math.max(9, Math.round(size * factor))}px`);
    }
}

// A saved height is the content box. Widgets with _dashLayout refill their
// own artwork, type and grids; everything else scales from its natural size.
function fitCardContent(content, width, height) {
    const target = height > 0 ? height : 0;
    content.width = Math.max(1, width);
    if (typeof content._dashLayout === 'function') {
        content._dashLayout({width: content.width, height: target});
        content.height = -1;
        return;
    }
    if (!content._dashBase) {
        content.height = -1;
        const [, natural] = content.get_preferred_height(content.width);
        content._dashBase = Math.max(32, natural || 32);
        rememberScale(content);
    }
    const factor = target ? clamp(target / content._dashBase, 0.45, 2.3) : 1;
    applyScale(content, factor);
    content.height = -1;
    if (!target)
        return;
    const [, scaled] = content.get_preferred_height(content.width);
    if (scaled > 0 && Math.abs(scaled - target) > 12)
        applyScale(content, clamp(factor * target / scaled, 0.4, 2.6));
    content.height = -1;
}

function applyCardSize(actor, item, width, row = null) {
    actor.height = -1;
    const content = actor._dashContent ?? actor;
    const inner = Math.max(1, (width ?? actor.width) - (actor._dashContent ? 14 : 0));
    fitCardContent(content, inner, item.height || 0);
    if (actor._dashShare && row)
        actor._dashShare.text = shareLabel(row, item);
    actor.y_align = Clutter.ActorAlign.START;
    actor.y_expand = false;
}

function rowBands(host) {
    const bands = [];
    for (const shell of host.get_children()) {
        if (!shell._dashRow)
            continue;
        const band = shell.get_children().find(child => child._dashBand) ?? shell;
        const [x, y] = band.get_transformed_position();
        const [w, h] = band.get_transformed_size();
        const cells = band.get_children().filter(actor => actor._dashCell).map(actor => {
            const [cx, cy] = actor.get_transformed_position();
            const [cw, ch] = actor.get_transformed_size();
            return {
                x: cx - (actor.translation_x || 0), y: cy - (actor.translation_y || 0),
                w: cw, h: ch, gap: Boolean(actor._dashGap),
            };
        });
        bands.push({x, y, w, h, cells});
    }
    return bands;
}

function cardRecord(item, extra = {}) {
    const card = {id: item.id, span: spanOf(item), ...extra};
    if (item.height)
        card.height = item.height;
    return card;
}

function startDashboardDrag(ctx, event) {
    const {bar, theme, editor, tab, layout, persist, refresh, box, item} = ctx;
    if (event.get_button() !== 1 || editor.cancel)
        return Clutter.EVENT_PROPAGATE;
    editor.cancel?.();
    bar._persistPopup();
    const [sx, sy] = event.get_coords();
    box.remove_all_transitions();
    box.translation_x = box.translation_y = 0;
    const [bx, by] = box.get_transformed_position();
    const [bw, bh] = box.get_transformed_size();
    const originWidth = box.width;
    const scaleX = originWidth > 0 ? bw / originWidth : 1;
    const scaleY = box.height > 0 ? bh / box.height : 1;
    let previewRows = cloneRows(layout[tab]);
    let previewKey = JSON.stringify(previewRows);
    let signal = 0;
    let scrollTimer = 0;
    let moved = false;
    let lifted = false;
    const showPreview = (rows, force = false) => {
        const key = JSON.stringify(rows);
        if (!force && key === previewKey)
            return;
        previewKey = key;
        previewRows = rows;
        editor.reflow(rows);
    };
    const lift = () => {
        lifted = true;
        editor.placeholder = new St.Widget({width: originWidth, height: box.height,
            style: `background-color: ${theme.surface}; border: 2px dashed ${theme.accent}; border-radius: 12px;`});
        editor.placeholder._dashPlaceholder = true;
        editor.placeholder._dashId = item.id;
        editor.floating = box;
        box.get_parent()?.remove_child(box);
        Main.uiGroup.add_child(box);
        box.set_position(bx, by);
        box.set_size(originWidth, bh / (scaleY || 1));
        box.set_scale(scaleX, scaleY);
        box.style = `${box._dashBaseStyle ?? box.style} background-color: ${theme.bg}; box-shadow: 0 6px 18px rgba(0,0,0,0.35);`;
        showPreview(previewRows, true);
        let lastPointer = '';
        scrollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            const [x, y] = global.get_pointer();
            const pointerKey = `${Math.round(x)}:${Math.round(y)}`;
            if (pointerKey !== lastPointer) {
                lastPointer = pointerKey;
                update(x, y);
            }
            const scroll = bar._popupScroll;
            const adjustment = scroll?.vadjustment;
            if (adjustment && scroll) {
                const [, top] = scroll.get_transformed_position();
                const [, height] = scroll.get_transformed_size();
                const delta = y < top + 64 ? -16 : y > top + height - 36 ? 16 : 0;
                if (delta)
                    adjustment.value = Math.max(adjustment.lower,
                        Math.min(adjustment.upper - adjustment.page_size, adjustment.value + delta));
            }
            return GLib.SOURCE_CONTINUE;
        });
    };
    const finish = commit => {
        if (signal)
            global.stage.disconnect(signal);
        signal = 0;
        if (scrollTimer)
            GLib.source_remove(scrollTimer);
        scrollTimer = 0;
        box._dashCancel = null;
        editor.cancel = bar._dashboardGesture = null;
        if (lifted) {
            Main.uiGroup.remove_child(box);
            box.set_scale(1, 1);
            box.set_position(0, 0);
            box.set_size(originWidth, -1);
            box.style = box._dashBaseStyle ?? box.style;
            editor.placeholder?.destroy();
            editor.placeholder = editor.floating = null;
        }
        if (commit && moved) {
            layout[tab] = previewRows;
            persist();
            const keep = editor.cards?.has(item.id);
            editor.reflow(layout[tab], false);
            if (lifted && !keep)
                box.destroy();
            return;
        }
        if (moved)
            editor.reflow(layout[tab], false);
    };
    const cancelGesture = () => finish(false);
    box._dashCancel = cancelGesture;
    editor.cancel = bar._dashboardGesture = cancelGesture;
    const update = (x, y) => {
        moved ||= Math.hypot(x - sx, y - sy) >= 5;
        if (!moved)
            return;
        if (!lifted)
            lift();
        box.set_position(bx + x - sx, by + y - sy);
        showPreview(moveCard(previewRows, item.id, dropTarget(rowBands(editor.host), x, y)));
    };
    signal = global.stage.connect('captured-event', (_stage, captured) => {
        const type = captured.type();
        if (type === Clutter.EventType.MOTION) {
            update(...captured.get_coords());
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE && captured.get_button() === 1) {
            finish(moved);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS && captured.get_key_symbol() === Clutter.KEY_Escape) {
            cancelGesture();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
    return Clutter.EVENT_STOP;
}

function editWrap(bar, theme, item, tab, layout, persist, refresh, child, editor) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_expand: true, reactive: true,
        style: `spacing: 6px; border: 1px dashed ${theme.border}; border-radius: 12px; padding: 6px;`,
    });
    const baseStyle = box.style;
    box._dashBaseStyle = baseStyle;
    box._dashId = item.id;
    box._dashContent = child;
    const tools = new St.BoxLayout({style: 'spacing: 6px;', x_expand: true});
    const grip = (icon, name) => new St.Button({
        reactive: true, can_focus: true, accessible_name: name,
        style: `padding: 6px; border-radius: 8px; background-color: ${theme.surface};`,
        child: new St.Icon({icon_name: icon, icon_size: 16, style: `color: ${theme.fg};`}),
    });
    const sizeLabel = text(theme, 'Full', 12, true);
    box._dashShare = sizeLabel;
    sizeLabel.x_align = Clutter.ActorAlign.START;
    let cancelGesture = null;
    box.connect('destroy', () => (box._dashCancel ?? cancelGesture)?.());
    const begin = (event, resizing) => {
        if (event.get_button() !== 1 || cancelGesture || editor.cancel)
            return Clutter.EVENT_PROPAGATE;
        editor.cancel?.();
        bar._persistPopup();
        const [sx, sy] = event.get_coords();
        box.remove_all_transitions();
        box.translation_x = box.translation_y = 0;
        const [bx, by] = box.get_transformed_position();
        const [bw, bh] = box.get_transformed_size();
        const originWidth = box.width;
        const scaleX = originWidth > 0 ? bw / originWidth : 1;
        const scaleY = box.height > 0 ? bh / box.height : 1;
        const [, preferredHeight] = child.get_preferred_height(Math.max(1, child.width || originWidth));
        const originContentHeight = child.height > 0 ? child.height : preferredHeight;
        let previewRows = cloneRows(layout[tab]);
        let previewKey = JSON.stringify(previewRows);
        let signal = 0;
        let scrollTimer = 0;
        let moved = false;
        let lifted = false;
        const showPreview = (rows, force = false) => {
            const key = JSON.stringify(rows);
            if (!force && key === previewKey)
                return;
            previewKey = key;
            previewRows = rows;
            editor.reflow(rows);
        };
        const lift = () => {
            lifted = true;
            editor.placeholder = new St.Widget({width: originWidth, height: box.height,
                style: `background-color: ${theme.surface}; border: 2px dashed ${theme.accent}; border-radius: 12px;`});
            editor.placeholder._dashPlaceholder = true;
            editor.floating = box;
            box.get_parent().remove_child(box);
            Main.uiGroup.add_child(box);
            box.set_position(bx, by);
            box.set_size(originWidth, bh / scaleY);
            box.set_scale(scaleX, scaleY);
            box.style = `${baseStyle} background-color: ${theme.bg}; box-shadow: 0 6px 18px rgba(0,0,0,0.35);`;
            showPreview(previewRows, true);
            scrollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                const scroll = bar._popupScroll;
                const adjustment = scroll?.vadjustment;
                if (adjustment) {
                    const [x, y] = global.get_pointer();
                    const [, top] = scroll.get_transformed_position();
                    const [, height] = scroll.get_transformed_size();
                    const delta = y < top + 64 ? -16 : y > top + height - 36 ? 16 : 0;
                    const previous = adjustment.value;
                    adjustment.value = Math.max(adjustment.lower,
                        Math.min(adjustment.upper - adjustment.page_size, previous + delta));
                    if (adjustment.value !== previous)
                        update(x, y);
                }
                return GLib.SOURCE_CONTINUE;
            });
        };
        const finish = commit => {
            if (signal)
                global.stage.disconnect(signal);
            signal = 0;
            if (scrollTimer)
                GLib.source_remove(scrollTimer);
            scrollTimer = 0;
            cancelGesture = editor.cancel = bar._dashboardGesture = null;
            if (lifted) {
                Main.uiGroup.remove_child(box);
                box.set_scale(1, 1);
                box.set_position(0, 0);
                box.set_size(originWidth, -1);
                box.style = baseStyle;
                editor.placeholder.destroy();
                editor.placeholder = editor.floating = null;
            }
            if (commit && moved) {
                layout[tab] = previewRows;
                persist();
                editor.reflow(layout[tab], false);
                return;
            }
            if (moved)
                editor.reflow(layout[tab], false);
        };
        cancelGesture = () => finish(false);
        editor.cancel = bar._dashboardGesture = cancelGesture;
        const update = (x, y) => {
            moved ||= Math.hypot(x - sx, y - sy) >= 5;
            if (!moved)
                return;
            if (resizing) {
                const located = findCard(layout[tab], item.id);
                if (!located)
                    return;
                const rows = cloneRows(layout[tab]);
                if (Math.abs(x - sx) > 6) {
                    const fraction = (originWidth + (x - sx) / scaleX) / Math.max(1, editor.inner);
                    rows[located.row] = applyWidth(layout[tab][located.row], located.index, fraction);
                }
                if (Math.abs(y - sy) > 6) {
                    const at = findCard(rows, item.id);
                    const height = Math.max(32, Math.min(720, Math.round((originContentHeight + (y - sy) / scaleY) / 4) * 4));
                    if (at)
                        rows[at.row][at.index].height = height;
                }
                showPreview(rows);
            } else {
                if (!lifted)
                    lift();
                box.set_position(bx + x - sx, by + y - sy);
                const [gx, gy] = editor.placeholder.get_transformed_position();
                const [gw, gh] = editor.placeholder.get_transformed_size();
                if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh)
                    return;
                const slot = dropTarget(rowBands(editor.host), x, y);
                showPreview(moveCard(previewRows, item.id, slot));
            }
        };
        signal = global.stage.connect('captured-event', (_stage, captured) => {
            const type = captured.type();
            if (type === Clutter.EventType.MOTION) {
                update(...captured.get_coords());
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE && captured.get_button() === 1) {
                finish(moved);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.KEY_PRESS && captured.get_key_symbol() === Clutter.KEY_Escape) {
                cancelGesture();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    };
    const move = grip('view-app-grid-symbolic', 'Drag this card anywhere');
    const dragCtx = () => ({bar, theme, editor, tab, layout, persist, refresh, box, item});
    move.connect('button-press-event', (_actor, event) => startDashboardDrag(dragCtx(), event));
    box.connect('button-press-event', (_actor, event) => {
        if (pressedControl(event.get_source(), box))
            return Clutter.EVENT_PROPAGATE;
        return startDashboardDrag(dragCtx(), event);
    });
    const resize = grip('view-fullscreen-symbolic', 'Drag the corner to change width and height');
    resize.x_align = Clutter.ActorAlign.END;
    resize.connect('button-press-event', (_actor, event) => begin(event, true));
    const remove = grip('window-close-symbolic', 'Remove this card');
    remove.connect('clicked', () => {
        layout[tab] = removeCard(layout[tab], item.id);
        persist();
        refresh();
    });
    const destinations = column();
    destinations.visible = false;
    const transfer = grip('go-jump-symbolic', 'Move card to another page');
    transfer.connect('clicked', () => {
        destinations.destroy_all_children();
        destinations.visible = !destinations.visible;
        if (destinations.visible) {
            for (const page of dashboardPages(layout).filter(page => page.id !== tab)) {
                const exists = layout[page.id].some(row => row.some(cell => cell.id === item.id));
                const button = new St.Button({label: `${page.title}${exists ? ' · already added' : ''}`,
                    can_focus: true, reactive: !exists, opacity: exists ? 110 : 255,
                    style: `padding: 8px; background-color: ${theme.surface}; border-radius: 8px;`});
                button.connect('clicked', () => {
                    layout[tab] = removeCard(layout[tab], item.id);
                    layout[page.id].push([cardRecord(item)]);
                    persist();
                    refresh();
                });
                destinations.add_child(button);
            }
        }
        bar._fitPopup();
    });
    tools.add_child(move);
    tools.add_child(sizeLabel);
    tools.add_child(new St.Widget({x_expand: true}));
    tools.add_child(transfer);
    tools.add_child(remove);
    box.add_child(tools);
    box.add_child(destinations);
    child.y_expand = false;
    box.add_child(child);
    const footer = new St.BoxLayout({style: 'spacing: 6px;', x_expand: true});
    const auto = new St.Button({label: 'Auto height', can_focus: true, accessible_name: 'Auto height',
        style: `padding: 6px; color: ${theme.muted};`});
    auto.connect('clicked', () => {
        const rows = cloneRows(layout[tab]);
        const at = findCard(rows, item.id);
        if (at)
            delete rows[at.row][at.index].height;
        layout[tab] = rows;
        persist();
        refresh();
    });
    footer.add_child(auto);
    footer.add_child(new St.Widget({x_expand: true}));
    footer.add_child(resize);
    box.add_child(footer);
    return box;
}

function ring(theme, title, size = 150) {
    const actor = card(theme);
    const stack = new St.Widget({width: size, height: size, layout_manager: new Clutter.BinLayout()});
    const paint = new St.DrawingArea({width: size, height: size});
    const value = text(theme, '…', size < 120 ? 16 : 24);
    stack.add_child(paint);
    stack.add_child(value);
    const titleLabel = text(theme, title, 13, true);
    actor.add_child(stack);
    actor.add_child(titleLabel);
    let ratio = 0;
    const layout = height => {
        const next = height ? clamp(Math.round((height - 28) * 0.72), 64, 260) : size;
        stack.set_size(next, next);
        paint.set_size(next, next);
        value.style = `color: ${theme.fg}; font-size: ${Math.max(12, Math.round((size < 120 ? 16 : 22) * next / size))}px;`;
        titleLabel.style = `color: ${theme.muted}; font-size: ${Math.max(11, Math.round(13 * next / size))}px;`;
        paint.queue_repaint();
    };
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
    return {actor, layout, update: (next, label) => { ratio = Math.max(0, Math.min(1, next ?? 0)); value.text = label; paint.queue_repaint(); }};
}

function formatRate(bytesPerSec) {
    if (bytesPerSec < 1024)
        return `${Math.round(bytesPerSec)} B/s`;
    if (bytesPerSec < 1048576)
        return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

function readNet() {
    let rx = 0;
    let tx = 0;
    for (const line of read('/proc/net/dev').split('\n').slice(2)) {
        const [iface, rest] = line.split(':');
        if (!rest || /lo/.test(iface))
            continue;
        const parts = rest.trim().split(/\s+/);
        rx += Number(parts[0] ?? 0);
        tx += Number(parts[8] ?? 0);
    }
    return {rx, tx, time: GLib.get_monotonic_time()};
}

function read(path) {
    try { return new TextDecoder().decode(GLib.file_get_contents(path)[1]); } catch { return ''; }
}

function metricsReader() {
    let previous = null;
    let previousNet = null;
    let temperaturePath = null;
    let gpuPath = '';
    for (let i = 0; i < 8 && !gpuPath; i++) {
        const path = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            gpuPath = path;
    }
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
        const gpuRaw = gpuPath ? Number(read(gpuPath)) : null;
        let diskUsed = 0;
        let diskTotal = 0;
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::used', null);
            diskTotal = info.get_attribute_uint64('filesystem::size') / 1073741824;
            diskUsed = info.get_attribute_uint64('filesystem::used') / 1073741824;
        } catch {
            diskTotal = 0;
        }
        const net = readNet();
        let netDown = null;
        let netUp = null;
        if (previousNet && net) {
            const seconds = (net.time - previousNet.time) / 1e6;
            if (seconds > 0) {
                netDown = Math.max(0, (net.rx - previousNet.rx) / seconds);
                netUp = Math.max(0, (net.tx - previousNet.tx) / seconds);
            }
        }
        previousNet = net;
        return {cpu, memoryTotal, memoryUsed: memoryTotal - available,
            memoryRatio: memoryTotal ? (memoryTotal - available) / memoryTotal : 0,
            uptime: `${Math.floor(up / 3600)}h ${Math.floor(up % 3600 / 60)}m`,
            temperature: temp && Number.isFinite(temp) ? temp : null,
            gpu: gpuRaw !== null && Number.isFinite(gpuRaw) ? gpuRaw / 100 : null,
            diskUsed, diskTotal, diskRatio: diskTotal ? diskUsed / diskTotal : 0,
            netDown, netUp};
    };
}
