import {moduleFeatures} from './moduleFeatures.js';
import {menuFromEvent} from './fileMenu.js';
import {FILE_LIST_GAP, FILE_LIST_ICON, FILE_TILE_GAP, FILE_TILE_ICON, FILE_TILE_NAME, fileGridColumns, fileGridInset, fileGridTileWidth, fileListInset, fileListTileWidth} from './geometry.js';
import {loadFileView, loadShelfFiles, mergeShelfFiles, parseFileUris, saveFileView, saveShelfFiles, shelfStoragePath} from './shelfStore.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const dragScript = () => Gio.File.new_for_uri(import.meta.url).get_parent().get_child('shelfDrag.js').get_path();
const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 8px;'});
const text = (bar, value) => new St.Label({text: value, x_expand: true, style: `color: ${bar._theme.fg}; font-size: 13px;`});
const measured = value => Number.isFinite(value) && value >= 200 ? value : 0;
const containsPoint = (actor, x, y) => {
    if (!actor) return false;
    const [ax, ay] = actor.get_transformed_position(), [aw, ah] = actor.get_transformed_size();
    return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
};
const launch = uri => {
    try { Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(global.get_current_time(), -1)); }
    catch {}
};

function readDndUris(cancel, done) {
    const selection = global.display.get_selection();
    const mimes = selection.get_mimetypes(Meta.SelectionType.SELECTION_DND) ?? [];
    const mime = ['text/uri-list', 'x-special/gnome-icon-list', 'text/plain'].find(type => mimes.includes(type));
    if (!mime) { done([]); return; }
    const stream = Gio.MemoryOutputStream.new_resizable();
    selection.transfer_async(Meta.SelectionType.SELECTION_DND, mime, -1, stream, cancel, (source, result) => {
        try {
            source.transfer_finish(result);
            stream.close(null);
            done(parseFileUris(new TextDecoder().decode(stream.steal_as_bytes().get_data())));
        } catch { done([]); }
    });
}

const HELPER_TITLE = 'Bezel shelf input';
const helper = {
    proc: null, window: null, actor: null, created: 0, mapped: 0,
    animate: null, writing: false, queued: null, onMessage: null, target: null, aux: null,
};

const ownsHelper = win => helper.proc && win && win.get_pid() === Number(helper.proc.get_identifier());

function hideHelperActor(actor) {
    if (!actor) return;
    const keepInvisible = () => { try { if (actor.opacity !== 0) actor.opacity = 0; } catch {} };
    if (!actor._bezelShelfInput) {
        actor._bezelShelfInput = true;
        actor.connect('notify::opacity', keepInvisible);
        actor.connect('notify::mapped', () => { if (actor.mapped) keepInvisible(); });
        try { actor.remove_all_transitions(); } catch {}
        try { actor.meta_window?.hide_from_window_list(); } catch {}
    }
    try { actor.remove_all_transitions(); } catch {}
    keepInvisible();
}

function placeHelperWindow(win = helper.window) {
    if (!win || !helper.target) return;
    const t = helper.target, rect = win.get_frame_rect();
    if (rect.x !== t.x || rect.y !== t.y || rect.width !== t.width || rect.height !== t.height)
        try { win.move_resize_frame(false, t.x, t.y, t.width, t.height); } catch {}
}

function hideHelperWindow(win) {
    if (!ownsHelper(win)) return;
    hideHelperActor(win.get_compositor_private());
    placeHelperWindow(win);
    try {
        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            hideHelperActor(win.get_compositor_private());
            placeHelperWindow(win);
            return GLib.SOURCE_REMOVE;
        });
    } catch {}
}

function skipHelperAnimation() {
    if (helper.animate !== null) return;
    const wm = Main.wm;
    if (typeof wm._shouldAnimate !== 'function') {
        helper.animate = false;
        return;
    }
    const original = wm._shouldAnimate;
    helper.animate = original;
    wm._shouldAnimate = function(actor, ...rest) {
        try {
            if (ownsHelper(actor?.meta_window)) return false;
        } catch {}
        return original.call(this, actor, ...rest);
    };
}

function writeHelper(state) {
    if (!helper.proc) return;
    helper.queued = JSON.stringify(state) + '\n';
    const write = () => {
        if (helper.writing || !helper.queued || !helper.proc) return;
        const data = helper.queued; helper.queued = null; helper.writing = true;
        helper.proc.get_stdin_pipe().write_all_async(new TextEncoder().encode(data), GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            try { stream.write_all_finish(result); } catch {}
            helper.writing = false; write();
        });
    };
    write();
}

