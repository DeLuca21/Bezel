// Compare the actual cached frame surfaces against a full reference Cairo paint.
// Run from the repository root: gjs -m tests/frame-rendering.js
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {paintFrame} from '../bezel@deluca21/lib/drawing.js';
import {frameRegions} from '../bezel@deluca21/lib/frame-regions.js';

class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.signals = new Map(); }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(width, height) { this.width = width; this.height = height; }
    add_child(child) { this.children.push(child); child.parent = this; }
    connect(name, callback) { this.signals.set(name, callback); }
    destroy() { this.signals.get('destroy')?.(); this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}
class DrawingArea extends Actor {
    get_surface_size() { return [this.width, this.height]; }
    get_context() {
        this.surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, this.width, this.height);
        return new Cairo.Context(this.surface);
    }
    queue_repaint() { this.signals.get('repaint')(this); }
}
const base = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const source = new TextDecoder().decode(base.get_child('bezel@deluca21/lib/frame.js').load_contents(null)[1])
    .replace(/^import .*;\n/gm, '').replace('export class', 'class');
const DesktopFrame = new Function('St', 'paintFrame', 'frameRegions', `${source}\nreturn DesktopFrame;`)
    ({Widget: Actor, DrawingArea}, paintFrame, frameRegions);
const directory = GLib.dir_make_tmp('bezel-frame-regression-XXXXXX');
let checks = 0;
function compare(frame, name) {
    const {width, height} = frame.monitor;
    const composed = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(composed);
    for (const area of frame.areas) {
        cr.setSourceSurface(area.surface, area.x, area.y);
        cr.paintWithAlpha((area.opacity ?? 255) / 255);
    }
    cr.$dispose();
    const reference = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const ref = new Cairo.Context(reference);
    const spread = frame.spread ?? 1;
    const sides = Object.fromEntries(Object.entries(frame.sides).map(([edge, size]) => [edge, size * spread]));
    paintFrame(ref, width, height, sides, frame.state.radius * spread, frame.theme.bg, frame.state.shadow * spread,
        frame.popup, frame.notification);
    ref.$dispose();
    if (frame.fade < 1) {
        const fade = new Cairo.Context(reference);
        fade.setOperator(Cairo.Operator.DEST_IN);
        fade.setSourceRGBA(0, 0, 0, Math.round(frame.fade * 255) / 255);
        fade.paint();
        fade.$dispose();
    }
    const actualPath = `${directory}/actual.png`, expectedPath = `${directory}/expected.png`;
    composed.writeToPNG(actualPath); reference.writeToPNG(expectedPath);
    const actual = GdkPixbuf.Pixbuf.new_from_file(actualPath), expected = GdkPixbuf.Pixbuf.new_from_file(expectedPath);
    const a = actual.get_pixels(), b = expected.get_pixels();
    const channels = actual.get_n_channels(), rowstride = actual.get_rowstride();
    let max = 0, differences = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * channels;
            const aa = channels === 4 ? a[i + 3] : 255, ba = channels === 4 ? b[i + 3] : 255;
            let delta = Math.abs(aa - ba);
            for (let color = 0; color < 3; color++)
                delta = Math.max(delta, Math.abs(a[i + color] * aa - b[i + color] * ba) / 255);
            if (delta > 1) differences++;
            max = Math.max(max, delta);
        }
    }
    // Cairo clips and tessellates a full path slightly differently on small
    // surfaces. The original four-strip renderer also differs on up to 17 curve
    // pixels by 12 alpha levels in these cases. Allow that bounded edge noise.
    if (max > 16 || differences > 32)
        throw new Error(`${name}: cached/reference difference ${max} over ${differences} pixels; images in ${directory}`);
    checks++;
}
function fixture(width = 640, height = 480) {
    return new DesktopFrame({x: 100, y: 50, width, height}, {bg: '#242424'},
        {left: 12, right: 12, top: 12, bottom: 12}, {radius: 28, shadow: 8,
            bars: ['left', 'right', 'top', 'bottom'].map(edge => ({edge, thickness: 56, autohide: true, kind: 'panel', length: 100}))});
}
for (const edge of ['left', 'right', 'top', 'bottom']) {
    for (const drawer of [false, true]) {
        const frame = fixture();
        for (const progress of [0, .2, .5, .8, 1, .5, 0]) {
            frame.setReveal(0, edge, 56, progress);
            if (drawer) frame.setPopup({x: 250, y: 62, width: 140, height: 120, edge: 'top', progress});
            compare(frame, `${edge}, drawer=${drawer}, reveal=${progress}`);
        }
    }
    const cramped = fixture(128, 120);
    for (const progress of [0, .2, .5, .8, 1, .5, 0]) {
        cramped.setReveal(0, edge, 56, progress);
        compare(cramped, `cramped ${edge}, reveal=${progress}`);
    }
}
for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const frame = fixture();
    for (const progress of [0, .2, .5, .8, 1, .5, 0]) {
        frame.setReveal(0, 'left', 56, progress);
        frame.setNotification({corner, edge: corner.startsWith('bottom') ? 'bottom' : 'top', width: 130, height: 80, progress});
        compare(frame, `${corner}, notification=${progress}`);
    }
}
for (const spread of [0, .3, .7, 1]) {
    const frame = fixture();
    frame.setSpread(spread);
    for (const progress of [0, .5, 1]) {
        frame.setReveal(0, 'left', 56, progress);
        compare(frame, `layout spread=${spread}, reveal=${progress}`);
        frame.setFade(.5);
        compare(frame, `layout fade, spread=${spread}, reveal=${progress}`);
        frame.setFade(1);
    }
}
for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const frame = fixture();
    frame.setPopup({x: 250, y: 62, width: 140, height: 120, edge: 'top', progress: 1});
    frame.setNotification({corner, edge: corner.startsWith('bottom') ? 'bottom' : 'top', width: 130, height: 80, progress: 1});
    compare(frame, `simultaneous drawer and ${corner} notification`);
}
GLib.unlink(`${directory}/actual.png`); GLib.unlink(`${directory}/expected.png`); GLib.rmdir(directory);
print(`PASS: ${checks} cached/full-reference Cairo comparisons, including all edges, reversals, drawers, notifications and cramped openings`);
