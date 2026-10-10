import {activateApp} from './appActivation.js';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {FILE_LIST_GAP, FILE_LIST_ICON, FILE_TILE_GAP, FILE_TILE_ICON, FILE_TILE_NAME, fileGridColumns, fileGridInset, fileGridTileWidth, fileListInset, fileListTileWidth} from './geometry.js';
import {menuFromEvent} from './fileMenu.js';
import {loadFileView, saveFileView} from './shelfStore.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {activateScreenshot, openSettings} from './tools.js';
const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 8px;'});
const text = (bar, value) => new St.Label({text: value, x_expand: true, style: `color: ${bar._theme.fg}; font-size: 13px;`});
function action(bar, name, run) {
    const b = new St.Button({label: name, can_focus: true, track_hover: true, style_class: 'bezel-action', x_expand: true, style: `background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; padding: 10px; border-radius: 12px;`});
    if (b.get_child() instanceof St.Label) b.get_child().clutter_text.ellipsize = Pango.EllipsizeMode.END;
    const feedback = () => { b.style = `background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; padding: 10px; border-radius: 12px; box-shadow: inset 0 0 0 2px ${b.hover || b.has_key_focus() ? bar._theme.accent : 'transparent'};`; };
    b.connect('notify::hover', feedback); b.connect('key-focus-in', feedback); b.connect('key-focus-out', feedback); feedback();
    b.connect('clicked', run); return b;
}
const fileFor = path => Gio.File.new_for_path(path === '~' ? GLib.get_home_dir() : path.startsWith('~/') ? `${GLib.get_home_dir()}/${path.slice(2)}` : path);
const launch = file => Gio.AppInfo.launch_default_for_uri(file.get_uri(), global.create_app_launch_context(global.get_current_time(), -1));
function shortcutIcon(item, size) {
    const app = item?.type === 'app' ? Shell.AppSystem.get_default().lookup_app(item.target) : null;
    return app ? app.create_icon_texture(size) : new St.Icon({icon_name: ['folder', 'live-folder'].includes(item?.type) ? 'folder-symbolic' : item?.type === 'command' ? 'utilities-terminal-symbolic' : 'text-x-generic-symbolic', icon_size: size});
}
export function shortcutFace(bar, options, size) {
    const item = options.shortcuts?.length === 1 ? options.shortcuts[0] : null;
    const name = options.shortcutLabel || item?.name || 'Shortcuts';
    const orientation = bar._content?.orientation ?? (bar._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL);
    const row = new St.BoxLayout({orientation, style: `spacing: 6px; color: ${bar._theme.fg};`, y_align: Clutter.ActorAlign.CENTER});
    if (options.shortcutButtonIcon !== false || options.shortcutButtonName === false) row.add_child(options.shortcutIcon ? new St.Icon({icon_name: options.shortcutIcon, icon_size: size}) : shortcutIcon(item, size));
    if (options.shortcutButtonName !== false) {
        const label = text(bar, name); label.y_align = Clutter.ActorAlign.CENTER;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.style += ` max-width: ${orientation === Clutter.Orientation.VERTICAL ? size : 140}px;`;
        row.add_child(label);
    }
    const button = new St.Button({child: row, accessible_name: name, can_focus: true, track_hover: true, style_class: 'bezel-button', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
    button.style = 'padding: 4px; border-radius: 12px; background-color: transparent;';
    return button;
}
function commandPanel(bar, shortcut) {
    const root = column(); const status = text(bar, `Running ${shortcut.name}…`); root.add_child(status);
    const output = text(bar, ''); output.clutter_text.line_wrap = true; output.clutter_text.selectable = true;
    if (shortcut.showOutput !== false) {
        const scroll = new St.ScrollView({height: 220, x_expand: true, hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC}); const body = column(); body.add_child(output); scroll.set_child(body); root.add_child(scroll);
    }
    let proc = null, disposed = false, total = 0;
    const collected = new Uint8Array(65536);
    const cancel = new Gio.Cancellable();
    root.add_child(action(bar, 'Cancel command', () => proc?.send_signal(15)));
    root.connect('destroy', () => { disposed = true; cancel.cancel(); proc?.send_signal(15); if (shortcut.showOutput === false) output.destroy(); });
    try {
        // Explicit user action only. timeout also bounds descendants of bash.
        proc = Gio.Subprocess.new(['timeout', '--kill-after=2s', '30s', 'bash', '-lc', shortcut.target], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const stream = proc.get_stdout_pipe(); const decoder = new TextDecoder();
        const read = () => stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancel, (source, result) => {
            try {
                const bytes = source.read_bytes_finish(result).get_data(); if (disposed || !bytes.length) return;
                collected.set(bytes.subarray(0, Math.max(0, collected.length - total)), Math.min(total, collected.length));
                total += bytes.length;
                output.text = decoder.decode(collected.subarray(0, Math.min(total, collected.length)));
                if (total > collected.length) { output.text += '\nOutput limit reached.'; proc?.send_signal(15); }
                if (total <= 65536) read();
            } catch (error) { if (!disposed) status.text = error.message; }
        }); read();
        proc.wait_async(null, (source, result) => {
            try { source.wait_finish(result); if (!disposed) status.text = source.get_successful() ? 'Command completed' : 'Command stopped or failed'; }
            catch (error) { if (!disposed) status.text = error.message; }
            proc = null;
        });
    } catch (error) { status.text = error.message; }
    return root;
}
const enumerate = (file, cancel) => new Promise((resolve, reject) => file.enumerate_children_async('standard::name,standard::display-name,standard::type,standard::icon,standard::content-type,standard::size,thumbnail::path', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancel,
    (source, result) => { try { resolve(source.enumerate_children_finish(result)); } catch (error) { reject(error); } }));
const next = (iterator, cancel) => new Promise((resolve, reject) => iterator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancel, (source, result) => { try { resolve(source.next_files_finish(result)); } catch (error) { reject(error); } }));
const info = (file, cancel) => new Promise((resolve, reject) => file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancel, (source, result) => { try { resolve(source.query_info_finish(result)); } catch (error) { reject(error); } }));
export async function copyFileTree(source, destination, cancel) {
    if (destination.equal(source) || destination.has_prefix(source)) throw new Error('Cannot copy a folder into itself.');
    const details = await info(source, cancel);
    if (details.get_file_type() === Gio.FileType.DIRECTORY) {
        await new Promise((resolve, reject) => destination.make_directory_async(GLib.PRIORITY_DEFAULT, cancel, (file, result) => { try { file.make_directory_finish(result); resolve(); } catch (error) { reject(error); } }));
        const iterator = await enumerate(source, cancel);
        try { let batch; while ((batch = await next(iterator, cancel)).length) for (const child of batch) await copyFileTree(source.get_child(child.get_name()), destination.get_child(child.get_name()), cancel); }
        finally { iterator.close_async(GLib.PRIORITY_DEFAULT, null, null); }
    } else await new Promise((resolve, reject) => source.copy_async(destination, Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancel, null, (file, result) => { try { file.copy_finish(result); resolve(); } catch (error) { reject(error); } }));
}
export function liveFolder(bar, path) {
    const root = column(); root.reactive = true;
    const toolbar = new St.BoxLayout({style: 'spacing: 6px;'}); root.add_child(toolbar);
    const heading = text(bar, ''); heading.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    heading.x_expand = true;
    const status = text(bar, ''); status.clutter_text.line_wrap = true;
    const list = column(); list.x_align = Clutter.ActorAlign.FILL; list.style = `spacing: ${FILE_TILE_GAP}px;`;
    const scroll = new St.ScrollView({height: 300, x_expand: true, hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC}); scroll.set_child(list);
    const area = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, reactive: true, can_focus: true}); area.add_child(scroll); root.add_child(area); root.add_child(status);
    const cancel = new Gio.Cancellable(), home = fileFor(path), history = [], selected = new Set();
    let current = home, monitor = null, queued = 0, generation = 0, disposed = false, pasting = false, items = [], tiles = [], last = -1, menu = null;
    let lastLayout = '', relayout = 0, refreshCancel = null;
    const onMenu = actor => Boolean(menu && actor && (menu.actor === actor || menu.actor.contains(actor) || menu.box.contains(actor)));
    const closeMenu = () => { if (!menu) return; const closing = menu; menu = null; closing.close(); if (!disposed) area.grab_key_focus(); };
    let viewMode = loadFileView('folder');
    const paint = () => tiles.forEach((tile, index) => {
        const pad = viewMode === 'list' ? '6px 8px' : '8px';
        tile.style = `padding: ${pad}; border-radius: 10px; background-color: ${selected.has(index) ? bar._theme.surface : 'transparent'}; border: 1px solid ${selected.has(index) ? bar._theme.accent : 'transparent'};`;
    });
    const copy = () => { const uris = [...selected].sort((a, b) => a - b).map(index => current.get_child(items[index].get_name()).get_uri()); if (!uris.length) return;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'x-special/gnome-copied-files', new TextEncoder().encode(`copy\n${uris.join('\n')}`)); status.text = `${uris.length} copied`; };
    const paste = () => {
        if (pasting) return;
        pasting = true;
        const destinationFolder = current;
        St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, 'x-special/gnome-copied-files', async (_clipboard, bytes) => {
            if (disposed) return;
            const uris = (bytes ? new TextDecoder().decode(bytes.get_data?.() ?? bytes) : '').split('\n').slice(1).filter(uri => uri.startsWith('file:'));
            if (!uris.length) { pasting = false; status.text = 'Copy a file or folder first'; return; }
            status.text = 'Copying…';
            try { for (const uri of uris) { const source = Gio.File.new_for_uri(uri); const name = source.get_basename() + (source.get_parent()?.equal(destinationFolder) ? ' (copy)' : ''); await copyFileTree(source, destinationFolder.get_child(name), cancel); }
                if (!disposed) { status.text = 'Copied'; refresh(); }
            } catch (error) { if (!disposed) status.text = `Copy failed: ${error.message}`; }
            finally { pasting = false; }
        });
    };
    const open = index => { const item = items[index]; if (!item) return; const file = current.get_child(item.get_name());
        if (item.get_file_type() === Gio.FileType.DIRECTORY) navigate(file); else try { launch(file); } catch (error) { status.text = error.message; } };
    const context = (index, event) => {
        closeMenu(); if (index >= 0 && !selected.has(index)) { selected.clear(); selected.add(index); last = index; paint(); }
        const entries = [];
        if (index >= 0) {
            entries.push({title: 'Open', icon: 'document-open-symbolic', shortcut: 'Enter', run: () => [...selected].forEach(open)});
            entries.push('sep');
            entries.push({title: 'Copy', icon: 'edit-copy-symbolic', shortcut: 'Ctrl+C', run: copy});
        }
        entries.push({title: 'Paste', icon: 'edit-paste-symbolic', shortcut: 'Ctrl+V', run: paste});
        entries.push({title: 'Select all', icon: 'edit-select-all-symbolic', shortcut: 'Ctrl+A', run: () => { items.forEach((_item, i) => selected.add(i)); paint(); }});
        entries.push('sep');
        entries.push({title: 'Open in Files', icon: 'folder-open-symbolic', shortcut: '', run: () => launch(current)});
        menu = menuFromEvent(bar, event, entries);
    };
    const nav = (name, icon, run) => { const b = new St.Button({accessible_name: name, can_focus: true, child: new St.Icon({icon_name: icon, icon_size: 16}), style: `padding: 7px; border-radius: 8px; color: ${bar._theme.fg};`}); b.connect('clicked', run); toolbar.add_child(b); return b; };
    const back = nav('Back', 'go-previous-symbolic', () => { const previous = history.pop(); if (previous) navigate(previous, false); });
    const up = nav('Up', 'go-up-symbolic', () => { const parent = current.get_parent(); if (parent) navigate(parent); });
    nav('Starting folder', 'go-home-symbolic', () => navigate(home)); toolbar.add_child(heading);
    const viewIcon = new St.Icon({
        icon_name: viewMode === 'list' ? 'view-grid-symbolic' : 'view-list-symbolic', icon_size: 16,
    });
    const viewButton = new St.Button({
        child: viewIcon, can_focus: true,
        accessible_name: viewMode === 'list' ? 'Grid view' : 'List view',
        style: `padding: 7px; border-radius: 8px; color: ${bar._theme.fg};`,
    });
    const setViewMode = mode => {
        viewMode = mode === 'list' ? 'list' : 'grid';
        viewIcon.icon_name = viewMode === 'list' ? 'view-grid-symbolic' : 'view-list-symbolic';
        viewButton.accessible_name = viewMode === 'list' ? 'Grid view' : 'List view';
        saveFileView('folder', viewMode);
    };
    viewButton.connect('clicked', () => {
        setViewMode(viewMode === 'list' ? 'grid' : 'list');
        refresh();
    });
    toolbar.add_child(viewButton);
    const refresh = async () => {
        refreshCancel?.cancel();
        const requestCancel = new Gio.Cancellable(); refreshCancel = requestCancel;
        const ticket = ++generation, folder = current; let iterator;
        const anchorName = items[last]?.get_name();
        const selectedNames = new Set([...selected].map(i => items[i]?.get_name()));
        try {
            iterator = await enumerate(folder, requestCancel); const files = []; let batch;
            while (files.length < 1000 && (batch = await next(iterator, requestCancel)).length) files.push(...batch);
            if (disposed || ticket !== generation) return;
            const available = Math.max(100, area.width || root.width || (Number(bar._popupWidth) || 0) - 36 || 320);
            endSelection(); closeMenu(); list.destroy_all_children(); tiles = []; selected.clear();
            items = files.sort((a, b) => (b.get_file_type() === Gio.FileType.DIRECTORY) - (a.get_file_type() === Gio.FileType.DIRECTORY) || a.get_display_name().localeCompare(b.get_display_name())).slice(0, 1000);
            last = anchorName === undefined ? -1 : items.findIndex(item => item.get_name() === anchorName);
            const listMode = viewMode === 'list';
            const columns = listMode ? 1 : fileGridColumns(available, 6);
            const tileWidth = listMode ? fileListTileWidth(available) : fileGridTileWidth(available, columns);
            const inset = listMode ? fileListInset(available, tileWidth) : fileGridInset(available, columns, tileWidth);
            lastLayout = listMode
                ? `list:${tileWidth}`
                : `grid:${columns}:${inset}`;
            list.style = listMode
                ? `spacing: ${FILE_LIST_GAP}px; padding: 0 ${inset}px;`
                : `spacing: ${FILE_TILE_GAP}px; padding: 0 ${inset}px;`;
            let row;
            for (const [index, item] of items.entries()) {
                if (!listMode && index % columns === 0) {
                    row = new St.BoxLayout({
                        x_expand: false, x_align: Clutter.ActorAlign.START,
                        style: `spacing: ${FILE_TILE_GAP}px;`,
                    });
                    list.add_child(row);
                }
                const file = folder.get_child(item.get_name());
                const content = listMode
                    ? new St.BoxLayout({
                        orientation: Clutter.Orientation.HORIZONTAL, x_expand: true, y_expand: true,
                        y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 10px;',
                    })
                    : column();
                content.x_align = listMode ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER;
                const thumb = item.get_attribute_byte_string('thumbnail::path');
                const image = thumb ? Gio.File.new_for_path(thumb) : item.get_content_type()?.startsWith('image/') && item.get_size() < 20000000 ? file : null;
                content.add_child(new St.Icon({
                    gicon: image ? new Gio.FileIcon({file: image}) : item.get_icon(),
                    icon_size: listMode ? FILE_LIST_ICON : FILE_TILE_ICON,
                    x_align: listMode ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                const name = text(bar, item.get_display_name());
                name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                if (listMode) {
                    name.x_expand = true;
                    name.y_align = Clutter.ActorAlign.CENTER;
                } else name.width = FILE_TILE_NAME;
                content.add_child(name);
                const tile = new St.Button({
                    child: content, accessible_name: item.get_display_name(), can_focus: true,
                    width: tileWidth, x_expand: false, x_align: Clutter.ActorAlign.START,
                });
                tiles.push(tile);
                if (listMode) list.add_child(tile);
                else row.add_child(tile);
                if (selectedNames.has(item.get_name())) selected.add(index);
                let clickedAt = 0;
                tile.connect('button-press-event', (_actor, event) => {
                    if (event.get_button() === 3) { context(index, event); return Clutter.EVENT_STOP; }
                    if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                    closeMenu(); const modifiers = event.get_state();
                    if (modifiers & Clutter.ModifierType.SHIFT_MASK && last >= 0) { if (!(modifiers & Clutter.ModifierType.CONTROL_MASK)) selected.clear(); for (let i = Math.min(last, index); i <= Math.max(last, index); i++) selected.add(i); }
                    else if (modifiers & Clutter.ModifierType.CONTROL_MASK) { if (selected.has(index)) selected.delete(index); else selected.add(index); last = index; }
                    else { selected.clear(); selected.add(index); last = index; }
                    paint(); tile.grab_key_focus(); const at = GLib.get_monotonic_time(); if (at - clickedAt < 400000 && !(modifiers & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK))) { clickedAt = 0; open(index); } else clickedAt = at; return Clutter.EVENT_STOP;
                });
            }
            if (!items.length) list.add_child(text(bar, 'Empty folder')); paint();

            if (files.length >= 1000) status.text = 'Showing the first 1,000 items';
            else if (status.text === 'Showing the first 1,000 items') status.text = '';
        } catch (error) { if (!disposed && ticket === generation) status.text = error.message; }
        finally {
            iterator?.close_async(GLib.PRIORITY_DEFAULT, null, null);
            if (refreshCancel === requestCancel) refreshCancel = null;
        }
    };
    const navigate = (file, remember = true) => {
        if (remember && !file.equal(current)) history.push(current);
        // Old entries must not act on a new directory while its read is pending.
        endSelection(); list.destroy_all_children(); items = []; tiles = [];
        if (queued) { GLib.source_remove(queued); queued = 0; }
        current = file; selected.clear(); last = -1; heading.text = file.get_basename() || file.get_parse_name(); status.text = ''; closeMenu(); monitor?.cancel();
        back.reactive = history.length > 0; back.opacity = back.reactive ? 255 : 90; up.reactive = Boolean(file.get_parent());
        try { monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, cancel); monitor.connect('changed', () => { if (!queued && !disposed) queued = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { queued = 0; refresh(); return GLib.SOURCE_REMOVE; }); }); } catch {}
        refresh();
    };
    let marquee = null, selectionSignal = 0, scrollWatch = 0, marqueeState = null;
    const endSelection = () => {
        if (selectionSignal) global.stage.disconnect(selectionSignal);
        if (scrollWatch && scroll.vadjustment) scroll.vadjustment.disconnect(scrollWatch);
        selectionSignal = 0; scrollWatch = 0; marquee?.destroy(); marquee = null; marqueeState = null;
    };
    const selectionBounds = () => {
        const box = actor => {
            const [x, y] = actor.get_transformed_position(), [w, h] = actor.get_transformed_size();
            return {left: x, top: y, right: x + w, bottom: y + h};
        };
        let next = box(area);
        for (const actor of [scroll, bar._popupScroll]) {
            if (!actor) continue;
            const other = box(actor);
            next = {
                left: Math.max(next.left, other.left), top: Math.max(next.top, other.top),
                right: Math.min(next.right, other.right), bottom: Math.min(next.bottom, other.bottom),
            };
        }
        return next;
    };
    const yFrom = (actor, ancestor) => {
        let y = 0, node = actor;
        while (node && node !== ancestor) {
            y += node.y || 0;
            node = node.get_parent();
        }
        return y;
    };
    const pointerContentY = sy => {
        const [, top] = scroll.get_transformed_position(), [, height] = scroll.get_transformed_size();
        return Math.max(top, Math.min(sy, top + height)) - top + (scroll.vadjustment?.value ?? 0);
    };
    const updateMarquee = () => {
        if (!marqueeState || disposed) return;
        const [mx, my] = global.get_pointer(), box = selectionBounds();
        const scrollY = scroll.vadjustment?.value ?? 0;
        const x = Math.max(box.left, Math.min(mx, box.right));
        const startX = Math.max(box.left, Math.min(marqueeState.x, box.right));
        const currentY = pointerContentY(my);
        const left = Math.min(startX, x), right = Math.max(startX, x);
        const top = Math.min(marqueeState.contentY, currentY), bottom = Math.max(marqueeState.contentY, currentY);
        const [, viewTop] = scroll.get_transformed_position();
        const visTop = Math.max(box.top, viewTop + top - scrollY);
        const visBottom = Math.min(box.bottom, viewTop + bottom - scrollY);
        if (!marquee) {
            marquee = new St.Widget({reactive: false, style: `background-color: ${bar._theme.surface}; border: 1px solid ${bar._theme.accent}; border-radius: 3px;`, opacity: 120});
            Main.uiGroup.add_child(marquee);
        }
        marquee.set_position(left, visTop);
        marquee.set_size(Math.max(1, right - left), Math.max(1, visBottom - visTop));
        selected.clear();
        marqueeState.initial.forEach(i => selected.add(i));
        tiles.forEach((tile, i) => {
            const [tx, ty] = tile.get_transformed_position(), [tw, th] = tile.get_transformed_size();
            const width = Math.max(tw, tile.width, 1), height = Math.max(th, tile.height, 1);
            const tileTop = yFrom(tile, list);
            if (tx < right && tx + width > left && tileTop < bottom && tileTop + height > top) selected.add(i);
        });
        paint();
    };
    const beginMarquee = (additive, startX, startY) => {
        closeMenu(); endSelection(); area.grab_key_focus(); bar._persistPopup();
        marqueeState = {x: startX, contentY: pointerContentY(startY), initial: new Set(additive ? selected : [])};
        if (!additive) selected.clear(); paint();
        updateMarquee();
        if (scroll.vadjustment)
            scrollWatch = scroll.vadjustment.connect('notify::value', updateMarquee);
        selectionSignal = global.stage.connect('captured-event', (_stage, motion) => {
            if (motion.type() === Clutter.EventType.BUTTON_RELEASE && motion.get_button() === 1) { updateMarquee(); endSelection(); return Clutter.EVENT_STOP; }
            if (motion.type() === Clutter.EventType.KEY_PRESS && motion.get_key_symbol() === Clutter.KEY_Escape) { endSelection(); return Clutter.EVENT_STOP; }
            if (motion.type() === Clutter.EventType.MOTION) { updateMarquee(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
    };
    const folderWidth = () => Math.max(100, area.width || root.width || (Number(bar._popupWidth) || 0) - 36 || 320);
    const layoutKey = width => {
        if (viewMode === 'list') return `list:${fileListTileWidth(width)}`;
        const columns = fileGridColumns(width, 6);
        return `grid:${columns}:${fileGridInset(width, columns, fileGridTileWidth(width, columns))}`;
    };
    const scheduleRelayout = () => {
        if (disposed || !items.length || relayout) return;
        const next = layoutKey(folderWidth());
        if (next === lastLayout) return;
        relayout = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            relayout = 0;
            if (!disposed && items.length && layoutKey(folderWidth()) !== lastLayout) refresh();
            return GLib.SOURCE_REMOVE;
        });
    };
    area.connect('notify::width', scheduleRelayout);
    root.connect('notify::width', scheduleRelayout);
    const popoutWidth = bar._popout?.connect('notify::width', scheduleRelayout);
    area.connect('button-press-event', (_actor, event) => {
        if (onMenu(event.get_source())) return Clutter.EVENT_PROPAGATE;
        if (event.get_button() === 3) { context(-1, event); return Clutter.EVENT_STOP; }
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        const additive = Boolean(event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK));
        const [startX, startY] = event.get_coords();
        beginMarquee(additive, startX, startY);
        return Clutter.EVENT_STOP;
    });
    const keySignal = global.stage.connect('captured-event', (_actor, event) => {
        const focus = global.stage.get_key_focus();
        if (event.type() !== Clutter.EventType.KEY_PRESS || !focus || !(root.contains(focus) || onMenu(focus))) return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol(), ctrl = event.get_state() & Clutter.ModifierType.CONTROL_MASK;
        if (menu && [Clutter.KEY_Up, Clutter.KEY_Down].includes(key)) { const entries = menu.box.get_children().filter(actor => actor instanceof St.Button); const index = entries.indexOf(focus); entries[(index + (key === Clutter.KEY_Down ? 1 : entries.length - 1)) % entries.length]?.grab_key_focus(); }
        else if (menu && key === Clutter.KEY_Return && focus instanceof St.Button && onMenu(focus)) focus.emit('clicked', 1);
        else if (ctrl && [Clutter.KEY_c, Clutter.KEY_C].includes(key)) copy();
        else if (ctrl && [Clutter.KEY_v, Clutter.KEY_V].includes(key)) paste();
        else if (ctrl && [Clutter.KEY_a, Clutter.KEY_A].includes(key)) { items.forEach((_item, i) => selected.add(i)); paint(); }
        else if (key === Clutter.KEY_Return && selected.size) open([...selected][0]);
        else if (key === Clutter.KEY_BackSpace) { const parent = current.get_parent(); if (parent) navigate(parent); }
        else if (key === Clutter.KEY_Escape && menu) closeMenu(); else return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    });
    root.connect('destroy', () => {
        disposed = true; closeMenu(); endSelection(); global.stage.disconnect(keySignal);
        if (popoutWidth && bar._popout) bar._popout.disconnect(popoutWidth);
        disposed = true; generation++; cancel.cancel(); refreshCancel?.cancel(); monitor?.cancel();
        if (queued) GLib.source_remove(queued); if (relayout) GLib.source_remove(relayout);
    });
    root._viewMode = () => viewMode;
    root._selectedNames = () => [...selected].sort((a, b) => a - b).map(index => items[index]?.get_display_name()).filter(Boolean);
    root._startMarquee = () => { const [x, y] = global.get_pointer(); beginMarquee(false, x, y); };
    root._tickMarquee = () => updateMarquee();
    root._endMarquee = () => { updateMarquee(); endSelection(); };
    navigate(current, false); return root;
}
export function shortcutsPanel(bar, options) {
    const root = column(); const details = column();
    const grid = options.shortcutLayout === 'grid';
    const layout = grid ? new Clutter.GridLayout() : null;
    const items = grid ? new St.Widget({layout_manager: layout, x_expand: true}) : column();
    if (layout) { layout.set_column_spacing(8); layout.set_row_spacing(8); }
    const columns = Math.max(1, Math.min(4, Math.floor((bar._popupWidth - 36) / 110) || 1));
    let index = 0;
    root.add_child(items);
    const show = actor => { details.destroy_all_children(); details.add_child(actor); bar._popupLockedHeight = false; bar._fitPopup(); bar._later('_shortcutFit', 30, () => bar._fitPopup()); };
    for (const item of options.shortcuts || []) {
        const activate = () => {
            try {
                if (item.type === 'command') { show(commandPanel(bar, item)); return; }
                if (item.type === 'live-folder') { show(liveFolder(bar, item.target)); return; }
                if (item.type === 'app') { const app = Shell.AppSystem.get_default().lookup_app(item.target); if (!app) throw new Error('Application is not installed'); activateApp(app); }
                else if (['file', 'folder'].includes(item.type)) launch(fileFor(item.target));
                else {
                    const actions = {screenshot: () => activateScreenshot().catch(error => Main.notify('Screenshot', error.message)), settings: () => openSettings(), notifications: () => { const a = bar._notificationsAction(); a.emit('clicked', 1); a.destroy(); }, power: () => bar._open('power', bar._actor, () => bar._session())};
                    if (!Object.hasOwn(actions, item.target)) throw new Error('Unknown action'); bar._close(); actions[item.target](); return;
                }
                bar._close();
            } catch (error) { show(text(bar, error.message)); }
        };
        const b = action(bar, '', activate); b.accessible_name = item.name;
        const row = new St.BoxLayout({orientation: grid ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL, style: 'spacing: 8px;', x_align: Clutter.ActorAlign.CENTER});
        if (grid) { b.width = Math.max(80, Math.floor((bar._popupWidth - 36 - (columns - 1) * 8) / columns)); b.y_expand = true; }
        if (options.shortcutIcons !== false || options.shortcutNames === false) {
            row.add_child(shortcutIcon(item, 24));
        }
        if (options.shortcutNames !== false) row.add_child(text(bar, item.name)); b.set_child(row);
        if (layout) layout.attach(b, index % columns, Math.floor(index / columns), 1, 1);
        else items.add_child(b);
        index++;
    }
    if (!index) root.add_child(text(bar, 'Add shortcuts in this module’s settings.'));
    root.add_child(details); return root;
}