function bindHelperWindow() {
    if (helper.window && helper.actor) {
        hideHelperActor(helper.actor);
        placeHelperWindow();
        return true;
    }
    const actor = global.get_window_actors().find(item => ownsHelper(item.meta_window) && item.mapped);
    if (!actor) return false;
    hideHelperActor(actor);
    helper.window = actor.meta_window;
    helper.actor = actor;
    try { helper.window.hide_from_window_list(); } catch {}
    helper.window.connect('unmanaged', () => {
        helper.aux?.delete(helper.actor);
        helper.window = null;
        helper.actor = null;
    });
    placeHelperWindow();
    return true;
}

export function retainShelfHelper(action = 'copy') {
    if (helper.proc) return;
    try {
        skipHelperAnimation();
        helper.created = global.display.connect('window-created', (_display, win) => hideHelperWindow(win));
        helper.mapped = global.window_manager.connect('map', (_wm, actor) => {
            if (!ownsHelper(actor.meta_window)) return;
            hideHelperActor(actor);
            placeHelperWindow(actor.meta_window);
        });
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE});
        launcher.setenv('GDK_BACKEND', GLib.getenv('WAYLAND_DISPLAY') ? 'wayland' : 'x11', true);
        helper.proc = launcher.spawnv(['gjs', '-m', dragScript(), JSON.stringify({title: HELPER_TITLE, action})]);
        helper.proc.wait_async(null, (proc, result) => {
            try { proc.wait_finish(result); } catch {}
            if (helper.proc === proc) {
                helper.proc = null; helper.window = null; helper.actor = null;
            }
        });
        const output = new Gio.DataInputStream({base_stream: helper.proc.get_stdout_pipe()});
        const read = () => output.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let line;
            try { [line] = stream.read_line_finish_utf8(result); } catch { return; }
            if (line === null) return;
            try { helper.onMessage?.(JSON.parse(line)); } catch (error) { console.error(`Bezel shelf input: ${error}`); }
            read();
        });
        read();
    } catch (error) { console.error(`Bezel shelf input: ${error}`); }
}

export function parkShelfHelper() {
    helper.onMessage = null;
    helper.target = {x: 0, y: 0, width: 1, height: 1};
    if (helper.actor) {
        hideHelperActor(helper.actor);
        try { helper.actor.remove_clip(); } catch {}
    }
    writeHelper({width: 1, height: 1, tiles: [], selected: [], hidden: true});
    placeHelperWindow();
}

export function stopShelfHelper() {
    parkShelfHelper();
    if (helper.mapped) { global.window_manager.disconnect(helper.mapped); helper.mapped = 0; }
    if (helper.created) { global.display.disconnect(helper.created); helper.created = 0; }
    if (typeof helper.animate === 'function') Main.wm._shouldAnimate = helper.animate;
    helper.animate = null;
    if (helper.proc) { try { helper.proc.force_exit(); } catch {} helper.proc = null; }
    helper.window = null; helper.actor = null; helper.onMessage = null;
}

