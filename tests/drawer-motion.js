// Actual Shell transition methods with a controlled clock and actor geometry.
// Run: gjs -m tests/drawer-motion.js
import GLib from 'gi://GLib';
import {allowsMotion} from '../bezel@deluca21/lib/compat.js';
const assert = (value, message) => { if (!value) throw new Error(message); };
const [, bytes] = GLib.file_get_contents('bezel@deluca21/lib/shell.js');
const source = new TextDecoder().decode(bytes);
const fragment = (start, end) => source.slice(source.indexOf(`    ${start}(`), source.indexOf(`    ${end}(`));
class Actor {
    constructor() { Object.assign(this, {width: 240, height: 180, opacity: 255, scale_x: 1, scale_y: 1}); }
    get_stage() { return true; }
    set_clip(...clip) { this.clip = clip; }
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; }
    set_pivot_point(x, y) { this.pivot = [x, y]; }
    show() {}
    ease(props) { this.transition = props; }
    remove_all_transitions() { this.transition = null; }
    remove_transition(name) { this.removed = name; this.transition = null; }
}
class Timeline {
    constructor(props) { Object.assign(this, props); this.signals = new Map(); }
    connect(name, callback) { this.signals.set(name, callback); }
    set_progress_mode() {}
    start() { this.running = true; }
    stop() { this.running = false; }
    get_progress() { return this.progress; }
    tick(progress) { this.progress = progress; this.signals.get('new-frame')(); if (progress === 1) this.signals.get('completed')(); }
}
const settings = {enable_animations: true};
const methods = [fragment('_slide', '_slideLater'), fragment('_animatePopup', '_close'),
    fragment('_clipPopup', '_applyPopupJoin'), fragment('_setPopupHeight', '_menuPopup')].join('\n');
const Bar = new Function('Clutter', 'St', 'allowsMotion', `return class {${methods}};`)(
    {Timeline, AnimationMode: {EASE_OUT_EXPO: 1, EASE_OUT_CUBIC: 2}},
    {Settings: {get: () => settings}, ReducedMotion: {REDUCE: 1}}, allowsMotion);
const make = (edge, joined) => Object.assign(new Bar(), {
    _actor: new Actor(), _popout: new Actor(), _vertical: ['left', 'right'].includes(edge),
    _monitor: {index: 1, x: -800, y: 64, width: 800, height: 600}, _box: {width: 56, height: 56},
    _state: {edge, animationDuration: 320, radius: 24}, _joinedAutohide: joined, _revealProgress: 0,
    _popupEdge: edge, _popupProgress: 0, _popupGeometry: {x: -700, y: 120, width: 240, height: 180, edge},
    _popupFrame: {setPopup(value) { this.value = value; }},
    _overlay: {_frames: new Map([[1, {setReveal(...args) { this.reveal = args; }}]]), relayoutPopups() {}},
    _cancel() {}, _fitPopup() {}, _applyPopupJoin() {}, _placePopup() {},
    _opening: () => ({left: 4, top: 4, right: 4, bottom: 4}), _popupScrolls: () => false,
});
let checks = 0;
for (const edge of ['left', 'right', 'top', 'bottom']) {
    for (const joined of [false, true]) {
        const bar = make(edge, joined);
        bar._slide(true, true);
        if (joined) {
            const first = bar._revealTimeline; first.tick(.4);
            bar._slide(false, true);
            assert(!first.running, 'reversal stops old timeline');
            bar._revealTimeline.tick(.5);
            assert(Math.abs(bar._revealProgress - .2) < 1e-8, 'reversal continues from current progress');
        }
        bar._slide(false, false);
        assert(bar._actor.opacity === 0 && !bar._revealTimeline, 'instant close clears timeline');
        bar._state.animationDuration = 0;
        bar._slide(true, true);
        assert(bar._actor.opacity === 255 && !bar._revealTimeline && !bar._actor.transition, 'zero duration disables every bar transition');
        bar._state.animationDuration = 320;
        settings.reduced_motion = 1; bar._slide(false, true);
        assert(bar._actor.opacity === 0 && !bar._revealTimeline && !bar._actor.transition, 'reduced motion disables every bar transition');
        delete settings.reduced_motion;
        checks++;
    }
    for (const attach of [false, true]) {
        const bar = make(edge, true);
        if (!attach) bar._popupFrame = null;
        bar._animatePopup(1); const first = bar._popupTimeline; first.tick(.4);
        bar._animatePopup(0); assert(!first.running, 'drawer reversal stops old timeline');
        bar._popupTimeline.tick(.5);
        const [x, y, w, h] = bar._popout.clip;
        assert(w >= 0 && h >= 0 && x >= 0 && y >= 0 && x + w <= 240 && y + h <= 180, 'drawer clip remains inside its allocation');
        if (edge === 'right') assert(Math.abs(x + w - 240) < 1e-8, 'right drawer anchored at right');
        if (edge === 'bottom') assert(Math.abs(y + h - 180) < 1e-8, 'bottom drawer anchored at bottom');
        settings.enable_animations = false;
        bar._animatePopup(1);
        assert(bar._popupProgress === 1 && !bar._popupTimeline, 'reduced motion completes reversal immediately');
        bar._animatePopup(0);
        assert(!bar._popupFrame?.value && !bar._popupTimeline, 'instant close removes frame indentation');
        settings.enable_animations = true;
        checks++;
    }
    const launcher = make(edge, false); launcher._popoutId = 'launcher'; launcher._popupProgress = 1;
    let plateHeight = 0;
    launcher._popupPlate = {_bezelSyncPlate() { plateHeight = launcher._popout.height; }};
    launcher._setPopupHeight(220);
    assert(launcher._popout.height === 220 && plateHeight === 220 && !launcher._popout.transition,
        'launcher and backdrop resize together immediately');
    launcher._popout.ease({height: 240});
    settings.reduced_motion = 1;
    launcher._setPopupHeight(260);
    assert(launcher._popout.height === 260 && plateHeight === 260 && !launcher._popout.transition && launcher._popout.removed === 'height', 'launcher cancels stale resizing under reduced motion');
    delete settings.reduced_motion;
}
print(`PASS: ${checks} drawer/autohide combinations, anchored clips, reversals, zero duration and reduced-motion launcher resizing`);
