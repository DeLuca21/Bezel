import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {allowsMotion, chromeOptions} from './compat.js';
import {paintLoginFrame} from './drawing.js';
import {openingMotion, barMotion, iconMotion, THEME_DURATIONS} from './loginMotion.js';
import {readState} from './config.js';
import {sideWidths} from './geometry.js';
import {resolveTheme} from './theme.js';

export function playLockAnimation(settings) {
    const parent = Main.screenShield?.actor;
    if (!parent?.visible || !allowsMotion(St.Settings.get(), St.ReducedMotion)) return null;
    const state = readState(settings);
    // Geometry and colours only: never copy app icons, popups or desktop pixels
    // into the lock screen. A thin temporary edge also works without a frame.
    const sides = sideWidths(state);
    for (const edge of Object.keys(sides)) sides[edge] = Math.max(4, sides[edge]);
    const frames = new Map(Main.layoutManager.monitors.map(monitor =>
        [monitor.index, {monitor, sides}]));
    return new LoginAnimation([], frames, resolveTheme(settings), state, undefined, false,
        {parent, transientFrame: true});
}

// Bound CPU raster work and texture size on 4K/HiDPI displays. The compositor
// scales this temporary animation; the normal frame remains at native resolution.
const MAX_PAINT_PIXELS = 1920 * 1080;
export function loginSurfaceSize(width, height, scale = 1) {
    // Clutter rounds fractional monitor scales up for Cairo resources.
    const rasterScale = Math.max(1, Math.ceil(scale));
    const factor = Math.min(1, Math.sqrt(MAX_PAINT_PIXELS / (width * height)) / rasterScale);
    return [Math.max(1, Math.floor(width * factor)), Math.max(1, Math.floor(height * factor))];
}

function rememberActor(actor) {
    const saved = {actor, modified: false};
    saved.destroySignal = actor.connect('destroy', () => { saved.destroyed = true; });
    return saved;
}

// Startup can wait several seconds. Snapshot only when we take ownership, so
// cancellation before the first paint cannot undo Shell's intervening changes.
function beginActor(saved, transforms = true) {
    if (saved.modified) return;
    const {actor} = saved;
    Object.assign(saved, {modified: true, opacity: actor.opacity});
    if (transforms) Object.assign(saved, {scaleX: actor.scale_x, scaleY: actor.scale_y,
        translationX: actor.translation_x, translationY: actor.translation_y, pivot: actor.get_pivot_point()});
}

function restoreActor(saved) {
    if (saved.destroyed) return;
    const {actor, opacity, scaleX, scaleY, translationX, translationY, pivot} = saved;
    if (saved.modified) {
        if (pivot) {
            actor.set_scale(scaleX, scaleY);
            actor.set_pivot_point(...pivot);
            actor.translation_x = translationX;
            actor.translation_y = translationY;
        }
        actor.opacity = opacity;
    }
    actor.disconnect(saved.destroySignal);
}

function iconActors(actor) {
    if (actor._bezelBalance || actor._bezelGap) return [];
    // Keep each button's glyph, label and running dot together. Descend through
    // groups and scroll views so app buttons get their own arrival timing.
    if (actor instanceof St.Button || actor instanceof St.Label || actor instanceof St.Icon)
        return [actor];
    const children = actor.get_children();
    return children.length ? children.flatMap(iconActors) : [actor];
}

function iconPlacement(actor, bar, vertical) {
    const length = vertical ? bar.height : bar.width;
    let x = actor.x + actor.width / 2, y = actor.y + actor.height / 2;
    let scaleX = 1, scaleY = 1;
    for (let node = actor.get_parent(); node && node !== bar; node = node.get_parent()) {
        const [px, py] = node.get_pivot_point();
        x = node.x + node.translation_x + px * node.width + (x - px * node.width) * node.scale_x;
        y = node.y + node.translation_y + py * node.height + (y - py * node.height) * node.scale_y;
        scaleX *= node.scale_x;
        scaleY *= node.scale_y;
    }
    return {x, y, scaleX: scaleX || 1, scaleY: scaleY || 1,
        position: length > 0 ? Math.max(0, Math.min(1, (vertical ? y : x) / length)) : 0.5};
}

