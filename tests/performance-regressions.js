// Headless regression checks: actual extension source, simulated Shell actors.
// Run from the repository root: gjs -m tests/performance-regressions.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import {nextLayoutName} from '../bezel@deluca21/lib/profiles.js';
import {dashboardPages, switchOn} from '../bezel@deluca21/lib/config.js';
import * as dashboardGeometry from '../bezel@deluca21/lib/dashboardGeometry.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const base = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('bezel@deluca21/lib');
const read = name => new TextDecoder().decode(base.get_child(name).load_contents(null)[1]);
const load = (name, bindings, exports) => new Function(...Object.keys(bindings),
    read(name).replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '') + `\nreturn {${exports}};`)(...Object.values(bindings));

let nextId = 1;
let now = 0;
const jobs = new Map();
const completions = [];
const schedule = {PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
    get_monotonic_time: () => now * 1000,
    timeout_add(_priority, delay, callback) { const id = nextId++; jobs.set(id, {at: now + delay, callback}); return id; },
    idle_add(_priority, callback) { return this.timeout_add(0, 0, callback); },
    source_remove(id) { jobs.delete(id); }, DateTime: GLib.DateTime, get_real_name: () => 'Test User',
    FileTest: GLib.FileTest, file_test: GLib.file_test, file_get_contents: GLib.file_get_contents,
};
const advance = () => {
    const [id, job] = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
    jobs.delete(id); now = job.at; job.callback();
};

