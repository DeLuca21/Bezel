// Run from the repository root: gjs -m tests/login-animation.js [--render]
import GLib from 'gi://GLib';
import Cairo from 'cairo';
import {paintLoginFrame, paintFrame} from '../bezel@deluca21/lib/drawing.js';
import {sideWidths} from '../bezel@deluca21/lib/geometry.js';
import {allowsMotion} from '../bezel@deluca21/lib/compat.js';
import {LOGIN_THEMES, THEME_DURATIONS, openingMotion, barMotion, iconMotion} from '../bezel@deluca21/lib/loginMotion.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
let nextId = 1;
const signals = new Map();
const timers = new Map();
const chrome = new Set();
const settings = {enable_animations: true};
let rasterScale = 1;
let monitorScale = 1;
const monitors = [{index: 0, x: 0, y: 0, width: 640, height: 480},
    {index: 1, x: -800, y: 0, width: 800, height: 600}];
class Actor {
    constructor(props = {}) {
        Object.assign(this, {opacity: 255, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
            x: 0, y: 0, width: 22, height: 22, pivot: [0, 0], children: []}, props);
        this.signals = new Map();
        for (const child of this.children) child.parent = this;
    }
    connect(name, callback) { const id = nextId++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(name) { for (const signal of [...this.signals.values()]) if (signal.name === name) signal.callback(this); }
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; }
    get_pivot_point() { return this.pivot; }
    set_pivot_point(x, y) { this.pivot = [x, y]; }
    get_children() { assert(!this.destroyed, 'read of destroyed actor'); return this.children; }
    get_parent() { return this.parent ?? {set_child_below_sibling() {}}; }
    // St reports logical dimensions and supplies a context with device scaling.
    get_surface_size() { return [this.width, this.height]; }
    get_context() {
        const cr = new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.ARGB32, this.width * rasterScale, this.height * rasterScale));
        cr.scale(rasterScale, rasterScale);
        return cr;
    }
    queue_repaint() { this.repaints = (this.repaints ?? 0) + 1; this.emit('repaint'); }
    destroy() { this.emit('destroy'); this.destroyed = true; this.signals.clear(); }
}
class Button extends Actor {}
class Label extends Actor {}
class Icon extends Actor {}
class Timeline extends Actor {
    start() { this.running = true; }
    stop() { this.running = false; }
    get_progress() { return this.progress; }
    tick(progress) {
        this.progress = progress;
        this.emit('new-frame');
        if (progress === 1) this.emit('completed');
    }
}
const layoutManager = {
    monitors,
    _startingUp: true,
    connect(name, callback) { const id = nextId++; signals.set(id, {name, callback}); return id; },
    disconnect(id) { signals.delete(id); },
    addChrome(actor) { chrome.add(actor); }, removeChrome(actor) { chrome.delete(actor); },
};
const [, bytes] = GLib.file_get_contents('bezel@deluca21/lib/loginAnimation.js');
const source = new TextDecoder().decode(bytes).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
// Use real motion curves and Cairo, substituting only Shell lifecycle bindings.
const {LoginAnimation, loginSurfaceSize} = new Function('Clutter', 'GLib', 'St', 'Main', 'Config', 'allowsMotion', 'chromeOptions', 'paintLoginFrame', 'openingMotion', 'barMotion', 'iconMotion', 'THEME_DURATIONS', 'global',
    `${source}\nreturn {LoginAnimation, loginSurfaceSize};`)(
    {Timeline}, {
        get_monotonic_time: () => GLib.get_monotonic_time(),
        timeout_add(_priority, delay, callback) { const id = nextId++; timers.set(id, {delay, callback}); return id; },
        source_remove(id) { timers.delete(id); },
    }, {DrawingArea: Actor, Button, Label, Icon, Settings: {get: () => settings},
        ThemeContext: {get_for_stage: () => ({scale_factor: 1})}}, {layoutManager},
    {PACKAGE_VERSION: '48'}, allowsMotion, () => ({}), paintLoginFrame, openingMotion, barMotion, iconMotion, THEME_DURATIONS,
    {stage: {}, display: {get_monitor_scale: () => monitorScale}});

for (const [width, height] of [[1920, 1080], [1080, 1920], [3840, 2160], [7680, 4320]]) {
    for (const scale of [1, 1.25, 1.5, 2, 3]) {
        const [w, h] = loginSurfaceSize(width, height, scale);
        assert(w * h * Math.ceil(scale) ** 2 <= 1920 * 1080, 'physical login raster is bounded on HiDPI and large displays');
    }
}

