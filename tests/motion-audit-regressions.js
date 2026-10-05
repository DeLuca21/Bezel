// Run: gjs -m tests/motion-audit-regressions.js
import Gio from 'gi://Gio';
import {notificationJoinsFrame} from '../bezel@deluca21/lib/frame-regions.js';
import * as motion from '../bezel@deluca21/lib/layoutMotion.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('bezel@deluca21/lib');
const load = (name, bindings, result) => new Function(...Object.keys(bindings),
    new TextDecoder().decode(root.get_child(name).load_contents(null)[1])
        .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '') + `\nreturn ${result};`)(...Object.values(bindings));

// Side drawers reveal horizontally across their complete height; bottom/right
// drawers remain anchored at the far edge throughout their reveal.
const opening = {w: 1000, h: 800, sides: {left: 0, top: 0, right: 0, bottom: 0}};
for (const edge of ['left', 'right']) {
    const drawer = {edge, x: edge === 'left' ? 0 : 700, y: 0, width: 300, height: 800, progress: .2};
    const corner = {corner: `bottom-${edge}`, edge: 'bottom', width: 100, height: 100, progress: 1};
    assert(!notificationJoinsFrame(drawer, corner, opening), `${edge}: full-height visible drawer conflicts with bottom banner`);
    assert(notificationJoinsFrame({...drawer, progress: 0}, corner, opening), `${edge}: closed drawer does not conflict`);
}
for (const edge of ['top', 'bottom']) {
    const drawer = {edge, x: 0, y: edge === 'top' ? 0 : 300, width: 1000, height: 500, progress: .1};
    const corner = {corner: `${edge}-right`, edge, width: 100, height: 100, progress: 1};
    assert(!notificationJoinsFrame(drawer, corner, opening), `${edge}: visible anchored drawer conflicts`);
    const other = edge === 'top' ? 'bottom' : 'top';
    assert(notificationJoinsFrame(drawer, {...corner, edge: other, corner: `${other}-right`}, opening), `${edge}: opposite banner remains independent`);
}
print('PASS joined notifications: correct animated bounds on all four drawer edges');

let nextSignal = 0;
class Actor {
    constructor(props = {}) { Object.assign(this, {opacity: 255, visible: true, mapped: true, width: 20, height: 20,
        x: 10, y: 10, translation_x: 0, translation_y: 0, clip_to_allocation: false, signals: new Map(), children: []}, props); }
    connect(name, callback) { const id = ++nextSignal; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { assert(this.signals.delete(id), 'disconnect an owned signal'); }
    get_stage() { assert(!this.destroyed, 'no access to destroyed actors'); return stage; }
    get_parent() { return this.parent ?? stage; }
    get_transformed_position() { return [this.x, this.y]; }
    get_transformed_size() { return [this.width, this.height]; }
    has_clip() { return Boolean(this.clip); }
    get_clip() { return [...this.clip]; }
    set_clip(...clip) { this.clip = clip; }
    remove_clip() { this.clip = null; }
    show() { this.visible = true; }
    add_child(actor) { this.children.push(actor); actor.parent = this; }
    queue_repaint() { this.paints = (this.paints ?? 0) + 1; }
}
const stage = new Actor();
let rectangles = 0, queries = 0, writes = 0;
const AppIconGeometry = load('appIconGeometry.js', {global: {stage}, Mtk: {Rectangle: class { constructor(rect) { rectangles++; Object.assign(this, rect); } }}}, 'AppIconGeometry');
const window = new Actor();
window.get_monitor = () => 0;
window.get_icon_geometry = () => [Boolean(window.geometry), window.geometry];
window.set_icon_geometry = rect => { writes++; window.geometry = rect; };
const app = {get_windows() { queries++; return [window]; }};
const monitor = {index: 0, x: 0, y: 0, width: 1000, height: 800};
const bar = {_monitor: monitor};
const tracker = new AppIconGeometry();
const buttons = [new Actor(), new Actor({x: 100})];
const select = buttons.map(button => tracker.add(button, app, bar));
for (let i = 0; i < 100; i++) tracker.sync();
assert(queries === 100, 'duplicate app icons share one window query per stage paint');
assert(rectangles === 1 && writes === 1, 'unchanged paints allocate no boxed geometry and do not rewrite it');
select[1]();
assert(window.geometry.x === 100, 'clicked duplicate becomes the preferred destination');
tracker.destroy(); tracker.destroy();
assert(buttons.every(button => !button.signals.size), 'tracker disposal disconnects button hooks before buttons die');
assert(!stage.signals.size && !window.signals.size, 'tracker disposal disconnects stage/window hooks');
select[0]();
assert(!tracker.preferred.size, 'late click callback cannot retain an entry after disposal');
print('PASS app icon geometry: duplicate query batching, boxed allocation caching, complete disposal');

const Settings = {get: () => ({})};
let allowed = true;
const Main = {overview: {visible: false}};
const LayoutTransition = load('layoutTransition.js', {Clutter: {}, St: {Settings}, Main, allowsMotion: () => allowed,
    global: {display: {get_monitor_in_fullscreen: () => false}}, ...motion}, 'LayoutTransition');
let resumed = 0, stopped = 0;
const actor = new Actor(); actor.set_clip(1, 2, 3, 4);
const autohide = {_actor: actor, _box: {x: 10, y: 10, width: 20, height: 20}, _monitor: monitor,
    _state: {edge: 'left'}, _shown: false, _revealTimeline: {stop() { stopped++; }},
    _slide(show, animate) { assert(!show && animate, 'resume captured autohide destination'); resumed++; }};
const overlay = {_bars: [autohide], _frames: new Map(), _settings: {get_string: () => 'retreat', get_int: () => 300}};
const transition = new LayoutTransition(overlay);
transition._items = transition._capture();
actor.set_clip(9, 9, 9, 9); actor.translation_x = -100; actor.opacity = 10;
transition.cancel();
assert(JSON.stringify(actor.clip) === '[1,2,3,4]' && actor.opacity === 255 && actor.translation_x === 0,
    'cancellation restores pre-existing clip and visual state');
assert(stopped === 1 && resumed === 1, 'interrupted autohide resumes to its destination');
transition._items = transition._capture(); actor.destroyed = true;
transition.cancel();
assert(resumed === 1, 'destroyed bars are not resumed');
allowed = false;
let rebuilds = 0;
transition.run(() => rebuilds++);
assert(rebuilds === 1 && !transition._timeline, 'reduced motion rebuilds immediately');
print('PASS layout transition: clip restoration, autohide interruption, destroyed actors, reduced motion');

let subscriber, ratio = .5;
const services = {subscribe(callback) { subscriber = callback; callback(); return () => { subscriber = null; }; }};
const edgeLevel = load('sidebar.js', {Clutter: {Orientation: {VERTICAL: 0}, ActorAlign: {CENTER: 0}},
    St: {BoxLayout: Actor, Icon: Actor, Label: Actor, DrawingArea: Actor},
    clamp: (value, low, high) => Math.max(low, Math.min(high, value))}, 'edgeLevel');
const column = edgeLevel({_theme: {}, _overlay: {services}}, 'volume', () => ratio, () => {}, () => 'volume');
const track = column.children[2];
for (let i = 0; i < 100; i++) subscriber();
assert(track.paints === 1, 'unrelated service updates reuse the meter raster');
ratio = .6; subscriber();
assert(track.paints === 2, 'volume change repaints the meter');
print('PASS edge meters: unrelated service updates do not repaint');