class Actor {
    constructor(props = {}) {
        this.children = []; this.signals = new Map();
        Object.assign(this, {visible: true, opacity: 255, height: 64, width: 100, x: 0, y: 0,
            style: '', x_align: 2, y_align: 3, x_expand: true, width_set: false,
            margin_top: 1, margin_bottom: 2, margin_left: 3, margin_right: 4, translation_x: 0}, props);
    }
    check() { assert(!this.destroyed, 'operation on destroyed actor'); }
    set child(value) { if (value) this.add_child(value); this._child = value; }
    get child() { return this._child; }
    add_child(child) { this.insert_child_at_index(child, this.children.length); }
    insert_child_at_index(child, index) { this.check(); assert(!child.parent, 'actor already parented'); this.children.splice(index, 0, child); child.parent = this; }
    insert_child_above(child, previous) { this.insert_child_at_index(child, this.children.indexOf(previous) + 1); }
    remove_child(child) { const index = this.children.indexOf(child); assert(index >= 0, 'missing child'); this.children.splice(index, 1); child.parent = null; }
    set_child_at_index(child, index) { this.remove_child(child); this.insert_child_at_index(child, index); }
    set_child(child) { this.add_child(child); }
    get_parent() { this.check(); return this.parent; }
    get_children() { this.check(); return [...this.children]; }
    get_n_children() { return this.children.length; }
    get_first_child() { return this.children[0] ?? null; }
    get_style() { return this.style; }
    set_style(style) { this.check(); this.style = style; }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(width, height) { this.width = width; this.height = height; }
    contains(child) { return this.children.some(item => item === child || item.contains(child)); }
    connect(name, callback) { this.check(); const id = nextId++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { assert(this.signals.delete(id), `missing signal ${id}`); }
    emit(name, ...args) { for (const signal of [...this.signals.values()]) if (signal.name === name) signal.callback(this, ...args); }
    count(name) { return [...this.signals.values()].filter(signal => signal.name === name).length; }
    destroy_all_children() { this.check(); for (const child of [...this.children]) child.destroy(); }
    destroy() { if (this.destroyed) return; this.emit('destroy'); this.destroy_all_children(); this.parent?.remove_child(this); this.destroyed = true; this.signals.clear(); }
    ease(props) { if (props.onComplete) completions.push(props.onComplete); }
    remove_all_transitions() {} // Exercise even a stale completion after teardown.
    get_stage() { return null; }
    hide() { this.visible = false; }
    get_theme_node() { return {get_horizontal_padding: () => 0}; }
}
class BoxLayout extends Actor {}
class Label extends Actor { constructor(props) { super(props); this.clutter_text = {ellipsize: 0, line_alignment: 0}; } }
class Icon extends Actor {}
class Button extends Actor {}
let areaCreations = 0;
let areaDestructions = 0;
class DrawingArea extends Actor {
    constructor(props) { super(props); areaCreations++; this.repaints = 0; }
    queue_repaint() { this.check(); this.repaints++; }
    destroy() { if (!this.destroyed) areaDestructions++; super.destroy(); }
}
const St = {BoxLayout, Label, Icon, Widget: Actor, Button, DrawingArea, ScrollView: Actor,
    PolicyType: {NEVER: 0, AUTOMATIC: 1}, Settings: {get: () => ({})},
    ThemeContext: {get_for_stage: () => ({scale_factor: 1})}, Side: {LEFT: 0, RIGHT: 1, TOP: 2, BOTTOM: 3}};
const Clutter = {Orientation: {VERTICAL: 1, HORIZONTAL: 0}, ActorAlign: {CENTER: 1, FILL: 2, START: 3},
    BinLayout: class {}, GridLayout: class {}, AnimationMode: {EASE_OUT_CUBIC: 1},
    KEY_Up: 1, KEY_Down: 2, EVENT_PROPAGATE: 0, EVENT_STOP: 1};
const theme = {fg: '#ffffff', bg: '#000000', accent: '#ff0000', surface: '#222222', muted: '#999999', border: '#555555'};
const shell = read('shell.js');
const timerCode = shell.slice(shell.indexOf('    _later(key,'), shell.indexOf('    _boxSpacing(actor)'));
const Timers = new Function('GLib', `return class {${timerCode}};`)(schedule);
const makeBar = () => Object.assign(new Timers(), {_timers: new Set(), _theme: theme, _state: {pinned: [], modules: []},
    _overlay: {_settings: {}}, _popout: new Actor({width: 480}), _popupCleanups: [], _persistPopup() {},
    _stackHeight: () => 10, _setPopupHeight() {}, _fitPopup() {}, _close() {},
});

// All meters advance from the same sample, even when mixed with a faster clock.
let layout = {overview: [], media: [], performance: [], workspaces: []};
const dashboard = load('dashboard.js', {Cairo: {}, Clutter, Gio, GLib: schedule, St, Shell: {}, Pango,
    ...dashboardGeometry, dashboardPages, Meta: {LaterType: {IDLE: 0}},
    global: {compositor: {get_laters: () => ({add: (_type, callback) => schedule.idle_add(0, callback), remove: id => schedule.source_remove(id)})}},
    DASHBOARD_WIDGETS: {}, readDashboard: () => layout, saveDashboard() {}, DATE_FORMATS: {long: {format: '%F'}},
    timePattern: () => '%H:%M:%S', settingChoice: (_settings, _key, fallback) => fallback,
    settingFlag: () => true, allowsMotion: () => true, profileAvatar: () => new Actor(), weatherWidget: () => new Actor(), Main: {}},
    'buildDashboard, widgetFor, pageUpdates');
for (const order of [['cpu', 'memory', 'temp'], ['temp', 'cpu', 'memory'], ['memory'], ['gpu', 'disk', 'network', 'cpu']]) {
    now = 0; jobs.clear();
    const bar = makeBar(); let reads = 0;
    const updates = dashboard.pageUpdates(bar, () => { reads++; return {cpu: .5, memoryRatio: .25, memoryUsed: 1,
        temperature: 40, gpu: .3, diskRatio: .2, diskTotal: 100, diskUsed: 20, netDown: reads * 1024, netUp: reads * 512}; });
    const meters = order.map(id => dashboard.widgetFor(bar, id, theme, updates, [], () => {}, false));
    dashboard.widgetFor(bar, 'identity', theme, updates, [], () => {}, false);
    updates.start();
    while (now < 6000) advance();
    assert(reads === 5, 'one metrics sample at initialization and each 1500 ms tick');
    assert(meters.every((actor, index) => order[index] === 'network'
        ? actor.children[0].text.includes('5.0') : actor.children[0].children[0].repaints === 5), 'every meter continues refreshing');
    updates.stop(); assert(jobs.size === 0, 'page timer removed');
}
print('PASS dashboard: shared sampling, reordered/reduced meters, clock coexistence');

const {Services} = load('services.js', {Gio, GLib, Volume: {}, clamp: value => value}, 'Services');
const services = Object.create(Services.prototype); services._listeners = new Set();
const values = {CanControl: true, PlaybackStatus: 'Playing', CanPlay: true, CanPause: true, CanGoNext: true, CanGoPrevious: true,
    Metadata: {'xesam:title': 'Track', 'xesam:artist': ['Artist'], 'mpris:artUrl': 'file:///tmp/not-loaded.png'}};
services._players = new Map([['player', {proxy: {get_cached_property(name) { return {deepUnpack: () => values[name]}; }}}]]);
const mediaCode = shell.slice(shell.indexOf('    _mediaCard('), shell.indexOf('    _calendar('));
const MediaCard = new Function('Gio', 'card', 'label', 'St', 'Clutter', 'moduleFeatures', `return class {${mediaCode}};`)(
    Gio,
    () => new Actor(), () => new Label(), St, Clutter, () => ({mediaSeek: false}));
const mediaBar = makeBar(); Object.assign(mediaBar, {_button: () => new Button({child: new Icon()}), _wire() {}});
mediaBar._overlay.services = services; mediaBar._mediaCard = MediaCard.prototype._mediaCard;
const media = mediaBar._mediaCard(true);
media.destroy(); assert(services._listeners.size === 0, 'media destruction unsubscribes');
print('PASS media: actor-owned unsubscription');

// Repeated interrupted transitions and late completions cannot lose ownership.
layout = {overview: [[{id: 'media', span: 1}]], media: [[{id: 'media', span: 2}]], performance: [], workspaces: []};
for (let cycle = 0; cycle < 20; cycle++) {
    completions.length = 0;
    const bar = makeBar(); bar._overlay.services = services;
    bar._mediaCard = MediaCard.prototype._mediaCard; bar._button = mediaBar._button; bar._wire = () => {};
    const root = dashboard.buildDashboard(bar); const tabs = root.children[0].children[0].children[0];
    for (let i = 0; i < 12; i++) tabs.children[(i % 3)].emit('clicked');
    for (const cleanup of bar._popupCleanups) cleanup();
    root.destroy();
    for (const complete of completions) complete();
    assert(services._listeners.size === 0 && jobs.size === 0, 'tab interruption/close returns listeners and timers to baseline');
}
print('PASS dashboard: rapid tab changes, close, repeated opens, stale animation completions');

// Borrowed native lists keep exactly one fit listener while hosted.
const controls = [0, 1, 2].map(() => {
    const control = new Actor({checked: true, reactive: true}); const parent = new Actor(); const box = new Actor();
    box.add_child(new Actor()); parent.add_child(box); control.menu = {box, close() {}};
    control._startScanning = () => {}; control._stopScanning = () => {}; return control;
});
const quick = {menu: new Actor(), _volumeOutput: {quickSettingsItems: [controls[0]]},
    _network: {_wirelessToggle: controls[1]}, _bluetooth: {quickSettingsItems: [controls[2]]}};
const {buildDeviceControls} = load('quickControls.js', {St, Clutter, GLib: schedule, switchOn,
    Main: {panel: {statusArea: {quickSettings: quick}}}, PopupAnimation: {NONE: 0}}, 'buildDeviceControls');
const deviceBar = makeBar();
const deviceRoot = buildDeviceControls(deviceBar);
for (let i = 0; i < 100; i++) deviceRoot._selectDeviceTab(i % 3);
assert(controls.reduce((n, control) => n + control.menu.box.count('notify::allocation'), 0) === 1, 'only current tab retains allocation listener');
assert(deviceBar._popupCleanups.length === 1, 'popup cleanup count stays bounded');
for (const cleanup of deviceBar._popupCleanups) cleanup(); deviceRoot.destroy();
assert(controls.every(control => control.menu.box.count('notify::allocation') === 0), 'all list listeners released');
assert(jobs.size === 0, 'pending list fit removed');
print('PASS quick controls: 100 switches, constant listeners/cleanup storage, native list return');

// Every adopted descendant restores its original style and alignment.
const panel = {_leftBox: new Actor(), _centerBox: new Actor(), _rightBox: new Actor(), statusArea: {}};
const top = new Actor({style: 'padding: 3px;'}); top.container = top;
const nested = new BoxLayout({style: 'padding: 4px;'}); const nestedLabel = new Label({style: 'font-size: 11px;'});
const icon = new Icon({style: 'margin: 3px;', icon_size: 16});
top.add_child(nested); nested.add_child(nestedLabel); nested.add_child(icon); panel._rightBox.add_child(top); panel.statusArea.custom = top;
const indicatorBar = {_actor: new Actor({width: 100}), _vertical: false, _theme: theme, _state: {kind: 'panel', iconSize: 24},
    _zones: {end: new Actor()}, _overlay: {_settings: {values: {'indicator-spacing': 8, 'indicator-icon-size': 20, 'indicator-side': 'after',
        'indicator-order': [], 'known-indicators': [], 'hidden-indicators': []}, get_int(key) { return this.values[key]; },
        get_string(key) { return this.values[key]; }, get_strv(key) { return this.values[key]; }, set_strv(key, value) { this.values[key] = value; }}},
    _dragItem: () => () => {}, _place() {}};
const {IndicatorBridge} = load('indicators.js', {St, Clutter, Main: {panel}, Pango: {EllipsizeMode: {END: 1}, Alignment: {CENTER: 1}}, GLib: schedule, global: {stage: {}}}, 'IndicatorBridge');
const originals = [top, nested, nestedLabel, icon].map(actor => [actor, actor.style, actor.x_align, actor.y_align, actor.x_expand, actor.margin_top]);
for (const vertical of [false, true]) {
    indicatorBar._vertical = vertical;
    for (let i = 0; i < 100; i++) {
        const bridge = new IndicatorBridge(indicatorBar); bridge.prepare(top); bridge.destroy();
        for (const [actor, style, x, y, expand, margin] of originals)
            assert(actor.style === style && actor.x_align === x && actor.y_align === y && actor.x_expand === expand && actor.margin_top === margin,
                'indicator descendant properties restore exactly');
    }
}
print('PASS indicators: 200 horizontal/vertical cycles restore nested styles and layout');

const {frameRegions} = load('frame-regions.js', {}, 'frameRegions');
const {DesktopFrame} = load('frame.js', {St, frameRegions, paintFrame() {}}, 'DesktopFrame');
for (const edge of ['left', 'right', 'top', 'bottom']) {
    const frame = new DesktopFrame({x: 0, y: 0, width: 3840, height: 2160}, theme,
        {left: 12, right: 12, top: 12, bottom: 12}, {radius: 28, shadow: 8, bars: [{edge, thickness: 56, autohide: true, kind: 'panel', length: 100}]});
    const created = areaCreations; const destroyed = areaDestructions;
    for (let i = 0; i <= 40; i++) frame.setReveal(0, edge, 56, i <= 20 ? i / 20 : (40 - i) / 20);
    assert(areaCreations === created && areaDestructions === destroyed, 'no surface replacement during reveal or reversal');
    assert(frame.lastDirty.length <= 3, 'only affected edge and corners repaint'); frame.actor.destroy();
}
print('PASS frame: all edges, reveal reversal, zero DrawingArea replacement');

// Late asynchronous completions do not touch discarded actors or add handlers.
const callbacks = []; const proxy = new Actor(); proxy.get_name_owner = () => 'owner';
proxy.get_cached_property = () => ({unpack: () => 'balanced'});
let forceExits = 0; let vpnCallback;
const toolsGio = {Cancellable: Gio.Cancellable, BusType: {SYSTEM: 1}, DBusProxyFlags: {NONE: 0},
    DBusProxy: {new_for_bus(...args) { callbacks.push(args.at(-1)); }, new_for_bus_finish(result) { if (result.error) throw Error('unavailable'); return proxy; }},
    SubprocessFlags: {STDOUT_PIPE: 1}, Subprocess: {new() { return {force_exit() { forceExits++; },
        communicate_utf8_async(_input, _cancel, callback) { vpnCallback = callback; }, communicate_utf8_finish: () => [true, 'test:vpn:--']}; }}};
const tools = load('tools.js', {Gio: toolsGio, GLib, St}, 'performanceMenu, vpnMenu');
for (const fallback of [false, true]) {
    const bar = makeBar(); const box = tools.performanceMenu(bar);
    if (fallback) callbacks.shift()(null, {error: true});
    for (const cleanup of bar._popupCleanups) cleanup(); box.destroy();
    callbacks.shift()(null, {});
    assert(proxy.count('g-properties-changed') === 0 && bar._popupCleanups.length === 1, 'late DBus completion cannot install a listener');
}
const powerBar = makeBar(); const powerBox = tools.performanceMenu(powerBar); callbacks.shift()(null, {});
assert(proxy.count('g-properties-changed') === 1, 'live proxy subscribes normally');
for (const cleanup of powerBar._popupCleanups) cleanup(); powerBox.destroy();
assert(proxy.count('g-properties-changed') === 0, 'live handler removed on close');
const vpnBar = makeBar(); const vpnBox = tools.vpnMenu(vpnBar);
for (const cleanup of vpnBar._popupCleanups) cleanup(); vpnBox.destroy(); vpnCallback(null, {});
assert(forceExits === 1, 'closed VPN request terminates its reader subprocess');
print('PASS async popups: late primary/fallback proxy completion, normal teardown, VPN cancellation');

let profileReads = 0;
const profiles = Array.from({length: 250}, (_, i) => ({name: `Layout ${i + 1}`, values: {example: 'x'.repeat(1000)}}));
assert(nextLayoutName({get_string() { profileReads++; return JSON.stringify(profiles); }}) === 'Layout 251' && profileReads === 1, 'large profile library is parsed once');
assert(nextLayoutName({get_string: () => JSON.stringify([{name: 'Layout 1', values: {}}, {name: 'Layout 3', values: {}}, {name: 'Custom', values: {}}])}) === 'Layout 2', 'gap/custom naming preserved');
print('PASS profiles: one parse at 250 layouts, gaps and custom names');

const overlayCode = shell.slice(shell.indexOf('export class BezelOverlay'), shell.indexOf('class Bar')).replace('export class', 'class');
const settings = new Actor(); settings.get_boolean = () => false;
const main = {layoutManager: new Actor({_startingUp: false}), overview: new Actor(), sessionMode: {isLocked: false, isGreeter: false}};
const Overlay = new Function('Services', 'Weather', 'Main', 'global', 'GLib', 'allowsMotion', 'settingFlag', 'St',
    'AppIconGeometry', 'LayoutTransition',
    `${overlayCode}\nreturn BezelOverlay;`)(class {}, class {}, main, {display: new Actor()}, schedule, () => true, () => false, St,
    class {}, class { run(rebuild) { rebuild(); } cancel() {} });
let rebuilds = 0; Overlay.prototype.rebuild = () => rebuilds++;
const overlay = new Overlay(settings, () => {});
for (const key of ['login-animation-theme', 'login-animation-speed', 'lock-animation', 'unlock-animation']) settings.emit('changed', key);
assert(rebuilds === 1 && jobs.size === 0, 'animation options do not rebuild normal overlay');
settings.emit('changed', 'theme'); advance(); assert(rebuilds === 2, 'normal theme changes still rebuild');
print('PASS settings routing: login options bypass rebuild, desktop theme retains it');
print('PASS: all performance regression checks');