function fixture(theme = 'liquid', speed = 100, wait = true, border = true) {
    const bars = monitors.flatMap(monitor => ['left', 'top', 'right', 'bottom'].map(edge => ({
        _actor: new Actor({width: ['left', 'right'].includes(edge) ? 56 : monitor.width,
            height: ['left', 'right'].includes(edge) ? monitor.height : 56,
            children: [new Button(), new Button({opacity: 128})]}),
        _monitor: monitor, _state: {edge, autohide: false},
    })));
    const hidden = {_actor: new Actor({opacity: 0, scale_x: 0}), _monitor: monitors[0], _state: {autohide: true}};
    const frames = new Map(border ? monitors.map(monitor => [monitor.index, {monitor,
        actor: new Actor({opacity: monitor.index === 0 ? 255 : 230}),
        sides: {left: 56, right: 4, top: 4, bottom: 4}}]) : []);
    const animation = new LoginAnimation([...bars, hidden], frames, {bg: '#242424'},
        {radius: 24, shadow: 4, loginAnimationTheme: theme, loginAnimationSpeed: speed}, () => {}, wait);
    const waiting = wait && layoutManager._startingUp;
    assert(chrome.size === 2 && bars[0]._actor.opacity === (waiting ? 255 : 0), 'bars stay visible until reveal starts');
    assert([...chrome].every(actor => actor.opacity === (waiting || ['liquid', 'glide', 'soft-fade'].includes(theme) ? 0 : actor._loginFrame?.opacity ?? 255)), 'liquid first paint and startup wait leave the desktop visible');
    for (const [index, frame] of frames)
        assert(frame.actor.opacity === (!waiting && theme !== 'fade' ? 0 : index === 0 ? 255 : 230), 'static frame waits for the edge reveal');
    return {animation, bars, frames,
        start: (name = 'startup-prepared') => [...signals.values()].find(signal => signal.name === name).callback(),
        restored: () => {
            for (const {_actor: actor} of bars) {
                assert(actor.opacity === 255 && actor.scale_x === 1 && actor.scale_y === 1 && actor.pivot.join() === '0,0', 'bar restored');
                assert(actor.children[0].opacity === 255 && actor.children[1].opacity === 128, 'original content opacity restored');
                for (const item of [actor, ...actor.children]) {
                    assert(item.translation_x === 0 && item.translation_y === 0, 'translations restored');
                    assert(item.scale_x === 1 && item.scale_y === 1 && item.pivot.join() === '0,0', 'content transforms restored');
                    assert(item.signals.size === 0, 'actor destroy handlers removed');
                }
            }
            for (const [index, frame] of frames) {
                assert(frame.actor.opacity === (index === 0 ? 255 : 230), 'original frame opacity restored');
                assert(!frame.actor.signals.size, 'frame destroy handlers removed');
            }
            assert(hidden._actor.opacity === 0 && hidden._actor.scale_x === 0, 'autohide untouched');
            assert(!signals.size && !timers.size && !chrome.size, 'temporary resources removed');
        }};
}
for (const [theme] of LOGIN_THEMES) {
    for (const speed of [25, 100, 200]) {
        for (const border of [true, false]) {
            const test = fixture(theme, speed, false, border);
            const timeline = test.animation._timeline;
            assert(timeline.duration === Math.round(THEME_DURATIONS[theme] * 100 / speed), 'speed applied');
            assert([...timers.values()][0].delay > timeline.duration, 'watchdog permits slow animation');
            for (const p of [0.2, 0.5, 0.8, 1]) timeline.tick(p);
            test.restored();
            test.animation.destroy();
            test.restored();
        }
    }
}
const fade = fixture('fade', 100, false);
const fadeAreas = [...chrome];
for (const p of [0.2, 0.5, 0.8]) fade.animation._timeline.tick(p);
assert(fadeAreas.every(area => area.repaints === 1), 'fade reuses its solid raster while opacity changes');
fade.animation._timeline.tick(1); fade.restored();
const originalMonitors = [...monitors];
monitors.splice(0, monitors.length, {index: 0, x: 0, y: 0, width: 3840, height: 2160},
    {index: 1, x: -2160, y: 0, width: 2160, height: 3840});
