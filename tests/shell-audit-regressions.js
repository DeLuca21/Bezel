// Actual Shell methods with actor/clock doubles; no desktop settings are touched.
// Run: gjs -m tests/shell-audit-regressions.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {DATE_FORMATS, barDateFormat, barTimeFormat, timePattern} from '../bezel@deluca21/lib/config.js';
const assert = (value, message) => { if (!value) throw new Error(message); };
const lib = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('bezel@deluca21/lib');
const read = name => new TextDecoder().decode(lib.get_child(name).load_contents(null)[1]);
const shell = read('shell.js');
const methods = (start, end, bindings) => new Function(...Object.keys(bindings),
    `return class {${shell.slice(shell.indexOf(start), shell.indexOf(end, shell.indexOf(start)))}};`)(...Object.values(bindings));
let serial = 0, created = 0;
class Actor {
    constructor(props = {}) { created++; this.children = []; this.signals = new Map(); this.clutter_text = {}; Object.assign(this, props); }
    connect(name, callback) { const id = ++serial; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { assert(this.signals.delete(id), 'disconnect only live signal'); }
    emit(name) { for (const record of [...this.signals.values()]) if (record.name === name) record.callback(this); }
    add_child(child) { this.insert_child_at_index(child, this.children.length); }
    insert_child_at_index(child, index) { assert(!child.parent, 'single parent'); this.children.splice(index, 0, child); child.parent = this; }
    get_children() { return [...this.children]; }
    get_child_at_index(i) { return this.children[i]; }
    set_child_at_index(child, index) { this.children.splice(this.children.indexOf(child), 1); this.children.splice(index, 0, child); }
    destroy_all_children() { for (const child of [...this.children]) child.destroy(); }
    destroy() {
        assert(!this.destroyed, 'destroy only live actor'); this.destroyed = true; this.emit('destroy');
        this.destroy_all_children(); this.signals.clear();
        if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    }
    grab_key_focus() {}
}
const St = {BoxLayout: Actor, Button: Actor, Label: Actor, Icon: Actor, Widget: class extends Actor {
    constructor(props) { super(props); this.layout_manager = {attach: child => this.add_child(child)}; }
}};
const Clutter = {ActorAlign: {CENTER: 1, START: 2}, Orientation: {VERTICAL: 1, HORIZONTAL: 2}, GridLayout: class {}};
const system = new Actor();
let running = ['one', 'two'];
system.get_running = () => running.map(id => ({get_id: () => id}));
const Apps = methods('    _apps(size)', '    _app(id, size)', {St, Clutter, Shell: {AppSystem: {get_default: () => system}}});
let icons = 0, places = 0, feedback = 0;
const bar = new Apps();
Object.assign(bar, {_state: {pinned: ['app:one'], runningApps: true}, _content: {}, _signals: [], _box: {},
    _app() { icons++; const button = new Actor(); button._bezelRefreshAppFeedback = () => feedback++; return button; },
    _wire() {}, _dragItem() {}, _place() { places++; }});
const apps = bar._apps(24), original = apps.get_children();
for (let i = 0; i < 100; i++) system.emit('app-state-changed');
assert(icons === 2 && places === 1 && feedback === 200, 'unchanged app events reuse icons without relayout');
running = ['two', 'three']; system.emit('app-state-changed');
assert(icons === 3 && apps.children[0] === original[0] && apps.children[1] === original[1], 'new app preserves existing buttons');
running = ['three']; system.emit('app-state-changed');
assert(original[1].destroyed && !original[0].destroyed && apps.children.length === 2, 'only removed unpinned app is destroyed');
print('PASS apps: 100 unchanged updates reuse actors, feedback refreshes, only changed apps allocate');

let clockReads = 0, clockPlaces = 0;
const jobs = new Map();
const clock = {PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
    timeout_add_seconds(_p, _s, callback) { const id = ++serial; jobs.set(id, callback); return id; },
    source_remove(id) { assert(jobs.delete(id), 'remove only live timer'); },
    DateTime: {new_now_local: () => GLib.DateTime.new_local(2026, 10, 5, 12, 34, 10)},
};
const settings = new Actor(); settings.get_string = () => '24h';
const Clock = methods('    _fillClock(', '    _fillStatusIcons(', {St, GLib: clock,
    Gio: {Settings: class { constructor() { return settings; } }},
    label: (_color, _size) => new Actor(), Pango: {EllipsizeMode: {NONE: 0}}, DATE_FORMATS, barDateFormat, barTimeFormat, timePattern,
    readBars: () => { clockReads++; return [{modules: [], clockSeconds: false}]; }});
const clockBar = new Clock();
Object.assign(clockBar, {_theme: {}, _overlay: {_settings: settings}, _index: 0, _signals: [], _timers: new Set(), _box: {}, _place: () => clockPlaces++});
clockBar._fillClock(new Actor(), new Actor(), ['clock']);
for (let i = 0; i < 100; i++) for (const callback of jobs.values()) callback();
assert(clockReads === 1 && clockPlaces === 1, 'unchanged clock ticks neither reparse configuration nor relayout bars');
for (const id of clockBar._timers) clock.source_remove(id);
print('PASS clock: 100 unchanged ticks parse configuration once and lay out once');

const ContentLayout = methods('    _queueContentLayout()', '    _place(overrides', {});
const contentBar = new ContentLayout();
const pendingLayouts = [];
let sectionSizes = [20, 20, 20], contentPlacements = 0;
Object.assign(contentBar, {_actor: {}, _contentCross: () => 0, _sectionSpans: () => sectionSizes,
    _contentLayoutSize: '[0,20,20,20]',
    _later(key, _delay, callback) {
        this[key] = 1;
        pendingLayouts.push(() => { this[key] = 0; callback(); });
    },
    _place() {
        contentPlacements++;
        this._contentLayoutSize = JSON.stringify([0, ...sectionSizes]);
        this._queueContentLayout(); // Relayout emitted by our own placement.
    },
});
sectionSizes = [20, 20, 90];
for (let i = 0; i < 100; i++) contentBar._queueContentLayout();
assert(pendingLayouts.length === 1, 'late icon events coalesce');
pendingLayouts.shift()();
assert(contentPlacements === 1 && pendingLayouts.length === 0, 'late icons resize the bar without a feedback loop');
contentBar._queueContentLayout(); pendingLayouts.shift()();
assert(contentPlacements === 1, 'unchanged dimensions do not place again');
sectionSizes = [20, 20, 30];
contentBar._queueContentLayout(); pendingLayouts.shift()();
assert(contentPlacements === 2, 'shrinking content also resizes the bar');
contentBar._destroyed = true; contentBar._queueContentLayout();
assert(pendingLayouts.length === 0, 'destroyed bars cannot queue layout work');
print('PASS startup layout: coalesced late sizing, growth/shrink, no feedback loop or work after destruction');

const display = new Actor();
const Focused = methods('    _window(size)', '    _apps(size)', {St, Clutter, Pango: {EllipsizeMode: {END: 0}},
    moduleLook: () => ({value: true, icon: true}), label: () => new Actor(), global: {display},
    Shell: {WindowTracker: {get_default: () => ({get_window_app: () => null})}}});
const first = new Actor(); first.get_title = () => first.title; first.title = 'Before';
const second = new Actor(); second.get_title = () => 'Second';
display.focus_window = first;
const focusBar = new Focused(); Object.assign(focusBar, {_state: {modules: []}, _theme: {}, _signals: [], _hoverDrawer() {}, _hoverFor() { return false; }});
const face = focusBar._window(24);
first.title = 'After'; first.emit('notify::title');
assert(face.accessible_name === 'After', 'focused title changes immediately');
display.focus_window = second; display.emit('notify::focus-window');
assert(first.signals.size === 0 && second.signals.size === 1, 'title watch follows focus');
face.destroy(); assert(second.signals.size === 0, 'title watch released on destruction');
print('PASS focused window: title updates, focus migration, actor-owned cleanup');

const code = read('calendar.js').replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const {monthGrid} = new Function('St', 'Clutter', 'GLib', `${code}\nreturn {monthGrid};`)(St, Clutter, GLib);
const calendar = monthGrid({}, () => {}, {weekNumbers: true});
calendar._dashLayout({width: 272, height: 270});
const allocated = created;
for (let i = 0; i < 100; i++) calendar._dashLayout({width: 272, height: 270});
assert(created === allocated, 'unchanged calendar allocation preserves all date buttons');
const dates = calendar.children[1].children.filter(child => child._bezelDate);
assert(dates.every(child => child.width * 8 <= 272), 'week numbers included in width budget');
calendar.children[0].children[2].emit('clicked');
assert(created > allocated, 'changing month still updates calendar');
calendar.destroy();
print('PASS calendar: repeated layout avoids allocation, week numbers fit, month navigation refreshes');

const overlaySource = shell.slice(shell.indexOf('export class BezelOverlay'), shell.indexOf('class Bar')).replace('export class', 'class');
const scheduled = new Map();
const schedule = {PRIORITY_DEFAULT_IDLE: 0, idle_add(_p, callback) { const id = ++serial; scheduled.set(id, callback); return id; }, source_remove(id) { assert(scheduled.delete(id), 'owned idle removed'); }};
const Overlay = new Function('GLib', 'stopShelfHelper', `${overlaySource}\nreturn BezelOverlay;`)(schedule, () => {});
const overlay = Object.create(Overlay.prototype);
Object.assign(overlay, {_layoutTransition: {cancel() {}}, _clear() {}, appIconGeometry: {destroy() {}}, services: {destroy() {}}, weather: {destroy() {}}});
for (let i = 0; i < 100; i++) overlay.skipRebuild(() => {});
assert(scheduled.size === 1, 'rebuild suppression owns one coalesced idle');
overlay.destroy(); overlay.destroy(); overlay.queueRebuild();
assert(scheduled.size === 0, 'destroy cancels suppression and cannot schedule more work');
print('PASS overlay: coalesced rebuild suppression, idempotent destruction, no post-destroy work');

// App hover timers belong to the button that scheduled them.
Actor.prototype.set_pivot_point = function () {};
Actor.prototype.ease = function () {};
const focusTracker = new Actor();
const Hover = methods('    _app(id, size)', '    _appMenu(', {St: {...St, Settings: {get: () => ({})}},
    Clutter: {...Clutter, BinLayout: class {}, AnimationMode: {EASE_OUT_QUAD: 0}},
    Shell: {AppSystem: {get_default: () => ({lookup_app: () => null})}, WindowTracker: {get_default: () => focusTracker}},
    allowsMotion: () => true, appClickHandler: () => () => {}});
const hoverBar = new Hover();
let hoveredTimer = null;
Object.assign(hoverBar, {_state: {}, _theme: {}, _overlay: {appIconGeometry: {add: () => () => {}}},
    _hoverFor: () => true, _later: (_key, _delay, callback) => { hoveredTimer = callback; },
    _cancel: () => { hoveredTimer = null; }, _closeSoon() {}});
const hovered = hoverBar._app('app:one', 24), other = hoverBar._app('app:two', 24);
hovered.hover = true; hovered.emit('notify::hover');
assert(hoveredTimer, 'hover schedules a drawer');
other.destroy(); assert(hoveredTimer, 'destroying another icon preserves the intended hover');
hovered.destroy(); assert(!hoveredTimer && !hoverBar._appHoverActor && !focusTracker.signals.size, 'destroyed hover anchor removes timer and focus handlers');
print('PASS app hover: only the owning button cancels pending drawer activation');


const GroupClock = methods('    _groupItem(item)', '    _groupFace(', {St, Clutter, GLib: clock,
    Gio: {Settings: class { constructor() { return settings; } }}, moduleFeatures: () => ({}),
    label: () => new Actor(), readBars: () => [{modules: []}], barTimeFormat, timePattern});
const groupClock = new GroupClock();
Object.assign(groupClock, {_overlay: {_settings: settings}, _theme: {}, _index: 0, _popupCleanups: []});
const clockFace = groupClock._groupItem({module: 'clock'});
assert(jobs.size === 1, 'group clock has one live update timer');
clockFace.destroy(); assert(jobs.size === 0, 'tab destruction cancels clock before popup close');
for (const cleanup of groupClock._popupCleanups) cleanup();
print('PASS group clock: timer removed on tab destruction, later popup cleanup is safe');