// Reveal alongside Shell's startup animation once its backgrounds are ready.
// Never cover the desktop while waiting for Shell to prepare those backgrounds.
export class LoginAnimation {
    constructor(bars, frames, theme, state, onStart = () => {}, waitForStartup = true, options = {}) {
        this._surfaces = [];
        this._bars = [];
        this._frames = [];
        this._progress = 0;
        this._parent = options.parent;
        this._transientFrame = options.transientFrame;
        this._theme = Object.hasOwn(THEME_DURATIONS, state.loginAnimationTheme) ? state.loginAnimationTheme : 'liquid';

        try {
            for (const monitor of Main.layoutManager.monitors) {
                const frame = frames.get(monitor.index);
                const savedFrame = this._theme !== 'fade' && frame?.actor ? rememberActor(frame.actor) : null;
                if (savedFrame) this._frames.push(savedFrame);
                const first = bars.find(bar => bar._monitor.index === monitor.index);
                // Frameless bars still use the usable monitor below GNOME's panel.
                const target = frame?.monitor ?? first?._monitor ?? monitor;
                const scale = Math.max(global.display.get_monitor_scale(monitor.index),
                    St.ThemeContext.get_for_stage(global.stage).scale_factor);
                const [paintWidth, paintHeight] = loginSurfaceSize(target.width, target.height, scale);
                const area = new St.DrawingArea({reactive: false, opacity: 0,
                    x: target.x, y: target.y, width: paintWidth, height: paintHeight});
                area.set_scale(target.width / paintWidth, target.height / paintHeight);
                area._loginFrame = savedFrame;
                area._loginGeometry = () => JSON.stringify([frame?.sides, frame?.popup, frame?.notification]);
                this._surfaces.push(area);
                area.connect('repaint', () => {
                    const cr = area.get_context();
                    try {
                        const [width, height] = area.get_surface_size();
                        cr.scale(width / target.width, height / target.height);
                        const motion = openingMotion(this._theme, this._progress, target.width, target.height,
                            frame?.sides ?? {left: 0, right: 0, top: 0, bottom: 0}, frame ? state.radius : 0);
                        paintLoginFrame(cr, target.width, target.height, motion, theme.bg, frame ? state.shadow : 0,
                            frame?.popup?.corner ? null : frame?.popup,
                            frame?.popup?.corner ? frame.popup : frame?.popup ? null : frame?.notification);
                    } finally { cr.$dispose(); }
                });
                if (this._parent) this._parent.add_child(area);
                else Main.layoutManager.addChrome(area, chromeOptions(Config.PACKAGE_VERSION, false, false, true));
                if (first)
                    area.get_parent().set_child_below_sibling(area, first._actor);
            }
            for (const bar of bars) {
                // Autohide owns its own scale, clip and opacity throughout login.
                if (bar._state.autohide) continue;
                const actor = bar._actor;
                this._bars.push(Object.assign(rememberActor(actor), {edge: bar._state.edge, icons: new Map(),
                    pullDistance: Math.min(10, Math.min(bar._monitor.width, bar._monitor.height) * 0.008),
                    iconDistance: Math.min(7, (bar._state.iconSize ?? 22) * 0.25)}));
            }
            const start = () => {
                if (this._prepared) Main.layoutManager.disconnect(this._prepared);
                this._prepared = 0;
                if (this._startup) Main.layoutManager.disconnect(this._startup);
                this._startup = 0;
                onStart();
                if (!this._surfaces.length || !allowsMotion(St.Settings.get(), St.ReducedMotion)) {
                    this.destroy();
                    return;
                }
                this._paint(0);
                const baseDuration = THEME_DURATIONS[this._theme] ?? THEME_DURATIONS.liquid;
                const duration = Math.round(baseDuration * 100 / Math.max(25, Math.min(200, state.loginAnimationSpeed ?? 100)));
                if (this._watchdog) GLib.source_remove(this._watchdog);
                this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + 1000, () => {
                    this._watchdog = 0;
                    this.destroy();
                    return GLib.SOURCE_REMOVE;
                });
                this._timeline = new Clutter.Timeline({actor: this._surfaces[0], duration});
                this._timeline.connect('new-frame', () => {
                    if (allowsMotion(St.Settings.get(), St.ReducedMotion)) this._paint(this._timeline.get_progress());
                    else this.destroy();
                });
                this._timeline.connect('completed', () => this.destroy());
                this._timeline.start();
            };
            // A missed startup signal must still release the waiting resources.
            this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                this._watchdog = 0;
                onStart();
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
            if (waitForStartup && Main.layoutManager._startingUp) {
                this._prepared = Main.layoutManager.connect('startup-prepared', () => start());
                // Rebuilds can occur after startup-prepared has already fired.
                this._startup = Main.layoutManager.connect('startup-complete', () => start());
            } else {
                start();
            }
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    _paint(progress) {
        this._progress = progress;
        for (const frame of this._frames) {
            if (!frame.destroyed) { beginActor(frame, false); frame.actor.opacity = 0; }
        }
        for (const area of this._surfaces) {
            area.opacity = Math.round((area._loginFrame?.opacity ?? 255) * openingMotion(this._theme, progress, 1, 1,
                {left: 0, right: 0, top: 0, bottom: 0}, 0).opacity);
            if (this._transientFrame) {
                const tail = Math.max(0, Math.min(1, (progress - 0.75) / 0.25));
                area.opacity = Math.round(area.opacity * (1 - tail * tail * (3 - 2 * tail)));
            }
            const geometry = this._theme === 'fade' ? '' : area._loginGeometry();
            if (!['fade', 'glide', 'soft-fade'].includes(this._theme) || area._loginPainted !== geometry) {
                area._loginPainted = geometry;
                area.queue_repaint();
            }
        }
        for (const bar of this._bars) {
            if (bar.destroyed) continue;
            beginActor(bar);
            const {actor, edge, opacity, scaleX, scaleY, translationX, translationY, pivot} = bar;
            const motion = barMotion(this._theme, progress, edge);
            const vertical = edge === 'left' || edge === 'right';
            const direction = edge === 'right' || edge === 'bottom' ? -1 : 1;
            actor.set_pivot_point(...motion.pivot);
            actor.set_scale(scaleX * motion.x, scaleY * motion.y);
            const offset = direction * bar.pullDistance * (motion.offset ?? 0);
            actor.translation_x = translationX + (pivot[0] - motion.pivot[0]) * actor.width * (1 - scaleX) + (vertical ? offset : 0);
            actor.translation_y = translationY + (pivot[1] - motion.pivot[1]) * actor.height * (1 - scaleY) + (vertical ? 0 : offset);
            actor.opacity = Math.round(opacity * motion.opacity);
            // Apps may start or exit during login; discover replacements and
            // never write to the destroyed buttons from the previous frame.
            const current = new Set(actor.get_children().flatMap(iconActors));
            for (const [icon, saved] of bar.icons) {
                if (saved.destroyed || !current.has(icon)) {
                    restoreActor(saved);
                    bar.icons.delete(icon);
                }
            }
            for (const icon of current) {
                if (!bar.icons.has(icon)) bar.icons.set(icon, rememberActor(icon));
                const saved = bar.icons.get(icon);
                beginActor(saved);
                const placement = iconPlacement(icon, actor, vertical);
                const arrival = this._theme === 'liquid' ? iconMotion(progress, placement.position)
                    : {opacity: motion.contentOpacity, scale: 1, across: 0, along: 0};
                icon.set_pivot_point(0.5, 0.5);
                // Counter the surface stretch so glyphs keep their natural
                // proportions and spacing throughout their arrival.
                icon.set_scale(saved.scaleX * arrival.scale / motion.x, saved.scaleY * arrival.scale / motion.y);
                icon.opacity = Math.round(saved.opacity * arrival.opacity);
                const across = direction * bar.iconDistance * arrival.across;
                const along = bar.iconDistance * arrival.along;
                icon.translation_x = saved.translationX / motion.x +
                    (saved.pivot[0] - 0.5) * icon.width * (1 - saved.scaleX) / motion.x +
                    (placement.x - actor.width * motion.pivot[0]) * (1 / motion.x - 1) / placement.scaleX +
                    (vertical ? across : along) / (motion.x * placement.scaleX);
                icon.translation_y = saved.translationY / motion.y +
                    (saved.pivot[1] - 0.5) * icon.height * (1 - saved.scaleY) / motion.y +
                    (placement.y - actor.height * motion.pivot[1]) * (1 / motion.y - 1) / placement.scaleY +
                    (vertical ? along : across) / (motion.y * placement.scaleY);
            }
        }
    }

    destroy() {
        if (this._prepared) Main.layoutManager.disconnect(this._prepared);
        this._prepared = 0;
        if (this._startup) Main.layoutManager.disconnect(this._startup);
        this._startup = 0;
        if (this._watchdog) GLib.source_remove(this._watchdog);
        this._watchdog = 0;
        this._timeline?.stop();
        this._timeline = null;
        for (const bar of this._bars) {
            for (const saved of bar.icons.values()) restoreActor(saved);
            restoreActor(bar);
        }
        this._bars = [];
        for (const frame of this._frames) restoreActor(frame);
        this._frames = [];
        for (const area of this._surfaces) {
            if (!this._parent) Main.layoutManager.removeChrome(area);
            area.destroy();
        }
        this._surfaces = [];
    }
}