rasterScale = 2;
monitorScale = 1.5;
const highDpi = fixture('liquid', 100, false);
for (const area of chrome) {
    const monitor = monitors.find(item => item.x === area.x);
    const [w, h] = area.get_surface_size();
    assert(w * h * rasterScale ** 2 <= 1920 * 1080, 'each physical animation buffer respects the pixel budget');
    assert(Math.abs(area.width * area.scale_x - monitor.width) < 1e-8
        && Math.abs(area.height * area.scale_y - monitor.height) < 1e-8, 'compositor scaling preserves full monitor coverage');
}
highDpi.animation._timeline.tick(0.6); highDpi.animation.destroy(); highDpi.restored();
rasterScale = monitorScale = 1; monitors.splice(0, monitors.length, ...originalMonitors);
for (const started of [false, true]) {
    const test = fixture();
    if (started) { test.start(); test.animation._timeline.tick(0.6); }
    test.animation.destroy();
    test.restored();
}
const reduced = fixture();
settings.enable_animations = false;
reduced.start(); reduced.restored();
settings.enable_animations = true;
const timeout = fixture();
const [id, timer] = [...timers][0];
timers.delete(id); timer.callback(); timeout.restored();
const prepared = fixture();
prepared.start();
assert(prepared.animation._timeline.running && signals.size === 0, 'reveal runs alongside Shell and disconnects both startup signals');
prepared.animation._timeline.tick(1); prepared.restored();
const late = fixture();
late.start('startup-complete');
late.animation._timeline.tick(1); late.restored();
layoutManager._startingUp = false;
const alreadyStarted = fixture();
assert(alreadyStarted.animation._timeline.running, 'completed startup never waits for another signal');
alreadyStarted.animation._timeline.tick(1); alreadyStarted.restored();
layoutManager._startingUp = true;
for (const [width, height] of [[640, 480], [1080, 1920], [3440, 1440]]) {
    const target = {left: 56, top: 4, right: 4, bottom: 4};
    let previous = openingMotion('liquid', 0, width, height, target, 24);
    assert(previous.opacity === 0 && Object.values(previous.edges).every(growth => growth === 0), 'clear first paint');
    for (let i = 1; i <= 100; i++) {
        const motion = openingMotion('liquid', i / 100, width, height, target, 24);
        for (const edge of Object.keys(target)) {
            assert(motion.sides[edge] === target[edge], 'desktop opening stays at its configured position');
            assert(Number.isFinite(motion.edges[edge]) && motion.edges[edge] >= previous.edges[edge] && motion.edges[edge] <= 1, 'edge paint advances continuously without overshoot');
        }
        assert(motion.radius === 24, 'desktop corners remain fixed');
        previous = motion;
    }
    assert(Object.values(previous.edges).every(growth => growth === 1), 'frame reaches every corner');
    assert(openingMotion('liquid', 0.08, width, height, target, 24).edges.left > 0, 'edge painting begins immediately');
}
for (const edge of ['left', 'top', 'right', 'bottom']) {
    const hidden = barMotion('liquid', 0.4, edge);
    assert(hidden.contentOpacity === 0, 'contents wait for bar to form');
    const visible = barMotion('liquid', 0.65, edge);
    assert(visible.x > 0.98 && visible.y > 0.98, 'contents appear after most stretching');
    const end = barMotion('liquid', 1, edge);
    assert(end.x === 1 && end.y === 1 && end.opacity === 1 && end.contentOpacity === 1, 'bar settles exactly');
}
for (const position of [0, 0.25, 0.5, 0.75, 1]) {
    assert(iconMotion(0.44, position).opacity === 0, 'icons wait for the bar');
    const end = iconMotion(1, position);
    assert(end.opacity === 1 && end.scale === 1 && end.across === 0 && end.along === 0, 'icons settle exactly');
    for (let i = 0; i <= 100; i++) {
        const motion = iconMotion(i / 100, position);
        assert(motion.scale >= 0.96 && motion.scale <= 1 && motion.across >= 0, 'icons settle without a bounce and approach from inside');
    }
}
assert(iconMotion(0.61, 0.5).opacity > iconMotion(0.61, 0).opacity, 'icon wave travels from centre to ends');

