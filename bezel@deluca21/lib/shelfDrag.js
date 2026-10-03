// A transparent native input surface behind the Shell-rendered shelf grid.
// The original press must reach GTK: Wayland cannot transfer a Shell press
// to a newly spawned client halfway through a drag.
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import cairo from 'gi://cairo';

const config = JSON.parse(ARGV[0] || '{}');
const app = new Gtk.Application({application_id: 'io.github.deluca21.Bezel.ShelfDrag', flags: Gio.ApplicationFlags.NON_UNIQUE});
const send = message => print(JSON.stringify(message));
let state = {tiles: [], selected: []}, dragging = false, pending = null, selecting = false;
const providerFor = uris => Gdk.ContentProvider.new_for_bytes('text/uri-list',
    new GLib.Bytes(new TextEncoder().encode(`${uris.join('\r\n')}\r\n`)));

app.connect('activate', () => {
    const css = new Gtk.CssProvider();
    css.load_from_string('window, window.csd, window.solid-csd, fixed, box, .shelf-hit, .shelf-drop { background: transparent; box-shadow: none; border: none; padding: 0; margin: 0; min-width: 0; min-height: 0; border-radius: 0; } window { background: rgba(0,0,0,0.004); }');
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    const window = new Gtk.Window({application: app, decorated: false, resizable: true,
        title: config.title, default_width: 1, default_height: 1});
    window.set_decorated(false);
    window.set_resizable(true);
    try { window.set_titlebar(null); } catch {}
    window.connect('realize', () => {
        try { window.get_surface()?.set_opaque_region(new cairo.Region()); } catch {}
    });
    const fixed = new Gtk.Fixed();
    window.set_child(fixed);
    const dropHost = new Gtk.Box({hexpand: true, vexpand: true});
    dropHost.add_css_class('shelf-drop');
    fixed.put(dropHost, 0, 0);
    const actions = config.action === 'move' ? Gdk.DragAction.MOVE
        : config.action === 'ask' ? Gdk.DragAction.COPY | Gdk.DragAction.MOVE : Gdk.DragAction.COPY;
    const urisFrom = value => {
        if (typeof value === 'string')
            return value.split(/\r?\n/).map(line => line.trim()).filter(uri => uri.startsWith('file:'));
        if (value instanceof Uint8Array)
            return urisFrom(new TextDecoder().decode(value));
        if (value?.get_files) return value.get_files().map(file => file.get_uri());
        if (Array.isArray(value)) return value.flatMap(urisFrom);
        if (value?.get_uri) return [value.get_uri()];
        return [];
    };
    const acceptDrop = value => {
        if (dragging) return false;
        const uris = urisFrom(value);
        if (!uris.length) return false;
        send({type: 'drop', uris});
        return true;
    };
    const makeDrop = highlight => {
        const drop = new Gtk.DropTarget({actions: Gdk.DragAction.COPY});
        drop.set_gtypes([Gdk.FileList.$gtype]);
        drop.connect('enter', () => {
            if (dragging) return 0;
            if (highlight) send({type: 'highlight', active: true});
            return Gdk.DragAction.COPY;
        });
        if (highlight) drop.connect('leave', () => send({type: 'highlight', active: false}));
        drop.connect('drop', (_target, value) => acceptDrop(value));
        return drop;
    };
    const clearTiles = () => {
        let child = fixed.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            if (child !== dropHost) fixed.remove(child);
            child = next;
        }
    };
    const apply = next => {
        if (next.hidden) {
            pending = null;
            selecting = false;
            state = {...next, last: state.last};
            clearTiles();
            window.set_size_request(1, 1);
            window.set_default_size(1, 1);
            dropHost.set_size_request(1, 1);
            window.hide();
            return;
        }
        if (dragging || selecting) { pending = next; return; }
        const unchanged = state.width === next.width && state.height === next.height && JSON.stringify(state.tiles) === JSON.stringify(next.tiles) && !next.hidden && !state.hidden;
        state = {...next, last: next.last || state.last};
        if (unchanged && window.get_visible()) return;
        window.set_size_request(next.width, next.height);
        window.set_default_size(next.width, next.height);
        dropHost.set_size_request(next.width, next.height);
        if (!window.get_visible()) window.present();
        clearTiles();
        for (const tile of next.tiles) {
            const x = Math.max(0, tile.x), y = Math.max(0, tile.y);
            const width = Math.min(tile.x + tile.width, next.width) - x;
            const height = Math.min(tile.y + tile.height, next.height) - y;
            if (width < 1 || height < 1) continue;
            const hit = new Gtk.Box({width_request: width, height_request: height});
            hit.add_css_class('shelf-hit');
            fixed.put(hit, x, y);
            const click = new Gtk.GestureClick({button: 0});
            click.connect('pressed', (gesture, count, x, y) => {
                const button = gesture.get_current_button();
                const modifiers = gesture.get_current_event_state();
                if (button === 1) {
                    if (modifiers & Gdk.ModifierType.SHIFT_MASK && state.last) {
                        const a = state.tiles.findIndex(t => t.uri === state.last), b = state.tiles.findIndex(t => t.uri === tile.uri);
                        const range = state.tiles.slice(Math.min(a, b), Math.max(a, b) + 1).map(t => t.uri);
                        state.selected = modifiers & Gdk.ModifierType.CONTROL_MASK ? [...new Set([...state.selected, ...range])] : range;
                    } else if (modifiers & Gdk.ModifierType.CONTROL_MASK) {
                        state.selected = state.selected.includes(tile.uri) ? state.selected.filter(uri => uri !== tile.uri) : [...state.selected, tile.uri];
                        state.last = tile.uri;
                    } else if (!state.selected.includes(tile.uri)) { state.selected = [tile.uri]; state.last = tile.uri; }
                    send({type: count === 2 && !(modifiers & (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK)) ? 'open' : 'select', uris: state.selected});
                } else if (button === 3) {
                    if (!state.selected.includes(tile.uri)) state.selected = [tile.uri];
                    send({type: 'menu', uri: tile.uri, uris: state.selected, x: tile.x + x, y: tile.y + y});
                }
            });
            hit.add_controller(click);
            const drag = new Gtk.DragSource({actions});
            let uris = [], completed = false;
            drag.connect('prepare', () => {
                uris = state.selected.includes(tile.uri) ? [...state.selected] : [tile.uri];
                return providerFor(uris);
            });
            drag.connect('drag-begin', (_source, native) => {
                dragging = true; completed = false;
                send({type: 'drag-begin'});
                try {
                    const info = Gio.File.new_for_uri(tile.uri).query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, null);
                    const paintable = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).lookup_by_gicon(info.get_icon(), 48, 1, Gtk.TextDirection.NONE, 0);
                    Gtk.DragIcon.set_from_paintable(native, paintable, 24, 24);
                } catch {}
                native.connect('dnd-finished', () => { completed = true; });
            });
            drag.connect('drag-cancel', () => { completed = false; return false; });
            drag.connect('drag-end', () => {
                // GTK's drag-end handler can run before our Gdk dnd-finished
                // handler. Keep the source/provider alive through that signal.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    dragging = false;
                    send({type: 'drag-end', uris, accepted: completed});
                    if (pending) { const next = pending; pending = null; apply(next); }
                    return GLib.SOURCE_REMOVE;
                });
            });
            hit.add_controller(drag);
            hit.add_controller(makeDrop(false));
        }
    };
    dropHost.add_controller(makeDrop(true));
    fixed.add_controller(makeDrop(true));
    const overTile = (x, y) => state.tiles.some(tile => x >= tile.x && y >= tile.y && x < tile.x + tile.width && y < tile.y + tile.height);
    const finishSelect = () => {
        if (!selecting) return;
        selecting = false;
        send({type: 'marquee', phase: 'end'});
        if (pending) { const next = pending; pending = null; apply(next); }
    };
    const background = new Gtk.GestureClick({button: 0});
    background.connect('pressed', (gesture, _count, x, y) => {
        if (overTile(x, y)) return;
        const button = gesture.get_current_button();
        if (button === 3) send({type: 'menu', uri: null, uris: state.selected, x, y});
        if (button !== 1) return;
        const additive = Boolean(gesture.get_current_event_state() & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK));
        if (!additive) state.selected = [];
        selecting = true;
        send({type: 'marquee', phase: 'press', additive, uris: state.selected});
    });
    background.connect('released', (gesture) => {
        if (gesture.get_current_button() === 1) finishSelect();
    });
    background.connect('cancel', finishSelect);
    dropHost.add_controller(background);
    const motion = new Gtk.EventControllerMotion();
    motion.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    motion.connect('motion', () => { if (selecting) send({type: 'marquee', phase: 'update'}); });
    dropHost.add_controller(motion);
    const band = new Gtk.GestureDrag({button: 1});
    band.connect('drag-begin', (gesture, x, y) => {
        if (overTile(x, y)) { gesture.set_state(Gtk.EventSequenceState.DENIED); return; }
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        if (!selecting) {
            const additive = Boolean(gesture.get_current_event_state() & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK));
            selecting = true;
            send({type: 'marquee', phase: 'press', additive, uris: additive ? state.selected : []});
        }
    });
    band.connect('drag-update', () => { if (selecting) send({type: 'marquee', phase: 'update'}); });
    band.connect('drag-end', finishSelect);
    band.connect('cancel', finishSelect);
    dropHost.add_controller(band);
    const scroll = new Gtk.EventControllerScroll({
        flags: Gtk.EventControllerScrollFlags.BOTH_AXES | (Gtk.EventControllerScrollFlags.DISCRETE || 0),
    });
    scroll.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    scroll.connect('scroll', (_controller, dx, dy) => { send({type: 'scroll', delta: dy || dx}); return true; });
    window.add_controller(scroll);
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_keys, key, _code, modifiers) => {
        const ctrl = Boolean(modifiers & Gdk.ModifierType.CONTROL_MASK);
        if (![Gdk.KEY_Escape, Gdk.KEY_Return].includes(key) && !(ctrl && [Gdk.KEY_a, Gdk.KEY_A, Gdk.KEY_c, Gdk.KEY_C].includes(key))) return false;
        send({type: 'key', key, ctrl}); return true;
    });
    window.add_controller(keys);
    const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
    const read = () => input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        let line;
        try { [line] = stream.read_line_finish_utf8(result); } catch { app.quit(); return; }
        if (line === null) { app.quit(); return; }
        try { apply(JSON.parse(line)); } catch (error) { printerr(error); }
        read();
    });
    read();
});
app.run([]);
