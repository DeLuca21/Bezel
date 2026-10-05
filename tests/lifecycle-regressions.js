// Run from the repository root: gjs -m tests/lifecycle-regressions.js
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import {hexToRgba} from '../bezel@deluca21/lib/theme.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const lib = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('bezel@deluca21/lib');
const load = (name, bindings, exports) => {
    const source = new TextDecoder().decode(lib.get_child(name).load_contents(null)[1])
        .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '')
        .replaceAll('import.meta.url', JSON.stringify(lib.get_child(name).get_uri()));
    return new Function(...Object.keys(bindings), `${source}\nreturn {${exports}};`)(...Object.values(bindings));
};
let nextId = 1;
const timers = new Map();
const scheduler = { PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
    timeout_add_seconds(_priority, _seconds, callback) { const id = nextId++; timers.set(id, callback); return id; },
    source_remove(id) { assert(timers.delete(id), 'timer released exactly once'); },
};
class ActorText { connect() {} }
class Actor {
    constructor(props = {}) { this.children = []; this.signals = new Map(); this.clutter_text = new ActorText(); Object.assign(this, {opacity: 255, height: 200, visible: true}, props); }
    connect(name, callback) { assert(!this.dead, 'cannot connect destroyed actor'); const id = nextId++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { assert(!this.dead, 'cannot disconnect disposed actor'); assert(this.signals.delete(id), 'signal released exactly once'); }
    emit(name, ...args) { for (const [id, signal] of [...this.signals]) if (this.signals.has(id) && signal.name === name) signal.callback(this, ...args); }
    count(name) { return [...this.signals.values()].filter(signal => signal.name === name).length; }
    add_child(actor) { this.children.push(actor); actor.parent = this; }
    destroy() { if (this.dead) return; this.emit('destroy'); for (const child of this.children) child.destroy(); this.dead = true; this.signals.clear(); }
    set child(actor) { this._child = actor; this.add_child(actor); }
    get child() { return this._child; }
    get_text() { return this.text || ''; }
    destroy_all_children() { for (const child of this.children) child.destroy(); this.children = []; }
    get_parent() { return this.parent; }
    set_style(style) { this.style = style; }
    add_style_class_name() {}
    set_mouse_scrolling() {}
}
const St = {Widget: Actor, BoxLayout: Actor, Label: Actor, Button: Actor, Entry: Actor, Icon: Actor, PolicyType: {NEVER: 0}};
const Clutter = {BinLayout: class {}, Orientation: {VERTICAL: 1, HORIZONTAL: 0}, ActorAlign: {END: 0, START: 1}};

const calls = [];
const clipboardCallbacks = [];
const bus = {call(...args) { calls.push({method: args[3], params: args[4], cancel: args[8], finish: args[9]}); },
    call_finish: result => ({deepUnpack: () => result}), signal_unsubscribe() {}};
const serviceGio = {BusType: Gio.BusType, DBusCallFlags: Gio.DBusCallFlags, DBus: {session: bus}};
const clipboardSt = {Clipboard: {get_default: () => ({get_text(_type, callback) { clipboardCallbacks.push(callback); }})}, ClipboardType: {CLIPBOARD: 0}};
const {Services} = load('services.js', {Gio: serviceGio, GLib, St: clipboardSt}, 'Services');
const makeService = () => Object.assign(Object.create(Services.prototype), {
    _cancellable: new Gio.Cancellable(), _listeners: new Set(), _awakeCookie: 0, _awakePending: false, _awakeWanted: false,
    _history: [], _clipLast: '', _signals: [], _streamSignals: [], _players: new Map(), _pendingPlayers: new Map(),
});
for (const disable of [false, true]) {
    calls.length = 0;
    const service = makeService();
    service.setAwake(true); service.setAwake(true);
    assert(service.awake && calls.length === 1, 'one pending inhibitor reflects requested state immediately');
    const request = calls.shift();
    assert(request.cancel === null, 'late inhibitor reply remains readable after disable');
    if (disable) service.destroy(); else service.setAwake(false);
    request.finish(bus, [123]);
    assert(!service.awake && calls.length === 1 && calls[0].method === 'Uninhibit', 'off/disable releases late inhibitor');
    assert(calls[0].params.deepUnpack()[0] === 123, 'correct inhibitor released');
}
calls.length = 0;
const awake = makeService();
awake.setAwake(true); awake.setAwake(false); awake.setAwake(true);
assert(calls.length === 1, 'on-off-on reuses pending acquisition');
calls.shift().finish(bus, [456]);
assert(awake.awake && awake._awakeCookie === 456, 'latest intent wins');
awake.destroy();
assert(calls.length === 1 && calls[0].method === 'Uninhibit', 'live cookie released at teardown');
print('PASS keep-awake: duplicate toggles, on-off-on, late completion after off and disable');

const network = makeService();
let path = '/A';
network.network = {get_cached_property: () => ({deepUnpack: () => path})};
const requests = [];
network._proxy = (...args) => requests.push(args.at(-1));
network._syncNetworkConnection(); path = '/B'; network._syncNetworkConnection(); path = '/A'; network._syncNetworkConnection();
const staleA = new Actor(), staleB = new Actor(), currentA = new Actor();
requests[2](currentA); requests[0](staleA); requests[1](staleB);
assert(network.connection === currentA && currentA.signals.size === 1 && !staleA.signals.size && !staleB.signals.size, 'A-B-A rejects outdated proxy completions');
network.destroy(); assert(currentA.signals.size === 0, 'current network signal released');
print('PASS network: out-of-order proxy results and path reuse');

const clips = makeService();
clips._pollClipboard(); clips._pollClipboard();
assert(clipboardCallbacks.length === 1, 'clipboard requests cannot accumulate');
clipboardCallbacks.shift()(null, 'small entry');
clips._rememberClip('x'.repeat(65537));
assert(clips.clipboard.length === 1 && clips._clipLast === 'small entry', 'large clipboard payload is not retained or truncated');
for (let i = 0; i < 100; i++) clips._rememberClip(`entry ${i}`);
assert(clips.clipboard.length === 40, 'clipboard history count remains bounded');
clips._pollClipboard(); clips.destroy(); clipboardCallbacks.shift()(null, 'after disable');
assert(clips._clipLast !== 'after disable', 'late clipboard read ignored');
print('PASS clipboard: one pending request, bounded content and history, disable during read');

const proxyCallbacks = [];
const proxy = new Actor(); proxy.get_name_owner = () => 'owner'; proxy.get_cached_property = () => ({unpack: () => 'balanced'});
const processes = [];
const faceGio = {Cancellable: Gio.Cancellable, BusType: Gio.BusType, DBusProxyFlags: Gio.DBusProxyFlags, SubprocessFlags: Gio.SubprocessFlags,
    DBusProxy: {new_for_bus(...args) { proxyCallbacks.push(args.at(-1)); }, new_for_bus_finish(result) { if (result.error) throw new Error('unavailable'); return proxy; }},
    Subprocess: {new() {
        const proc = {cancel: null, finish: null, exits: 0,
            force_exit() { this.exits++; },
            communicate_utf8_async(_input, cancel, finish) { this.cancel = cancel; this.finish = finish; },
            communicate_utf8_finish: () => [true, 'work:vpn:tun0'],
        }; processes.push(proc); return proc;
    }},
};
const faces = load('extraModules.js', {Gio: faceGio, GLib: scheduler}, 'watchProfile, watchVpn');
for (const fallback of [false, true]) {
    const button = new Actor(); let paints = 0;
    faces.watchProfile(button, () => paints++);
    if (fallback) proxyCallbacks.shift()(null, {error: true});
    button.destroy(); proxyCallbacks.shift()(null, {});
    assert(proxy.signals.size === 0 && paints === 0, 'late profile completion installs no listeners');
}
const failed = new Actor(); faces.watchProfile(failed, () => {}); failed.destroy(); proxyCallbacks.shift()(null, {error: true});
assert(proxyCallbacks.length === 0, 'destroyed profile does not launch fallback');
const live = new Actor(); let profilePaints = 0;
faces.watchProfile(live, () => profilePaints++); proxyCallbacks.shift()(null, {});
assert(profilePaints === 1 && proxy.signals.size === 1, 'live profile paints normally');
live.destroy(); assert(proxy.signals.size === 0, 'profile listener released');
const vpn = new Actor(); let vpnPaints = 0; faces.watchVpn(vpn, () => vpnPaints++);
for (let i = 0; i < 20; i++) [...timers.values()].forEach(callback => callback());
assert(processes.length === 1, 'slow VPN process cannot overlap refreshes');
vpn.destroy(); processes[0].finish(null, {});
assert(processes[0].exits === 1 && processes[0].cancel.is_cancelled() && vpnPaints === 0 && timers.size === 0, 'VPN reader and timer released with no late actor updates');
print('PASS module faces: late profile proxy/fallback, normal subscription teardown, slow VPN cancellation');
const cacheServices = makeService(); cacheServices._rememberClip('retained item');
let iconCreates = 0;
const cacheGio = {File: Gio.File, FileIcon: class { constructor() { iconCreates++; } }, ThemedIcon: class { constructor() { iconCreates++; } }};
const widgets = load('extraModules.js', {Gio: cacheGio, St, Clutter, Pango: {EllipsizeMode: {END: 0}},
    moduleLook: () => ({icon: true, value: true, art: true})}, 'buildClipboardPanel, buildMediaFace');
const bar = {_overlay: {services: cacheServices}, _theme: {}, _state: {modules: []}, _close() {}};
const clipPanel = widgets.buildClipboardPanel(bar);
const originalRow = clipPanel.children[1].children[0];
for (let i = 0; i < 100; i++) cacheServices._emit();
assert(clipPanel.children[1].children[0] === originalRow && !originalRow.dead, 'unrelated service events preserve clipboard rows and keyboard focus');
cacheServices._rememberClip('another item');
assert(originalRow.dead && clipPanel.children[1].children.length === 2, 'new clipboard data refreshes rows');
Object.defineProperty(cacheServices, 'media', {value: {artUrl: 'file:///tmp/cover.png', title: 'Track'}, writable: true});
const mediaFace = widgets.buildMediaFace(bar, 16);
for (let i = 0; i < 100; i++) cacheServices._emit();
assert(iconCreates === 1, 'unrelated service events reuse album artwork');
cacheServices.media = {artUrl: 'file:///tmp/next.png', title: 'Next'}; cacheServices._emit();
assert(iconCreates === 2, 'new artwork is loaded when it changes');
clipPanel.destroy(); mediaFace.destroy();
assert(cacheServices._listeners.size === 0, 'cached widgets still unsubscribe on destruction');
print('PASS UI updates: clipboard focus/rows and album artwork survive unrelated service events');

// Exercise the native group itself: an emitter can be disposed before its owner.
const nativeSignals = GObject.SignalGroup.new(Gio.Cancellable);
const nativeTarget = new Gio.Cancellable();
let nativeCalls = 0;
nativeSignals.connect_data('cancelled', () => nativeCalls++, 0);
nativeSignals.set_target(nativeTarget);
nativeTarget.cancel(); nativeTarget.run_dispose();
nativeSignals.set_target(null);
assert(nativeCalls === 1 && nativeSignals.dup_target() === null, 'native signal group safely releases a disposed target');
class SignalGroup {
    static new() { return new SignalGroup(); }
    constructor() { this.handlers = []; this.ids = []; this.target = null; }
    connect_data(signal, callback) { this.handlers.push([signal, callback]); }
    set_target(target) {
        if (this.target && !this.target.dead) for (const id of this.ids) this.target.disconnect(id);
        this.target = target;
        this.ids = target ? this.handlers.map(([signal, callback]) => target.connect(signal, callback)) : [];
    }
}
const {decorateScroll} = load('overflow.js', {St, Clutter, GObject: {SignalGroup}, hexToRgba}, 'decorateScroll');
for (const showThumb of [false, true]) for (const disposeAdjustmentFirst of [false, true]) {
    const adjustment = new Actor({upper: 500, page_size: 200, value: 40});
    const scroll = new Actor({vadjustment: adjustment});
    const stack = decorateScroll(scroll, {bg: '#000000', muted: '#888888'}, showThumb);
    const overlay = stack.children[1];
    assert(overlay.visible && overlay.opacity === 255, 'overflow indication is painted');
    assert(overlay.children[2].visible === showThumb, 'thumb preference respected');
    adjustment.upper = 200; adjustment.emit('notify::upper');
    assert(!overlay.visible, 'overflow disappears when content fits');
    if (disposeAdjustmentFirst) adjustment.destroy();
    stack.destroy();
    assert(adjustment.signals.size === 0 && overlay.children.every(child => child.dead), 'adjustment handlers and hidden thumb released');
}
print('PASS scrolling: visible overflow hints and cleanup before/after native adjustment disposal');

const {NotificationBridge} = load('notifications.js', {St}, 'NotificationBridge');
const bridge = Object.assign(Object.create(NotificationBridge.prototype), {bin: {}, records: new Map(), pendingStyles: new Map()});
const banner = new Actor(); banner.has_style_class_name = () => false;
bridge.decorate(banner); bridge.decorate(banner);
assert(banner.signals.size === 2 && bridge.pendingStyles.size === 1, 'pending banner style is watched only once');
banner.emit('notify::style-class'); assert(bridge.pendingStyles.size === 1, 'unrelated style change retains pending watcher');
banner.destroy(); assert(bridge.pendingStyles.size === 0, 'destroyed pending banner is released');
const pendingBanner = new Actor(); pendingBanner.has_style_class_name = () => false;
bridge.decorate(pendingBanner);
const tray = new Actor();
Object.assign(bridge, {tray, bin: new Actor(), layer: new Actor(), sourceSignals: new Map(), deliveryTimers: new Set(),
    sourceAdded: tray.connect('source-added', () => {}), signals: [], parent: {}, original: {}});
bridge.destroy();
assert(pendingBanner.signals.size === 0 && bridge.pendingStyles.size === 0, 'disable disconnects style listeners from surviving native banners');
pendingBanner.emit('notify::style-class');
print('PASS notifications: deduplicated pending style watches, banner destruction and bridge teardown');

const display = new Actor(), wm = new Actor();
const originalAnimate = () => true;
const main = {wm: {_shouldAnimate: originalAnimate}};
const helpers = [];
const helperGio = {File: Gio.File, Cancellable: Gio.Cancellable, SubprocessFlags: Gio.SubprocessFlags, SubprocessLauncher: class {
    setenv() {}
    spawnv() {
        const process = {reads: [], writes: [], get_identifier: () => `${helpers.length + 1}`, force_exit() {},
            wait_async(_cancel, finish) { this.wait = finish; }, wait_finish() {},
            get_stdin_pipe() { return {write_all_async: (_data, _priority, _cancel, callback) => this.writes.push(callback), write_all_finish() {}}; },
            get_stdout_pipe() { return this; },
        }; helpers.push(process); return process;
    }
}, DataInputStream: class {
    constructor({base_stream}) { this.proc = base_stream; }
    read_line_async(_priority, _cancel, callback) { this.proc.reads.push(callback); }
    read_line_finish_utf8(result) { return [result]; }
}};
const shelf = load('shelf.js', {Gio: helperGio, GLib, Main: main, global: {display, window_manager: wm}}, 'retainShelfHelper, stopShelfHelper, helper, writeHelper');
shelf.retainShelfHelper(); const old = helpers[0]; shelf.writeHelper({old: true}); shelf.stopShelfHelper();
shelf.retainShelfHelper(); const current = helpers[1]; let messages = 0; shelf.helper.onMessage = () => messages++;
shelf.writeHelper({current: true});
old.writes[0]({write_all_finish() {}}, {}); old.reads[0]({read_line_finish_utf8: () => ['{}']}, {}); old.wait(old, {});
assert(shelf.helper.proc === current && shelf.helper.writing && messages === 0, 'stale helper callbacks cannot mutate new process or deliver messages');
current.wait(current, {});
assert(!shelf.helper.proc && !shelf.helper.writing && !shelf.helper.queued && display.signals.size === 0 && wm.signals.size === 0 && main.wm._shouldAnimate === originalAnimate, 'unexpected helper exit releases listeners and animation hook');
print('PASS shelf: stop/restart with pending reads and writes, unexpected process exit cleanup');
print('PASS: all lifecycle regression checks');