// Parent bars grow along one axis. Visible glyphs should remain undistorted and
// near their allocated slots in both orientations, rather than riding that scale.
const crisp = fixture('liquid', 100, false);
for (const {_actor: actor, _state: {edge}} of crisp.bars) {
    const vertical = ['left', 'right'].includes(edge);
    actor.children.forEach((icon, index) => {
        icon.x = (vertical ? actor.width / 2 : actor.width * (index ? 0.85 : 0.5)) - icon.width / 2;
        icon.y = (vertical ? actor.height * (index ? 0.85 : 0.5) : actor.height / 2) - icon.height / 2;
    });
}
for (const progress of [0.56, 0.64, 0.76, 0.9]) {
    crisp.animation._timeline.tick(progress);
    for (const {_actor: actor} of crisp.bars) {
        for (const icon of actor.children) {
            const sx = icon.scale_x * actor.scale_x;
            const sy = icon.scale_y * actor.scale_y;
            assert(Math.abs(sx - sy) < 1e-8 && sx >= 0.96 && sx <= 1, 'visible icons retain natural proportions through parent stretch');
            const x = icon.x + icon.width / 2, y = icon.y + icon.height / 2;
            const screenX = actor.width / 2 + (x - actor.width / 2 + icon.translation_x) * actor.scale_x + actor.translation_x;
            const screenY = actor.height / 2 + (y - actor.height / 2 + icon.translation_y) * actor.scale_y + actor.translation_y;
            assert(Math.abs(screenX - x) < 8 && Math.abs(screenY - y) < 8, 'icons remain close to their final slots while arriving');
        }
    }
}
crisp.animation._timeline.tick(1); crisp.restored();

// Replacement app buttons are common as the session finishes starting.
const changing = fixture('liquid', 100, false);
const bar = changing.bars[0]._actor;
const initial = bar.children[0];
initial.destroy();
const glyph = new Icon({opacity: 180});
const replacement = new Button({children: [glyph], opacity: 210, scale_x: 0.95, scale_y: 0.9,
    translation_x: 3, translation_y: -2, pivot: [0.2, 0.3]});
replacement.parent = bar;
bar.children[0] = replacement;
changing.animation._timeline.tick(0.62);
assert(glyph.opacity === 180 && glyph.scale_x === 1, 'button content animates as a single unit');
assert(replacement.opacity > 0 && replacement.opacity < 210, 'replacement apps join the ongoing reveal');
changing.animation.destroy();
assert(replacement.opacity === 210 && replacement.scale_x === 0.95 && replacement.scale_y === 0.9 &&
    replacement.translation_x === 3 && replacement.translation_y === -2 && replacement.pivot.join() === '0.2,0.3', 'custom transforms restored on cancellation');
assert(!replacement.signals.size && !signals.size && !timers.size && !chrome.size, 'replacement cleanup removes handlers');

for (const edge of ['left', 'right', 'top', 'bottom']) {
    const test = fixture('liquid', 100, false);
    test.animation._timeline.tick(0.25);
    const actor = test.bars.find(item => item._state.edge === edge)._actor;
    const offset = ['left', 'right'].includes(edge) ? actor.translation_x : actor.translation_y;
    assert(['right', 'bottom'].includes(edge) ? offset < 0 : offset > 0, 'each bar approaches its edge from the desktop');
    test.animation._timeline.tick(1); test.restored();
}

const target = {left: 56, top: 4, right: 4, bottom: 4};
for (const [theme] of LOGIN_THEMES) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
        const end = barMotion(theme, 1, edge);
        assert(end.contentOpacity === 1 && end.opacity === 1 && end.x === 1 && end.y === 1, `${theme}: contents settle exactly`);
    }
}

// The reveal must meet the real desktop frame exactly before handing it back.
const renderDirectory = GLib.dir_make_tmp('bezel-login-check-XXXXXX');
for (const [name, painter] of [['liquid', cr => paintLoginFrame(cr, 640, 480,
    openingMotion('liquid', 1, 640, 480, target, 24), '#242424', 4)],
['frame', cr => paintFrame(cr, 640, 480, target, 24, '#242424', 4)]]) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 640, 480);
    const cr = new Cairo.Context(surface); painter(cr); cr.$dispose();
    surface.writeToPNG(`${renderDirectory}/${name}.png`);
}
const [, liquidPixels] = GLib.file_get_contents(`${renderDirectory}/liquid.png`);
const [, framePixels] = GLib.file_get_contents(`${renderDirectory}/frame.png`);
assert(liquidPixels.length === framePixels.length && liquidPixels.every((value, index) => value === framePixels[index]), 'final liquid paint matches the static frame pixel for pixel');
GLib.unlink(`${renderDirectory}/liquid.png`); GLib.unlink(`${renderDirectory}/frame.png`); GLib.rmdir(renderDirectory);
print('PASS: themes, speeds, lifecycle, clear first paint, edge reveal, crisp icons, dynamic apps and exact frame restoration');

// Exhaust every edge subset, including a frame without bars, with full panels,
// partial panels, docks, floating panels, autohide and a mixture of these.
const edges = ['left', 'top', 'right', 'bottom'];
const variants = [
    {kind: 'panel', margin: 0, length: 100},
    {kind: 'panel', margin: 0, length: 60},
    {kind: 'dock', margin: 12, length: 100},
    {kind: 'panel', margin: 16, length: 75},
    {kind: 'panel', margin: 0, length: 100, autohide: true},
];
const actorState = actor => [actor.opacity, actor.scale_x, actor.scale_y,
    actor.translation_x, actor.translation_y, ...actor.get_pivot_point()];
