import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {LiquidMaterial} from './liquidMaterial.js';
import {resolveTheme} from './theme.js';
import {appPatterns, appAllowed} from './appBlurPolicy.js';

export class ApplicationBlur {
    constructor(settings) {
        this.settings = settings;
        this.desktop = {index: 0, x: 0, y: 0, width: global.stage.width, height: global.stage.height, virtual: true};
        this.records = new Map();
        this.signals = [];
        this.waiting = new Map();
        this.tracker = Shell.WindowTracker.get_default();
        const connect = (object, signal, callback) => this.signals.push([object, object.connect(signal, callback)]);
        connect(settings, 'changed', (_settings, key) => {
            if ((key.startsWith('app-blur-') || key === 'app-glass-highlight') || key.startsWith('liquid-') || key === 'theme') {
                this.queue();
            }
        });
        connect(global.display, 'window-created', (_display, win) => {
            const actor = win.get_compositor_private();
            if (actor) {
                const first = actor.connect('first-frame', () => {
                    const signals = this.waiting.get(actor);
                    this.waiting.delete(actor);
                    for (const id of signals ?? []) actor.disconnect(id);
                    this.queue();
                });
                const destroy = actor.connect('destroy', () => this.waiting.delete(actor));
                this.waiting.set(actor, [first, destroy]);
            }
            this.queue();
        });
        connect(global.display, 'restacked', () => this.queue());
        connect(this.tracker, 'tracked-windows-changed', () => this.queue());
        connect(Main.layoutManager, 'monitors-changed', () => { this.refreshDesktop(); this.queue(); });
        connect(Main.overview, 'showing', () => this.update());
        connect(Main.overview, 'hidden', () => this.update());
        connect(global.stage, 'before-paint', () => {
            if (this.desktop.width !== global.stage.width || this.desktop.height !== global.stage.height) { this.refreshDesktop(); this.queue(); }
            if (this.pending) { GLib.source_remove(this.pending); this.pending = 0; this.sync(); }
            else this.update();
        });
        this.queue();
    }
    refreshDesktop() {
        this.desktop = {...this.desktop, width: global.stage.width, height: global.stage.height};
    }
    queue() {
        if (this.pending) return;
        this.pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.pending = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }
    sync() {
        const enabled = this.settings.get_boolean('app-blur-enabled');
        const whitelist = appPatterns(this.settings.get_strv('app-blur-whitelist'));
        const blacklist = appPatterns(this.settings.get_strv('app-blur-blacklist'));
        const windows = global.display.sort_windows_by_stacking(global.get_window_actors().map(actor => actor.meta_window));
        const keep = new Set();
        for (const win of windows) {
            const actor = win.get_compositor_private();
            const ids = [win.get_wm_class(), win.get_wm_class_instance(), this.tracker.get_window_app(win)?.get_id()];
            if (!enabled || !actor || this.waiting.has(actor) || ![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(win.get_window_type())
                || !appAllowed(ids, this.settings.get_string('app-blur-policy'), whitelist, blacklist)) continue;
            keep.add(win);
            let record = this.records.get(win);

            if (!record) {
                record = {win, actor, originals: new Map(), clones: new Map(), signals: [], source: new Clutter.Actor({reactive: false, layout_manager: new Clutter.FixedLayout()})};
                this.records.set(win, record);
                record.signals.push([win, win.connect('unmanaged', () => this.remove(win))]);
                record.signals.push([actor, actor.connect('destroy', () => {record.actor = null; this.remove(win);})]);
                record.signals.push([actor, actor.connect('child-added', () => this.queue())]);
                record.signals.push([actor, actor.connect('child-removed', (_actor, child) => record.originals.delete(child))]);

            }
            const mode = this.settings.get_string('app-blur-type');
            const glass = this.settings.get_string('app-blur-finish') === 'glass' && this.settings.get_boolean('liquid-glass-enabled');
            const signature = JSON.stringify([mode, glass, glass ? this.settings.get_int('liquid-blur-radius') : this.settings.get_int('app-blur-sigma'),
                glass ? this.settings.get_int('liquid-tint') : 0, glass ? this.settings.get_boolean('app-glass-highlight') : false, resolveTheme(this.settings).bg]);
            if (!record.material || record.signature !== signature || record.monitor !== this.desktop) {
                record.rim?.actor.destroy(); record.rim = null;
                record.material?.actor.destroy();
                record.material = new LiquidMaterial(this.desktop, this.settings, resolveTheme(this.settings).bg, true, {
                    live: mode === 'dynamic', windowSource: record.source,
                    radius: glass ? this.settings.get_int('liquid-blur-radius') : 2 * this.settings.get_int('app-blur-sigma'), tint: glass ? this.settings.get_int('liquid-tint') : 0,
                    brightness: this.settings.get_int('app-blur-brightness'), contrast: glass ? this.settings.get_int('liquid-contrast') : 100, highlight: false,
                });
                record.material.mode = mode;
                record.material.glassFinish = glass;
                if (glass && this.settings.get_boolean('app-glass-highlight')) {
                    record.rim = {actor: new St.Widget({name: 'bezel-app-glass-highlight', reactive: false})};
                    actor.add_child(record.rim.actor);
                }
                record.signature = signature;
                record.monitor = this.desktop;
                record.geometry = null;
            }
            if (!record.material.actor.get_parent()) actor.insert_child_at_index(record.material.actor, 0);
            else actor.set_child_below_sibling(record.material.actor, null);

        }
        for (const win of this.records.keys()) if (!keep.has(win)) this.remove(win);
        this.windows = windows;
        this.update();
    }
    syncSource(record) {
        const lower = new Set((this.windows ?? []).slice(0, (this.windows ?? []).indexOf(record.win))
            .map(win => win.get_compositor_private()).filter(Boolean));
        for (const [actor, clone] of record.clones) {
            if (!lower.has(actor) || clone.get_source() !== actor) { clone.destroy(); record.clones.delete(actor); }
        }
        let position = 0;
        for (const actor of lower) {
            let clone = record.clones.get(actor);
            if (!clone) {
                clone = new Clutter.Clone({source: actor, reactive: false});
                record.source.add_child(clone);
                record.clones.set(actor, clone);
            }
            if (record.source.get_child_at_index(position) !== clone) record.source.set_child_at_index(clone, position);
            position++;
            const values = [actor.x, actor.y, actor.width, actor.height, actor.scale_x, actor.scale_y,
                actor.translation_x, actor.translation_y, actor.translation_z, actor.visible];
            if (values.every((value, index) => value === clone._bezelAllocation?.[index])) continue;
            clone._bezelAllocation = values;
            clone.set_position(actor.x, actor.y);
            clone.set_size(actor.width, actor.height);
            clone.set_scale(actor.scale_x, actor.scale_y);
            clone.set_translation(actor.translation_x, actor.translation_y, actor.translation_z);
            clone.visible = actor.visible;
            clone.allocate(new Clutter.ActorBox({x1: actor.x, y1: actor.y, x2: actor.x + actor.width, y2: actor.y + actor.height}));
            record.material.liveScene.actor.queue_redraw();
        }
    }
    update() {
        for (const record of this.records.values()) {
            const {win, actor, material} = record;
            if (!actor || !material) continue;
            const visible = !(this.settings.get_string('app-blur-finish') === 'glass' && !this.settings.get_boolean('liquid-glass-enabled'))
                && actor.visible && !win.minimized && win.showing_on_its_workspace()
                && !(this.settings.get_boolean('app-blur-unblur-fullscreen') && win.fullscreen)
                && (this.settings.get_boolean('app-blur-overview') || !Main.overview.visible)
                && !(this.settings.get_boolean('app-blur-opaque-focused') && global.display.focus_window === win);
            material.actor.visible = visible;
            if (record.rim) record.rim.actor.visible = visible;
            for (const child of actor.get_children()) {
                if (child === material.actor || child === record.rim?.actor) continue;
                if (!record.originals.has(child)) record.originals.set(child, child.opacity);
                const original = record.originals.get(child);
                // Opacity is an absolute foreground value, independent of blur strength.
                // Multiplying a captured opacity can compound an earlier fade
                // or another extension's opacity and dim text unexpectedly.
                const desired = visible ? this.settings.get_int('app-blur-window-opacity') : original;
                if (child.opacity !== desired) child.opacity = desired;
            }
            if (!visible) continue;
            material.mask.set('brightness', [(material.glassFinish ? this.settings.get_int('liquid-brightness') : Math.min(100, this.settings.get_int('app-blur-brightness'))) / 100]);
            material.mask.set('contrast', [material.glassFinish ? this.settings.get_int('liquid-contrast') / 100 : 1]);
            if (material.mode === 'dynamic') this.syncSource(record);
            const frame = win.get_frame_rect(), buffer = win.get_buffer_rect();
            const maximized = win.fullscreen || win.maximized_horizontally || win.maximized_vertically;
            const radius = actor.get_effect('Rounded Corners Effect') || (maximized && !this.settings.get_boolean('app-blur-round-maximized'))
                ? 0 : this.settings.get_int('app-blur-corner-radius');
            const geometry = [frame.x - buffer.x, frame.y - buffer.y, Math.max(1, frame.width), Math.max(1, frame.height), radius];
            if (!geometry.every((value, index) => value === record.geometry?.[index])) {
                material.actor.set_position(geometry[0], geometry[1]);
                material.actor.set_size(geometry[2], geometry[3]);
                material.rectangle(geometry[2], geometry[3], radius);
                if (record.rim) {
                    record.rim.actor.set_position(geometry[0] + 1, geometry[1] + 1);
                    record.rim.actor.set_size(Math.max(1, geometry[2] - 2), Math.max(1, geometry[3] - 2));
                    const rimRadius = maximized && !this.settings.get_boolean('app-blur-round-maximized') ? 0 : this.settings.get_int('app-blur-corner-radius');
                    record.rim.actor.set_style(`background-color: transparent; border: 1px solid rgba(255,255,255,0.38); border-radius: ${rimRadius}px;`);
                }
                record.geometry = geometry;
            }
            if (record.rim && actor.get_last_child() !== record.rim.actor) actor.set_child_above_sibling(record.rim.actor, null);
            material.syncBackground();

        }
    }
    remove(win) {
        const record = this.records.get(win);
        if (!record) return;
        this.records.delete(win);
        if (record.actor) for (const child of record.actor.get_children()) {
            if (record.originals.has(child)) child.opacity = record.originals.get(child);
        }
        for (const [object, id] of record.signals) {
            if (object === record.actor || object === win) object.disconnect(id);
        }
        record.rim?.actor.destroy();
        record.material?.actor.destroy();
        record.source.destroy();
    }
    destroy() {
        if (this.pending) GLib.source_remove(this.pending);
        this.pending = 0;
        for (const [object, id] of this.signals) object.disconnect(id);
        this.signals = [];
        for (const [actor, signals] of this.waiting) for (const id of signals) actor.disconnect(id);
        this.waiting.clear();
        for (const win of this.records.keys()) this.remove(win);
    }
}