export function shelfView(bar, options = {}) {
    const storage = shelfStoragePath();
    let files = loadShelfFiles(storage, options.shelfRemember);
    const root = column(); root.reactive = true; root.accessible_name = 'File shelf panel';
    const toolbar = new St.BoxLayout({style: 'spacing: 8px;'}); root.add_child(toolbar);
    const heading = text(bar, 'File shelf'); heading.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    heading.x_expand = true; toolbar.add_child(heading);
    let viewMode = loadFileView('shelf');
    const viewIcon = new St.Icon({
        icon_name: viewMode === 'list' ? 'view-grid-symbolic' : 'view-list-symbolic', icon_size: 16,
    });
    const viewButton = new St.Button({
        child: viewIcon, can_focus: true,
        accessible_name: viewMode === 'list' ? 'Grid view' : 'List view',
        style: `padding: 7px; border-radius: 8px; color: ${bar._theme.fg};`,
    });
    toolbar.add_child(viewButton);
    const clear = new St.Button({label: 'Clear', can_focus: true, accessible_name: 'Clear shelf', style: `padding: 7px 10px; border-radius: 8px; color: ${bar._theme.fg};`});
    toolbar.add_child(clear);
    const status = text(bar, ''); status.clutter_text.line_wrap = true; status.visible = false;
    status.connect('notify::text', () => { status.visible = Boolean(status.text); });
    const list = column();
    list.x_align = Clutter.ActorAlign.FILL;
    list.y_align = Clutter.ActorAlign.START;
    list.style = `spacing: ${FILE_TILE_GAP}px;`;
    const area = new St.Widget({
        layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
        reactive: true, can_focus: true, accessible_name: 'Shelf drop area',
    });
    area.add_child(list);
    const highlight = new St.Widget({
        reactive: false, visible: false, x_expand: true, y_expand: true,
        style: `border: 2px solid ${bar._theme.accent}; border-radius: 12px; background-color: ${bar._theme.accent};`,
        opacity: 50,
    });
    area.add_child(highlight);
    area.clip_to_allocation = true;
    root.add_child(area); root.add_child(status);
    const cancel = new Gio.Cancellable(), selected = new Set();
    let generation = 0, disposed = false, items = [], tiles = [], last = -1, menu = null, draggingOut = false;
    let lastCols = 0, lastLayout = '', refreshing = false, relayout = 0, empty = null, emptyHost = null;
    let overDrop = false, liveDrop = false, covered = false, nativeSync = 0, nativeState = '', scrollSignal = 0;
    const onMenu = actor => Boolean(menu && actor && (menu.actor === actor || menu.actor.contains(actor) || menu.box.contains(actor)));
    const closeMenu = () => { if (!menu) return; const closing = menu; menu = null; closing.close(); if (!disposed) area.grab_key_focus(); };
    let rubber = null, rubberTick = 0, rubberStage = 0;
    const rubberBounds = () => {
        const [ax, ay] = area.get_transformed_position(), [aw, ah] = area.get_transformed_size();
        let left = ax, top = ay, right = ax + aw, bottom = ay + ah;
        if (bar._popupScroll) {
            const [vx, vy] = bar._popupScroll.get_transformed_position(), [vw, vh] = bar._popupScroll.get_transformed_size();
            left = Math.max(left, vx); top = Math.max(top, vy);
            right = Math.min(right, vx + vw); bottom = Math.min(bottom, vy + vh);
        }
        return {left, top, right, bottom};
    };
    const endRubber = () => {
        if (rubberTick) { GLib.source_remove(rubberTick); rubberTick = 0; }
        if (rubberStage) { global.stage.disconnect(rubberStage); rubberStage = 0; }
        if (rubber?.actor) {
            bar._popupAuxActors?.delete(rubber.actor);
            rubber.actor.destroy();
        }
        rubber = null;
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
        const view = bar._popupScroll;
        if (!view) return sy;
        const [, top] = view.get_transformed_position(), [, height] = view.get_transformed_size();
        return Math.max(top, Math.min(sy, top + height)) - top + (view.vadjustment?.value ?? 0);
    };
    const tickRubber = () => {
        if (!rubber || disposed) return;
        const [mx, my] = global.get_pointer(), box = rubberBounds();
        const view = bar._popupScroll;
        const scrollY = view?.vadjustment?.value ?? 0;
        const x = Math.max(box.left, Math.min(mx, box.right));
        const startX = Math.max(box.left, Math.min(rubber.x, box.right));
        const currentY = pointerContentY(my);
        const left = Math.min(startX, x), right = Math.max(startX, x);
        const top = Math.min(rubber.contentY, currentY), bottom = Math.max(rubber.contentY, currentY);
        const [, viewTop] = view?.get_transformed_position() ?? [0, box.top];
        const visTop = Math.max(box.top, viewTop + top - scrollY);
        const visBottom = Math.min(box.bottom, viewTop + bottom - scrollY);
        if (!rubber.actor) {
            rubber.actor = new St.Widget({
                reactive: false, accessible_name: 'Shelf selection',
                style: `background-color: ${bar._theme.surface}; border: 1px solid ${bar._theme.accent}; border-radius: 3px;`,
                opacity: 120,
            });
            Main.uiGroup.add_child(rubber.actor);
            bar._popupAuxActors?.add(rubber.actor);
        }
        rubber.actor.set_position(left, visTop);
        rubber.actor.set_size(Math.max(1, right - left), Math.max(1, visBottom - visTop));
        selected.clear();
        rubber.initial.forEach(index => selected.add(index));
        tiles.forEach((tile, index) => {
            const [tx, ty] = tile.get_transformed_position(), [tw, th] = tile.get_transformed_size();
            const width = Math.max(tw, tile.width, 1), height = Math.max(th, tile.height, 1);
            const tileTop = yFrom(tile, root);
            if (tx < right && tx + width > left && tileTop < bottom && tileTop + height > top)
                selected.add(index);
        });
        paint();
    };
    const startRubber = additive => {
        endRubber();
        closeMenu();
        const [x, y] = global.get_pointer();
        rubber = {x, y, contentY: pointerContentY(y), initial: new Set(additive ? selected : [])};
        if (!additive) selected.clear();
        paint();
        tickRubber();
        rubberTick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!rubber || disposed) { rubberTick = 0; return GLib.SOURCE_REMOVE; }
            tickRubber();
            return GLib.SOURCE_CONTINUE;
        });
    };
    const persist = () => saveShelfFiles(files, storage);
    const paint = () => tiles.forEach((tile, index) => {
        const pad = viewMode === 'list' ? '6px 8px' : '8px';
        tile.style = `padding: ${pad}; border-radius: 10px; background-color: ${selected.has(index) ? bar._theme.surface : 'transparent'}; border: 1px solid ${selected.has(index) ? bar._theme.accent : 'transparent'};`;
    });
    const layoutKey = width => {
        if (viewMode === 'list') return `list:${fileListTileWidth(width)}`;
        const columns = fileGridColumns(width, 4);
        return `grid:${columns}:${fileGridInset(width, columns, fileGridTileWidth(width, columns))}`;
    };
    const setViewMode = mode => {
        viewMode = mode === 'list' ? 'list' : 'grid';
        viewIcon.icon_name = viewMode === 'list' ? 'view-grid-symbolic' : 'view-list-symbolic';
        viewButton.accessible_name = viewMode === 'list' ? 'Grid view' : 'List view';
        saveFileView('shelf', viewMode);
    };
    const selectedUris = () => [...selected].sort((a, b) => a - b).map(index => items[index]).filter(Boolean);
    const copy = () => {
        const uris = selectedUris(); if (!uris.length) return;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'x-special/gnome-copied-files', new TextEncoder().encode(`copy\n${uris.join('\n')}`));
        status.text = `${uris.length} copied`;
    };
    const panelWidth = () => {
        const planned = Math.max(Number(bar._popupWidth) || 0, Number(bar._popout?.width) || 0, 360) - 36;
        return Math.max(320, measured(area.width) || measured(root.width) || planned);
    };
    const setDismissReactive = on => {
        if (bar._dismissLayer) {
            bar._dismissLayer.reactive = on;
            bar._dismissLayer.visible = on;
        }
        for (const strip of bar._dismissStrips ?? []) {
            strip.reactive = on;
            strip.visible = on;
        }
    };
    const visibleHole = () => {
        const box = actor => {
            if (!actor) return null;
            const [x, y] = actor.get_transformed_position(), [w, h] = actor.get_transformed_size();
            if (!(w > 1 && h > 1)) return null;
            return {x, y, right: x + w, bottom: y + h};
        };
        const areaBox = box(area);
        if (!areaBox) return {x: 0, y: 0, width: 0, height: 0};
        let {x, y, right, bottom} = areaBox;
        for (const actor of [bar._popupScroll, bar._popout]) {
            const next = box(actor);
            if (!next) continue;
            x = Math.max(x, next.x);
            y = Math.max(y, next.y);
            right = Math.min(right, next.right);
            bottom = Math.min(bottom, next.bottom);
        }
        const width = right - x, height = bottom - y;
        if (width >= 32 && height >= 32) return {x, y, width, height};
        const fallback = box(bar._popupScroll) || box(bar._popout);
        if (fallback)
            return {x: fallback.x, y: fallback.y, width: fallback.right - fallback.x, height: fallback.bottom - fallback.y};
        return {x: areaBox.x, y: areaBox.y, width: Math.min(areaBox.right - areaBox.x, 400), height: Math.min(220, areaBox.bottom - areaBox.y)};
    };
    const coverHole = () => {
        if (covered || disposed || overDrop || !helper.window || !helper.actor || !bar._popout) return;
        const passThrough = node => {
            node.reactive = false;
            for (const child of node.get_children()) passThrough(child);
        };
        passThrough(bar._popout);
        clear.reactive = files.length > 0;
        viewButton.reactive = true;
        tiles.forEach(tile => { tile.reactive = false; });
        bar._popupInputHole = true;
        bar._resetOutsideDismiss();
        helper.aux = bar._popupAuxActors;
        helper.aux?.add(helper.actor);
        try { helper.window.make_above(); } catch {}
        covered = true;
    };
    const syncNative = () => {
        if (disposed || !helper.proc || !area.mapped || refreshing) return;
        // Moving the helper under a live GTK drop cancels the grab.
        if ((overDrop || liveDrop) && nativeState) return;
        if (bindHelperWindow()) hideHelperActor(helper.actor);
        else covered = false;
        const hole = visibleHole();
        if (hole.width < 1 || hole.height < 1) return;
        const width = Math.round(hole.width), height = Math.round(hole.height);
        const next = {
            width, height, selected: selectedUris(), last: items[last], hidden: false,
            tiles: tiles.map(tile => {
                const [tx, ty] = tile.get_transformed_position(), [tw, th] = tile.get_transformed_size();
                const x = Math.round(tx - hole.x), y = Math.round(ty - hole.y);
                const left = Math.max(0, x), top = Math.max(0, y);
                const right = Math.min(width, x + Math.round(tw)), bottom = Math.min(height, y + Math.round(th));
                if (right - left < 1 || bottom - top < 1) return null;
                return {uri: tile._uri, x: left, y: top, width: right - left, height: bottom - top};
            }).filter(Boolean),
        };
        helper.target = {x: Math.round(hole.x), y: Math.round(hole.y), width, height};
        if (helper.window) {
            hideHelperActor(helper.actor);
            placeHelperWindow();
            try { helper.actor?.remove_clip(); } catch {}
            coverHole();
        }
        const serialized = JSON.stringify(next);
        if (serialized === nativeState) return;
        nativeState = serialized;
        writeHelper(next);
    };
    const finishNative = (uris, accepted) => {
        draggingOut = false;
        setDismissReactive(true);
        if (!accepted || !uris?.length) return;
        if (options.shelfRemoveAfterDrop !== false) {
            const gone = new Set(uris);
            files = files.filter(uri => !gone.has(uri)); persist(); refresh();
        }
        if (options.shelfCloseAfterDrop !== false) bar._close();
    };
    const startNative = () => {
        if (disposed) return;
        retainShelfHelper(options.shelfDragAction || 'copy');
        helper.onMessage = message => {
            if (disposed) return;
            if (['select', 'open', 'menu'].includes(message.type)) {
                selected.clear();
                message.uris.forEach(uri => { const index = items.indexOf(uri); if (index >= 0) selected.add(index); });
                paint();
            }
            if (message.type === 'marquee') {
                if (message.phase === 'press') startRubber(Boolean(message.additive));
                else if (message.phase === 'update' && rubber) tickRubber();
                else if (message.phase === 'end') { if (rubber) tickRubber(); endRubber(); syncNative(); }
            }
            if (message.type === 'open') message.uris.forEach(launch);
            else if (message.type === 'menu') {
                const hole = visibleHole();
                context(items.indexOf(message.uri), {get_coords: () => [hole.x + message.x, hole.y + message.y]});
            } else if (message.type === 'drop') { liveDrop = false; setHighlight(false); addFiles(message.uris); }
            else if (message.type === 'highlight') {
                liveDrop = message.active && !draggingOut;
                setHighlight(liveDrop);
            }
            else if (message.type === 'drag-begin') { draggingOut = true; setDismissReactive(false); }
            else if (message.type === 'drag-end') finishNative(message.uris, message.accepted);
            else if (message.type === 'scroll') {
                const adj = bar._popupScroll?.vadjustment;
                if (adj) adj.value = Math.max(adj.lower, Math.min(Math.max(adj.lower, adj.upper - adj.page_size), adj.value + message.delta * 48));
            } else if (message.type === 'key') {
                if (message.key === Clutter.KEY_Escape) bar._close();
                else if (message.ctrl && [Clutter.KEY_c, Clutter.KEY_C].includes(message.key)) copy();
                else if (message.ctrl && [Clutter.KEY_a, Clutter.KEY_A].includes(message.key)) { items.forEach((_uri, index) => selected.add(index)); paint(); }
                else if (message.key === Clutter.KEY_Return) selectedUris().forEach(launch);
            }
        };
        const adj = bar._popupScroll?.vadjustment;
        if (adj && !scrollSignal) scrollSignal = adj.connect('notify::value', () => syncNative());
        if (!nativeSync) nativeSync = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { syncNative(); return GLib.SOURCE_CONTINUE; });
        syncNative();
    };
    const removeSelected = () => {
        const gone = new Set(selectedUris());
        files = files.filter(uri => !gone.has(uri)); persist(); refresh();
    };
    const clearAll = () => { files = []; persist(); refresh(); };
    const addFiles = incomingUris => {
        const next = mergeShelfFiles(files, incomingUris);
        if (next.length === files.length && next.every((uri, index) => uri === files[index])) return;
        files = next; persist(); refresh();
    };
    const setHighlight = on => { highlight.visible = on; if (on) highlight.set_size(Math.max(measured(area.width) || 320, 1), Math.max(area.height || 220, 1)); };
    const handleShelfDragOver = source => {
        if (draggingOut) return DND.DragMotionResult.NO_DROP;
        if (source === Main.xdndHandler || source?.isShelf) { setHighlight(true); return DND.DragMotionResult.COPY_DROP; }
        return DND.DragMotionResult.CONTINUE;
    };
    const acceptShelfDrop = source => {
        setHighlight(false);
        if (source === Main.xdndHandler) {
            readDndUris(cancel, uris => { if (!disposed && uris.length) addFiles(uris); });
            return true;
        }
        return false;
    };
    const open = uri => { if (uri) launch(uri); };
    const context = (index, event) => {
        closeMenu(); if (index >= 0 && !selected.has(index)) { selected.clear(); selected.add(index); last = index; paint(); }
        const entries = [];
        if (index >= 0) {
            entries.push({title: 'Open', icon: 'document-open-symbolic', shortcut: 'Enter', run: () => selectedUris().forEach(open)});
            entries.push('sep');
            entries.push({title: 'Copy', icon: 'edit-copy-symbolic', shortcut: 'Ctrl+C', run: copy});
            entries.push({title: 'Remove from shelf', icon: 'list-remove-symbolic', shortcut: '', run: removeSelected});
        }
        entries.push({title: 'Select all', icon: 'edit-select-all-symbolic', shortcut: 'Ctrl+A', run: () => { items.forEach((_uri, i) => selected.add(i)); paint(); }});
        entries.push({title: 'Clear shelf', icon: 'edit-clear-symbolic', shortcut: '', run: clearAll});
        menu = menuFromEvent(bar, event, entries);
        menu.actor.connect('destroy', () => { menu = null; });
    };
    const refresh = () => {
        if (refreshing || disposed) return;
        refreshing = true;
        const ticket = ++generation;
        const selectedNames = new Set(selectedUris());
        endRubber(); closeMenu(); list.destroy_all_children(); tiles = []; selected.clear(); items = [...files];
        const width = panelWidth();
        if (root.get_stage()) root.width = width;
        if (!items.length) {
            lastCols = 0;
            lastLayout = '';
            area.height = 220;
            if (!empty) {
                emptyHost = new St.Widget({
                    layout_manager: new Clutter.BinLayout(), reactive: false,
                    x_expand: true, y_expand: true,
                    x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
                });
                empty = text(bar, 'Drop files here to keep them handy');
                empty.accessible_name = 'Empty shelf';
                empty.x_expand = false; empty.y_expand = false;
                empty.x_align = Clutter.ActorAlign.CENTER;
                empty.y_align = Clutter.ActorAlign.CENTER;
                emptyHost.add_child(empty);
                area.insert_child_above(emptyHost, list);
            }
            emptyHost.visible = true;
            clear.reactive = false; clear.opacity = 90; status.text = '';
            refreshing = false;
            if (root.get_stage()) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { if (!disposed) bar._fitPopup?.(); return GLib.SOURCE_REMOVE; });
            return;
        }
        if (emptyHost) emptyHost.visible = false;
        area.height = -1;
        clear.reactive = true; clear.opacity = 255;
        const listMode = viewMode === 'list';
        const columns = listMode ? 1 : fileGridColumns(width, 4);
        lastCols = columns;
        lastLayout = layoutKey(width);
        const tileWidth = listMode ? fileListTileWidth(width) : fileGridTileWidth(width, columns);
        const inset = listMode ? fileListInset(width, tileWidth) : fileGridInset(width, columns, tileWidth);
        list.style = listMode
            ? `spacing: ${FILE_LIST_GAP}px; padding: 0 ${inset}px;`
            : `spacing: ${FILE_TILE_GAP}px; padding: 0 ${inset}px;`;
        let row;
        for (const [index, uri] of items.entries()) {
            if (!listMode && index % columns === 0) {
                row = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL, x_expand: false,
                    x_align: Clutter.ActorAlign.START, style: `spacing: ${FILE_TILE_GAP}px;`,
                });
                list.add_child(row);
            }
            const file = Gio.File.new_for_uri(uri);
            const content = listMode
                ? new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL, x_expand: true, y_expand: true,
                    y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 10px;',
                })
                : column();
            content.x_align = listMode ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER;
            const icon = new St.Icon({
                icon_name: 'text-x-generic',
                icon_size: listMode ? FILE_LIST_ICON : FILE_TILE_ICON,
                x_align: listMode ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            content.add_child(icon);
            const name = text(bar, file.get_basename() || uri);
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            if (listMode) {
                name.x_expand = true;
                name.y_align = Clutter.ActorAlign.CENTER;
            } else name.width = FILE_TILE_NAME;
            content.add_child(name);
            const tile = new St.Widget({
                reactive: true, can_focus: true, width: tileWidth, x_expand: false,
                x_align: Clutter.ActorAlign.START,
                layout_manager: new Clutter.BoxLayout({
                    orientation: listMode ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
                }),
                accessible_name: file.get_basename() || uri,
            });
            tile.add_child(content);
            tile._uri = uri;
            tiles.push(tile);
            if (listMode) list.add_child(tile);
            else row.add_child(tile);
            if (selectedNames.has(uri)) selected.add(index);
            file.query_info_async('standard::icon,standard::content-type,standard::size,thumbnail::path', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancel, (source, result) => {
                try {
                    const info = source.query_info_finish(result); if (disposed || ticket !== generation) return;
                    const thumb = info.get_attribute_byte_string('thumbnail::path');
                    const image = thumb ? Gio.File.new_for_path(thumb) : info.get_content_type()?.startsWith('image/') && info.get_size() < 20000000 ? file : null;
                    icon.gicon = image ? new Gio.FileIcon({file: image}) : info.get_icon();
                } catch { if (!disposed && ticket === generation) icon.icon_name = 'dialog-question-symbolic'; }
            });
            let clickedAt = 0;
            tile._delegate = {
                isShelf: true,
                uris: () => selected.has(index) ? selectedUris() : [uri],
                handleDragOver: handleShelfDragOver,
                acceptDrop: acceptShelfDrop,
            };
            tile.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 3) { context(index, event); return Clutter.EVENT_STOP; }
                if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                closeMenu(); const modifiers = event.get_state();
                if (modifiers & Clutter.ModifierType.SHIFT_MASK && last >= 0) { if (!(modifiers & Clutter.ModifierType.CONTROL_MASK)) selected.clear(); for (let i = Math.min(last, index); i <= Math.max(last, index); i++) selected.add(i); }
                else if (modifiers & Clutter.ModifierType.CONTROL_MASK) { if (selected.has(index)) selected.delete(index); else selected.add(index); last = index; }
                else { selected.clear(); selected.add(index); last = index; }
                paint(); tile.grab_key_focus();
                const at = GLib.get_monotonic_time();
                if (at - clickedAt < 400000 && !(modifiers & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK))) { clickedAt = 0; open(uri); return Clutter.EVENT_STOP; }
                clickedAt = at;
                return Clutter.EVENT_STOP;
            });
        }
        paint();
        refreshing = false;
        if (covered) tiles.forEach(tile => { tile.reactive = false; });
        if (root.get_stage())
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { if (!disposed) bar._fitPopup?.(); return GLib.SOURCE_REMOVE; });
    };
    clear.connect('clicked', clearAll);
    area.connect('notify::width', () => {
        if (disposed || !files.length) return;
        const next = layoutKey(panelWidth());
        if (next !== lastLayout && !relayout) relayout = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            relayout = 0; if (!disposed) refresh(); return GLib.SOURCE_REMOVE;
        });
    });
    area.connect('button-press-event', (_actor, event) => {
        const source = event.get_source();
        if (source && tiles.some(tile => tile === source || tile.contains(source))) return Clutter.EVENT_PROPAGATE;
        if (onMenu(source)) return Clutter.EVENT_PROPAGATE;
        if (event.get_button() === 3) { context(-1, event); return Clutter.EVENT_STOP; }
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        const additive = Boolean(event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK));
        startRubber(additive);
        area.grab_key_focus(); bar._persistPopup();
        rubberStage = global.stage.connect('captured-event', (_stage, motion) => {
            if (motion.type() === Clutter.EventType.BUTTON_RELEASE && motion.get_button() === 1) {
                tickRubber(); endRubber(); return Clutter.EVENT_STOP;
            }
            if (motion.type() === Clutter.EventType.KEY_PRESS && motion.get_key_symbol() === Clutter.KEY_Escape) {
                endRubber(); return Clutter.EVENT_STOP;
            }
            if (motion.type() === Clutter.EventType.MOTION) { tickRubber(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    });
    root._delegate = {isShelf: true, handleDragOver: handleShelfDragOver, acceptDrop: acceptShelfDrop};
    area._delegate = root._delegate;
    list._delegate = root._delegate;
    const overShelf = (x, y) => containsPoint(bar._popout, x, y) || containsPoint(root, x, y) || containsPoint(area, x, y);
    const tracker = global.backend.get_dnd();
    const move = tracker.connect('dnd-position-change', (_dnd, x, y) => {
        overDrop = overShelf(x, y);
        setHighlight(overDrop && !draggingOut);
        if (overDrop) bar._persistPopup();
    });
    const leave = tracker.connect('dnd-leave', () => {
        overDrop = false; setHighlight(false); syncNative();
    });
    const xdndEnd = Main.xdndHandler?.connect('drag-end', () => {
        overDrop = false; setHighlight(false); syncNative();
    });
    const monitor = {
        dragMotion(event) {
            if (event.source !== Main.xdndHandler || draggingOut) return DND.DragMotionResult.CONTINUE;
            overDrop = overShelf(event.x, event.y);
            setHighlight(overDrop);
            if (overDrop) { bar._persistPopup(); return DND.DragMotionResult.COPY_DROP; }
            return DND.DragMotionResult.CONTINUE;
        },
    };
    DND.addDragMonitor(monitor);
    const keySignal = global.stage.connect('captured-event', (_actor, event) => {
        const focus = global.stage.get_key_focus();
        if (event.type() !== Clutter.EventType.KEY_PRESS || !focus || !(root.contains(focus) || onMenu(focus))) return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol(), ctrl = event.get_state() & Clutter.ModifierType.CONTROL_MASK;
        if (menu && [Clutter.KEY_Up, Clutter.KEY_Down].includes(key)) { const entries = menu.box.get_children().filter(actor => actor instanceof St.Button); const index = entries.indexOf(focus); entries[(index + (key === Clutter.KEY_Down ? 1 : entries.length - 1)) % entries.length]?.grab_key_focus(); }
        else if (menu && key === Clutter.KEY_Return && focus instanceof St.Button && onMenu(focus)) focus.emit('clicked', 1);
        else if (ctrl && [Clutter.KEY_c, Clutter.KEY_C].includes(key)) copy();
        else if (ctrl && [Clutter.KEY_a, Clutter.KEY_A].includes(key)) { items.forEach((_uri, i) => selected.add(i)); paint(); }
        else if (key === Clutter.KEY_Return && selected.size) selectedUris().forEach(open);
        else if (key === Clutter.KEY_Escape && menu) closeMenu(); else return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    });
    root.connect('destroy', () => {
        disposed = true; endRubber(); closeMenu(); generation++; cancel.cancel();
        if (relayout) GLib.source_remove(relayout);
        if (nativeSync) GLib.source_remove(nativeSync);
        if (scrollSignal && bar._popupScroll?.vadjustment) bar._popupScroll.vadjustment.disconnect(scrollSignal);
        if (helper.actor) bar._popupAuxActors?.delete(helper.actor);
        parkShelfHelper();
        tracker.disconnect(move); tracker.disconnect(leave);
        if (xdndEnd && Main.xdndHandler) Main.xdndHandler.disconnect(xdndEnd);
        DND.removeDragMonitor(monitor);
        global.stage.disconnect(keySignal);
        if (options.shelfRemember === false) { files = []; saveShelfFiles([], storage); }
        bar._shelfOpen = false;
        bar._popupInputHole = false;
    });
    viewButton.connect('clicked', () => {
        setViewMode(viewMode === 'list' ? 'grid' : 'list');
        refresh();
    });
    root._addFiles = addFiles;
    root._files = () => [...files];
    root._selectedUris = selectedUris;
    root._viewMode = () => viewMode;
    root._startMarquee = additive => startRubber(Boolean(additive));
    root._tickMarquee = () => tickRubber();
    root._endMarquee = () => { if (rubber) { tickRubber(); endRubber(); } };
    const start = root.connect('notify::mapped', () => {
        if (!root.mapped || disposed) return;
        root.disconnect(start);
        refresh();
        bar._fitPopup?.();
        startNative();
    });
    return root;
}

export function openShelf(bar, anchor = bar._actor, features = {}) {
    if (bar._destroyed || bar._popoutId === 'shelf') return;
    const options = {...moduleFeatures(bar, 'shelf'), ...features};
    bar._open('shelf', anchor, () => {
        bar._popupWidth = Math.min(428, bar._monitor.width - bar._side.left - bar._side.right - 32);
        bar._popout.width = bar._popupWidth;
        bar._popupCloseOutside = options.shelfCloseOutside !== false;
        return shelfView(bar, options);
    });
    bar._shelfOpen = Boolean(bar._popout);
}

const shelfOpen = bar => bar._popoutId === 'shelf' || bar._shelfOpen;
export function shelfFace(bar, size) {
    retainShelfHelper(moduleFeatures(bar, 'shelf').shelfDragAction || 'copy');
    const face = new St.Button({child: new St.Icon({icon_name: 'folder-download-symbolic', icon_size: size}), can_focus: true, accessible_name: 'File shelf'});
    face._activate = () => { if (shelfOpen(bar)) bar._close(); else openShelf(bar, face); };
    face.track_hover = true;
    let hover = 0;
    face.connect('notify::hover', () => {
        if (hover) GLib.source_remove(hover); hover = 0;
        if (face.hover && bar._hoverFor('shelf')) hover = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { hover = 0; openShelf(bar, face); return GLib.SOURCE_REMOVE; });
    });
    const dnd = global.backend.get_dnd(); let pending = 0;
    const signal = dnd.connect('dnd-position-change', (_tracker, x, y) => {
        if (moduleFeatures(bar, 'shelf').shelfOpenOnDrag === false) return;
        if (bar._state.autohide) {
            const m = bar._monitor, edge = bar._state.edge;
            const within = x >= m.x && x <= m.x + m.width && y >= m.y && y <= m.y + m.height;
            const near = edge === 'top' ? y <= m.y + 4 : edge === 'bottom' ? y >= m.y + m.height - 4 : edge === 'left' ? x <= m.x + 4 : x >= m.x + m.width - 4;
            if (within && near) { bar._slide(true, false); bar._slideLater(); }
        }
        const [ax, ay] = face.get_transformed_position(), [width, height] = face.get_transformed_size();
        const over = x >= ax && x <= ax + width && y >= ay && y <= ay + height;
        if (over && !shelfOpen(bar) && !pending) pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => { pending = 0; openShelf(bar, face, {openedForDrag: true}); return GLib.SOURCE_REMOVE; });
        if (!over && pending) { GLib.source_remove(pending); pending = 0; }
    });
    const leave = dnd.connect('dnd-leave', () => { if (pending) GLib.source_remove(pending); pending = 0; });
    face.connect('destroy', () => { if (hover) GLib.source_remove(hover); dnd.disconnect(leave); dnd.disconnect(signal); if (pending) GLib.source_remove(pending); }); return face;
}
export function shelfPanel(bar, features = {}) {
    const button = new St.Button({label: 'Open file shelf', can_focus: true, style: `padding: 12px; border-radius: 12px; background-color: ${bar._theme.surface}; color: ${bar._theme.fg};`});
    button.connect('clicked', () => { bar._close(); openShelf(bar, bar._actor, features); }); return button;
}