const walk = actor => [actor, ...actor.get_children().flatMap(walk)];
const screenCenter = actor => {
    let x = actor.width / 2, y = actor.height / 2;
    for (let node = actor; node instanceof Actor; node = node.parent) {
        const [px, py] = node.get_pivot_point();
        x = node.x + node.translation_x + px * node.width + (x - px * node.width) * node.scale_x;
        y = node.y + node.translation_y + py * node.height + (y - py * node.height) * node.scale_y;
    }
    return [x, y];
};
const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-7);
const matrixMonitors = [...monitors];
monitors.splice(0, monitors.length, {index: 0, x: -384, y: 80, width: 384, height: 256},
    {index: 1, x: 0, y: -128, width: 256, height: 384});
let combinations = 0;
for (const [theme] of LOGIN_THEMES) {
    for (let mask = 0; mask < 16; mask++) {
        for (let variant = 0; variant <= variants.length; variant++) {
            for (const border of [false, true]) {
                const label = `${theme}, edges=${mask}, variant=${variant}, border=${border}`;
                const states = edges.filter((_edge, i) => mask & (1 << i)).map((edge, i) => ({edge, thickness: 32,
                    ...variants[variant === variants.length ? i % variants.length : variant]}));
                const bars = monitors.flatMap(physical => states.map((state, i) => {
                    const monitor = {...physical, y: physical.y + 24, height: physical.height - 24};
                    const vertical = ['left', 'right'].includes(state.edge);
                    const length = (vertical ? monitor.height : monitor.width) * (state.kind === 'dock' ? .5 : state.length / 100);
                    const width = vertical ? 32 : length, height = vertical ? length : 32;
                    const icons = [0.12, 0.5, 0.88].map(position => new Button({
                        x: vertical ? 4 : width * position - 10, y: vertical ? height * position - 10 : 4,
                        width: 20, height: 20, opacity: 190, scale_x: .9, scale_y: 1.1,
                        translation_x: 2, translation_y: -1, pivot: [.2, .7], children: [new Icon()]}));
                    // Nested groups exercise coordinate conversion and preserve native transforms.
                    const group = new Actor({children: icons, width, height, x: 3, y: 5,
                        translation_x: 1, scale_x: .95, scale_y: 1.05, pivot: [.3, .6]});
                    return {_monitor: monitor, _state: state,
                        _actor: new Actor({width, height, x: monitor.x + state.margin + i * 2,
                            y: monitor.y + state.margin + i * 3, children: [group],
                            scale_x: state.autohide ? 0 : .92, scale_y: 1.04,
                            opacity: state.autohide ? 0 : 220, translation_x: 3, translation_y: -2, pivot: [.1, .8]})};
                }));
                const frames = new Map(border ? monitors.map(monitor => [monitor.index, {
                    monitor: {...monitor, y: monitor.y + 24, height: monitor.height - 24},
                    actor: new Actor({opacity: 230}),
                    sides: sideWidths({border, borderWidth: 4, bars: states}),
                }]) : []);
                const actors = [...bars.flatMap(bar => walk(bar._actor)), ...[...frames.values()].map(frame => frame.actor)];
                const originals = new Map(actors.map(actor => [actor, actorState(actor)]));
                const centers = new Map(actors.map(actor => [actor, screenCenter(actor)]));
                const animation = new LoginAnimation(bars, frames, {bg: '#242424'},
                    {radius: 16, shadow: 4, loginAnimationTheme: theme}, undefined, false);
                for (const area of chrome) {
                    const first = bars.find(bar => bar._monitor.index === monitors.find(m => m.x === area.x)?.index);
                    if (first) assert(area.y === first._monitor.y && area.height === first._monitor.height, `${label}: usable monitor inset`);
                }
                for (const progress of [.25, .56, .72, 1]) {
                    animation._paint(progress);
                    for (const bar of bars) {
                        for (const actor of walk(bar._actor)) assert(actorState(actor).every(Number.isFinite), `${label}: finite transforms`);
                        if (bar._state.autohide) {
                            for (const actor of walk(bar._actor)) assert(close(actorState(actor), originals.get(actor)), `${label}: autohide untouched`);
                            continue;
                        }
                        for (const icon of bar._actor.children[0].children) {
                            const old = originals.get(icon), oldBar = originals.get(bar._actor);
                            const ratioX = icon.scale_x * bar._actor.scale_x / (old[1] * oldBar[1]);
                            const ratioY = icon.scale_y * bar._actor.scale_y / (old[2] * oldBar[2]);
                            assert(Math.abs(ratioX - ratioY) < 1e-7, `${label}: no icon distortion`);
                            if (progress === 1 || theme === 'soft-fade')
                                assert(close(screenCenter(icon), centers.get(icon)), `${label}: no position jump at handoff`);
                        }
                    }
                }
                animation.destroy();
                for (const actor of actors) {
                    assert(close(actorState(actor), originals.get(actor)), `${label}: exact restoration`);
                    assert(actor.signals.size === 0, `${label}: no actor handlers leaked`);
                }
                assert(!signals.size && !timers.size && !chrome.size, `${label}: no resources leaked`);
                combinations++;
            }
        }
    }
}
monitors.splice(0, monitors.length, ...matrixMonitors);
print(`PASS: ${combinations} theme/layout combinations across landscape and portrait monitors, including every edge subset`);

for (const [theme] of LOGIN_THEMES) {
    const test = fixture(theme);
    const actor = test.bars[0]._actor;
    actor.opacity = 177;
    actor.translation_x = 4;
    test.animation.destroy();
    assert(actor.opacity === 177 && actor.translation_x === 4, `${theme}: waiting cancellation preserves live changes`);
    assert(!signals.size && !timers.size && !chrome.size, `${theme}: waiting cancellation releases resources`);

    const reducedDuring = fixture(theme, 100, false);
    settings.enable_animations = false;
    reducedDuring.animation._timeline.tick(.3);
    reducedDuring.restored();
    settings.enable_animations = true;

    const replacing = fixture(theme, 100, false);
    const parent = replacing.bars[0]._actor;
    const removed = parent.children.shift(); removed.parent = null;
    const replacement = new Button({opacity: 211}); replacement.parent = parent;
    parent.children.push(replacement);
    replacing.animation._paint(.6);
    assert(removed.opacity === 255 && removed.signals.size === 0, `${theme}: reparented content released`);
    replacing.animation.destroy();
    assert(replacement.opacity === 211 && replacement.signals.size === 0, `${theme}: replacement restored`);
    assert(!signals.size && !timers.size && !chrome.size, `${theme}: replacement cleanup`);
}

// Actor destruction and changing frame geometry must be safe mid-transition.
for (const [theme] of LOGIN_THEMES) {
    const test = fixture(theme, 100, false);
    test.bars[0]._actor.destroy();
    test.animation._paint(.5);
    test.animation.destroy();
    assert(!signals.size && !timers.size && !chrome.size, `${theme}: destroyed bar cleanup`);
}
for (const theme of ['glide', 'soft-fade']) {
    const test = fixture(theme, 100, false);
    const area = [...chrome][0];
    test.animation._paint(.3);
    assert(area.repaints === 1, `${theme}: stable frame uses a single raster`);
    test.frames.get(0).sides.left += 20;
    test.animation._paint(.4);
    assert(area.repaints === 2, `${theme}: autohide geometry invalidates cached raster`);
    test.frames.get(0).notification = {corner: 'top-right', width: 180, height: 80, progress: 1};
    test.animation._paint(.5);
    assert(area.repaints === 3, `${theme}: notification invalidates cached raster`);
    test.animation.destroy(); test.restored();
}

// Compare the completed reveal with a static Cairo frame for every non-cover
// style, edge combination, and drawer/notification attachment.
const compareDirectory = GLib.dir_make_tmp('bezel-motion-pixels-XXXXXX');
let comparisons = 0;
for (const [theme] of LOGIN_THEMES.filter(([id]) => id !== 'fade')) {
    for (let mask = 0; mask < 16; mask++) {
        const sides = Object.fromEntries(edges.map((edge, i) => [edge, mask & (1 << i) ? 30 : 4]));
        for (const attachment of [null, ...edges, 'top-left', 'top-right', 'bottom-left', 'bottom-right']) {
            const corner = attachment?.includes('-');
            const attached = attachment && {x: 50, y: 50, width: 60, height: 55, progress: 1,
                edge: corner ? attachment.split('-')[0] : attachment, ...(corner ? {corner: attachment} : {})};
            const popup = corner ? null : attached, notification = corner ? attached : null;
            for (const name of ['actual', 'reference']) {
                const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 240, 180);
                const cr = new Cairo.Context(surface);
                if (name === 'actual') paintLoginFrame(cr, 240, 180, openingMotion(theme, 1, 240, 180, sides, 16), '#242424', 4, popup, notification);
                else paintFrame(cr, 240, 180, sides, 16, '#242424', 4, popup, notification);
                cr.$dispose(); surface.writeToPNG(`${compareDirectory}/${name}.png`);
            }
            const [, a] = GLib.file_get_contents(`${compareDirectory}/actual.png`);
            const [, b] = GLib.file_get_contents(`${compareDirectory}/reference.png`);
            assert(a.length === b.length && a.every((value, i) => value === b[i]), `${theme}, ${mask}, ${attachment}: exact frame handoff`);
            comparisons++;
        }
    }
}
for (const name of ['actual', 'reference']) GLib.unlink(`${compareDirectory}/${name}.png`);
GLib.rmdir(compareDirectory);
print(`PASS: ${comparisons} pixel-exact frame handoffs, all styles, edge combinations, drawers and notification corners`);

if (ARGV.includes('--render-themes')) {
    const width = 400, height = 240;
    const sheet = new Cairo.ImageSurface(Cairo.Format.ARGB32, width * 4, (height + 28) * LOGIN_THEMES.length);
    const cr = new Cairo.Context(sheet);
    for (const [row, [theme, name]] of LOGIN_THEMES.entries()) {
        for (const [col, progress] of [0.2, 0.4, 0.65, 1].entries()) {
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
            const context = new Cairo.Context(surface);
            const motion = openingMotion(theme, progress, width, height, {left: 28, top: 4, right: 4, bottom: 4}, 16);
            paintLoginFrame(context, width, height, motion, '#242424', 4);
            context.$dispose();
            cr.save(); cr.translate(col * width, row * (height + 28));
            cr.setSourceRGB(0.16, 0.58, 0.61); cr.rectangle(0, 0, width, height); cr.fill();
            cr.setSourceSurface(surface, 0, 0); cr.paintWithAlpha(motion.opacity);
            cr.setSourceRGB(1, 1, 1); cr.setFontSize(15); cr.moveTo(12, height + 20);
            cr.showText(`${name} ${Math.round(progress * 100)}%`); cr.restore();
        }
    }
    sheet.writeToPNG('/tmp/bezel-themes-preview.png'); cr.$dispose();
}

if (ARGV.includes('--render')) {
    const width = 480, height = 270;
    const sheet = new Cairo.ImageSurface(Cairo.Format.ARGB32, width * 4, (height + 28) * 2);
    const cr = new Cairo.Context(sheet);
    for (const [index, progress] of [0.12, 0.25, 0.38, 0.5, 0.62, 0.74, 0.84, 1].entries()) {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        const context = new Cairo.Context(surface);
        const motion = openingMotion('liquid', progress, width, height, {left: 28, top: 4, right: 4, bottom: 4}, 16);
        paintLoginFrame(context, width, height, motion, '#242424', 4);
        context.$dispose();
        cr.save(); cr.translate((index % 4) * width, Math.floor(index / 4) * (height + 28));
        cr.setSourceRGB(0.16, 0.58, 0.61); cr.rectangle(0, 0, width, height); cr.fill();
        cr.setSourceSurface(surface, 0, 0); cr.paintWithAlpha(motion.opacity);
        cr.setSourceRGB(1, 1, 1); cr.setFontSize(15); cr.moveTo(12, height + 20);
        cr.showText(`${Math.round(progress * 100)}%`); cr.restore();
    }
    sheet.writeToPNG('/tmp/bezel-liquid-preview.png'); cr.$dispose();
}

// A motion preview using the real Cairo frame painter and motion curves. The glyphs
// stand in for app icons; the rail and floating dock exercise both orientations.
if (ARGV.includes('--render-motion')) {
    const width = 960, height = 540;
    const directory = '/tmp/bezel-edge-frames';
    GLib.mkdir_with_parents(directory, 0o755);
    const rounded = (cr, w, h, r) => {
        cr.newPath();
        cr.moveTo(r, 0); cr.lineTo(w - r, 0); cr.arc(w - r, r, r, -Math.PI / 2, 0);
        cr.lineTo(w, h - r); cr.arc(w - r, h - r, r, 0, Math.PI / 2);
        cr.lineTo(r, h); cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(0, r); cr.arc(r, r, r, Math.PI, Math.PI * 1.5); cr.closePath();
    };
    const glyph = (cr, index) => {
        cr.setLineWidth(2); cr.setLineCap(Cairo.LineCap.ROUND); cr.setLineJoin(Cairo.LineJoin.ROUND);
        if (index % 5 === 0) {
            for (const x of [-8, 2]) for (const y of [-8, 2]) { cr.rectangle(x, y, 6, 6); cr.fill(); }
        } else if (index % 5 === 1) {
            cr.arc(0, 0, 9, 0, Math.PI * 2); cr.stroke();
            cr.moveTo(-9, 0); cr.lineTo(9, 0); cr.stroke();
            cr.save(); cr.scale(0.45, 1); cr.arc(0, 0, 9, 0, Math.PI * 2); cr.stroke(); cr.restore();
        } else if (index % 5 === 2) {
            cr.moveTo(-9, -5); cr.lineTo(-3, -5); cr.lineTo(-1, -2); cr.lineTo(9, -2);
            cr.lineTo(9, 8); cr.lineTo(-9, 8); cr.closePath(); cr.stroke();
        } else if (index % 5 === 3) {
            cr.moveTo(-8, -6); cr.lineTo(-2, 0); cr.lineTo(-8, 6); cr.stroke();
            cr.moveTo(1, 6); cr.lineTo(8, 6); cr.stroke();
        } else {
            cr.arc(0, 1, 8, -Math.PI * 0.28, Math.PI * 1.28); cr.stroke();
            cr.moveTo(0, -10); cr.lineTo(0, -1); cr.stroke();
        }
    };
    const drawBar = (cr, progress, edge, x, y, w, h, positions, round) => {
        const vertical = edge === 'left';
        const motion = barMotion('liquid', progress, edge);
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
        const context = new Cairo.Context(surface);
        context.setSourceRGB(0.14, 0.14, 0.14); rounded(context, w, h, round); context.fill();
        positions.forEach((position, index) => {
            const arrival = iconMotion(progress, position);
            if (arrival.opacity === 0) return;
            const centerX = vertical ? w / 2 : w * position;
            const centerY = vertical ? h * position : h / 2;
            const across = (vertical ? 1 : -1) * 5.5 * arrival.across;
            const along = 5.5 * arrival.along;
            context.save();
            context.translate(centerX + (centerX - w / 2) * (1 / motion.x - 1) + (vertical ? across : along) / motion.x,
                centerY + (centerY - h / 2) * (1 / motion.y - 1) + (vertical ? along : across) / motion.y);
            context.scale(arrival.scale / motion.x, arrival.scale / motion.y);
            context.setSourceRGBA(0.9, 0.92, 0.94, arrival.opacity);
            glyph(context, index); context.restore();
        });
        context.$dispose();
        cr.save();
        cr.translate(x + w / 2 + (vertical ? 4.32 * motion.offset : 0),
            y + h / 2 - (vertical ? 0 : 4.32 * motion.offset));
        cr.scale(motion.x, motion.y); cr.translate(-w / 2, -h / 2);
        cr.setSourceSurface(surface, 0, 0); cr.paintWithAlpha(motion.opacity); cr.restore();
    };
    for (let index = 0; index < 56; index++) {
        const progress = index / 55;
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 720, 405);
        const cr = new Cairo.Context(surface);
        cr.scale(0.75, 0.75);
        const background = new Cairo.LinearGradient(0, 0, width, height);
        background.addColorStopRGB(0, 0.12, 0.32, 0.38);
        background.addColorStopRGB(0.5, 0.16, 0.5, 0.54);
        background.addColorStopRGB(1, 0.32, 0.3, 0.48);
        cr.setSource(background); cr.paint();
        cr.moveTo(0, 400); cr.curveTo(320, 180, 460, 540, 960, 270);
        cr.lineTo(960, 540); cr.lineTo(0, 540); cr.closePath();
        cr.setSourceRGBA(0.05, 0.14, 0.23, 0.28); cr.fill();
        const frame = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        const context = new Cairo.Context(frame);
        const opening = openingMotion('liquid', progress, width, height, {left: 56, right: 4, top: 4, bottom: 4}, 24);
        paintLoginFrame(context, width, height, opening, '#242424', 4);
        context.$dispose();
        cr.setSourceSurface(frame, 0, 0); cr.paintWithAlpha(opening.opacity);
        drawBar(cr, progress, 'left', 0, 0, 56, height, [0.07, 0.25, 0.35, 0.45, 0.55, 0.65, 0.8, 0.94], 0);
        drawBar(cr, progress, 'bottom', 348, 474, 300, 52, [0.1, 0.26, 0.42, 0.58, 0.74, 0.9], 18);
        surface.writeToPNG(`${directory}/${String(index).padStart(3, '0')}.png`);
        cr.$dispose();
    }
    print(`Rendered 56 liquid motion frames to ${directory}`);
}
