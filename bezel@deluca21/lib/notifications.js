import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import {LiquidMaterial, liquidEnabled, MaterialActor} from './liquidMaterial.js';
import {hexToRgba} from './theme.js';
import {motionDuration} from './pageMotion.js';
import {settingChoice} from './config.js';
import {notificationJoinsFrame} from './frame-regions.js';

// Keep GNOME's notification lifecycle, close button, actions, DND and history.
// Only presentation is changed; no notification is copied or consumed here.
export class NotificationBridge {
    constructor(monitor, sides, theme, framed, radius, frame = null, settings = null) {
        this.frame = frame;
        this.settings = settings;
        this.tray = Main.messageTray;
        this.bin = this.tray?._bannerBin;
        if (!this.bin) return;
        this.parent = this.tray.get_parent();
        this.previousSibling = this.tray.get_previous_sibling();
        this.parent.set_child_above_sibling(this.tray, null);
        this.monitor = monitor;
        this.sides = sides;
        this.theme = theme;
        this.framed = framed;
        this.radius = Math.max(12, radius);
        this.original = {clip: this.tray.clip_to_allocation, style: this.bin.get_style(), align: this.tray.bannerAlignment, x: this.bin.translation_x, y: this.bin.translation_y};
        this.tray.clip_to_allocation = false;
        this.records = new Map();
        this.pendingStyles = new Map();
        this.layer = new MaterialActor({x: 0, y: 0, width: global.stage.width, height: global.stage.height, reactive: false, layout_manager: new Clutter.FixedLayout(),
            x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
        this.parent.insert_child_below(this.layer, this.tray);
        this.bin.set_style('padding: 0; margin: 0;');
        this.signals = [
            this.bin.connect('child-added', (_bin, child) => this.decorate(child)),
            this.bin.connect('notify::allocation', () => this.position()),
            this.tray.connect('notify::allocation', () => this.position()),
            this.bin.connect('notify::y', () => this.position()),
            this.bin.connect('notify::opacity', () => { this.layer.opacity = this.bin.opacity; }),
        ];
        for (const child of this.bin.get_children()) this.decorate(child);
        this.paintSignal = global.stage.connect('before-paint', () => { if (this.bin?.mapped) this.position(); });
        this.binDestroyedSignal = this.bin.connect('destroy', () => {
            if (this.paintSignal) global.stage.disconnect(this.paintSignal);
            this.paintSignal = null;
            this.bin = null;
        });
        this.position();
        // Record delivery state, never notification text. This distinguishes a
        // policy/queue skip from an acknowledged but unpainted live banner.
        this.deliveryTimers = new Set();
        this.sourceSignals = new Map();
        const watch = source => {
            if (this.sourceSignals.has(source)) return;
            const added = source.connect('notification-added', (_source, notification) => {
                const gates = {banners: source.policy.showBanners, blocked: this.tray._bannerBlocked,
                    busy: this.tray._busy, fullscreen: Main.layoutManager.primaryMonitor?.inFullscreen};
                const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
                    this.deliveryTimers.delete(timer);
                    const banner = this.tray._banner;
                    const current = banner?.notification === notification;
                    console.log(`[Bezel notification] ${JSON.stringify({...gates,
                        acknowledged: notification.acknowledged, transient: notification.isTransient,
                        historyOpen: Boolean(this.historyOpen), current,
                        queued: this.tray._notificationQueue?.includes(notification),
                        mapped: current && banner.is_mapped(),
                        opacity: current ? banner.get_paint_opacity() : null,
                        position: current ? banner.get_transformed_position() : null,
                        size: current ? banner.get_transformed_size() : null})}`);
                    return GLib.SOURCE_REMOVE;
                });
                this.deliveryTimers.add(timer);
            });
            const destroyed = source.connect('destroy', () => this.sourceSignals.delete(source));
            this.sourceSignals.set(source, [added, destroyed]);
        };
        this.sourceAdded = this.tray.connect('source-added', (_tray, source) => watch(source));
        this.tray.getSources().forEach(watch);
    }

    _corner() {
        const value = settingChoice(this.settings, 'notifications-position', 'top-right',
            ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'icon']);
        return ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value) ? value : 'top-right';
    }

    // Joined autohide grows the frame opening; follow those live sides the
    // same way popouts use `_opening()`.
    _opening() {
        return this.frame?.sides ?? this.sides;
    }

    position() {
        if (!this.bin || this.positioning) return;
        this.positioning = true;
        try {
            const banner = this.tray._banner ?? this.bin.get_first_child();
            if (!banner?.has_allocation() || !this.layer.has_allocation()) return;
            const [bx, by] = banner.get_transformed_position();
            const [width, height] = banner.get_transformed_size();
            if (![bx, by, width, height].every(Number.isFinite) || width < 1 || height < 1) return;
            const corner = this._corner();
            const gap = this.framed ? 0 : 12;
            const left = corner.endsWith('left');
            const bottom = corner.startsWith('bottom');
            const sides = this._opening();
            const x = left
                ? this.monitor.x + sides.left + gap
                : this.monitor.x + this.monitor.width - sides.right - gap - width;
            const y = bottom
                ? this.monitor.y + this.monitor.height - sides.bottom - gap - height - this.bin.y
                : this.monitor.y + sides.top + gap + this.bin.y;
            this.tray.bannerAlignment = left ? Clutter.ActorAlign.START : Clutter.ActorAlign.END;
            this.bin.remove_transition('translation-x');
            this.bin.translation_x += x - bx;
            this.bin.translation_y += y - by;
            this.layer.opacity = this.bin.opacity;
            const record = this.records.get(banner);
            if (record?.glass) {
                const [lx, ly] = this.layer.get_transformed_position();
                record.glass.actor.set_position(x - lx, y - ly);
                record.glass.actor.set_size(width, height);
                record.glass.rectangle(width, height, this.radius);
            }
            this.frame?.setNotification({
                glass: Boolean(record?.glass || this.frame?.glass),
                width, height, corner, edge: bottom ? 'bottom' : 'top',
                progress: Math.max(0, Math.min(1, (height + this.bin.y) / Math.max(1, height))),
            });
        } finally { this.positioning = false; }
    }

    decorate(banner) {
        if (!this.bin || !(banner instanceof St.Widget) || this.records.has(banner) || this.pendingStyles.has(banner))
            return;
        if (!banner.has_style_class_name('notification-banner')) {
            const forget = () => {
                const ids = this.pendingStyles.get(banner);
                if (!ids) return;
                this.pendingStyles.delete(banner);
                ids.forEach(id => banner.disconnect(id));
            };
            const changed = banner.connect('notify::style-class', () => {
                if (!banner.has_style_class_name('notification-banner')) return;
                forget();
                this.decorate(banner);
            });
            const destroyed = banner.connect('destroy', forget);
            this.pendingStyles.set(banner, [changed, destroyed]);
            return;
        }
        const record = {style: banner.get_style(), corners: [], parts: []};
        if (liquidEnabled(this.settings, 'glass-drawers') || this.frame?.glass) {
            record.glass = new LiquidMaterial(this.monitor, this.settings, this.theme.bg);
            record.glass.actor.set_size(Math.max(1, banner.width), Math.max(1, banner.height));
            record.glass.syncShape = () => record.glass.rectangle(record.glass.actor.width, record.glass.actor.height, this.radius);
            this.layer.add_child(record.glass.actor);
            this.parent.set_child_below_sibling(this.layer, this.tray);
        }
        record.destroy = banner.connect('destroy', () => {
            record.glass?.actor.destroy();
            for (const area of record.corners) area.destroy();
            this.records.delete(banner);
            if (!this.tray._banner || this.tray._banner === banner) this.frame?.setNotification(null);
        });
        this.records.set(banner, record);
        const radii = {
            'top-right': `0 0 0 ${this.radius}px`,
            'top-left': `0 0 ${this.radius}px 0`,
            'bottom-right': `${this.radius}px 0 0 0`,
            'bottom-left': `0 ${this.radius}px 0 0`,
        };
        this._bannerStyle(banner, record, radii);
        record.actionCleanup = styleActions(banner, this.theme, {glass: !!record.glass, corners: () => {
            const radius = Math.max(0, this.radius - 4);
            if (!this._frameOpen()) return [radius, radius];
            return [this._corner() === 'top-right' ? radius : 0, this._corner() === 'top-left' ? radius : 0];
        }});
        for (const [actor, style] of [[banner._header, `color: ${this.theme.muted};`],
            [banner._header?.closeButton, `color: ${this.theme.fg}; background-color: ${this.theme.surface}; border-radius: 12px;`]]) {
            if (!actor) continue;
            record.parts.push([actor, actor.get_style()]);
            actor.set_style(style);
        }
        this.position();
    }

    // The frame actor is hidden while a monitor is fullscreen, so a banner
    // joined to that frame would have nothing behind it. A second joined
    // drawer can also own that hole; then the banner paints its own card.
    _frameOpen() {
        const actor = this.frame?.actor;
        if (!this.framed || !actor?.visible)
            return false;
        const index = this.monitor?.index;
        if (index != null && global.display.get_monitor_in_fullscreen(index))
            return false;
        const sides = this._opening();
        const opening = {
            w: Math.max(1, (this.monitor?.width ?? 0) - sides.left - sides.right),
            h: Math.max(1, (this.monitor?.height ?? 0) - sides.top - sides.bottom),
            sides,
        };
        return notificationJoinsFrame(this.frame.popup, this.frame.notification, opening);
    }

    _bannerStyle(banner, record, radii = null) {
        const open = this._frameOpen();
        const corner = this._corner();
        const joined = {
            'top-right': `0 0 0 ${this.radius}px`,
            'top-left': `0 0 ${this.radius}px 0`,
            'bottom-right': `${this.radius}px 0 0 0`,
            'bottom-left': `0 ${this.radius}px 0 0`,
        };
        if (record.glass) record.glass.actor.visible = !open && this.bin.visible;
        const style = `${record.style ? `${record.style};` : ''} margin: 0; background-color: ${open || record.glass ? 'transparent' : this.theme.bg}; color: ${this.theme.fg}; border: none; border-radius: ${open ? (radii ?? joined)[corner] : `${this.radius}px`}; box-shadow: ${open ? 'none' : '0 3px 10px rgba(0,0,0,0.22)'};`;
        if (banner.get_style() !== style) banner.set_style(style);
        record.actionCleanup?.refresh();
    }

    restyle() {
        if (this._restyling)
            return;
        this._restyling = true;
        try {
            for (const [banner, record] of this.records)
                this._bannerStyle(banner, record);
        } finally {
            this._restyling = false;
        }
    }

    setHistoryOpen(open) {
        // Presentation only: never alter GNOME's global notification queue gate.
        if (!this.bin || Boolean(open) === Boolean(this.historyOpen)) return;
        this.historyOpen = Boolean(open);
        if (open) this.wasVisible = this.bin.visible;
        this.bin.visible = open ? false : this.wasVisible ?? true;
        this.layer.visible = this.bin.visible;
    }

    destroy() {
        if (this.paintSignal) global.stage.disconnect(this.paintSignal);
        this.paintSignal = null;
        this.setHistoryOpen(false);
        this.frame?.setNotification(null);
        if (!this.bin) return;
        if (this.binDestroyedSignal) this.bin.disconnect(this.binDestroyedSignal);
        this.binDestroyedSignal = 0;
        this.tray.disconnect(this.sourceAdded);
        for (const [source, ids] of this.sourceSignals)
            ids.forEach(id => source.disconnect(id));
        this.sourceSignals.clear();
        for (const timer of this.deliveryTimers) GLib.source_remove(timer);
        this.deliveryTimers.clear();
        for (const [index, id] of this.signals.entries())
            (index === 2 ? this.tray : this.bin).disconnect(id);
        for (const [banner, ids] of this.pendingStyles)
            ids.forEach(id => banner.disconnect(id));
        this.pendingStyles.clear();
        this.layer?.destroy();
        for (const [banner, record] of this.records) {
            record.actionCleanup?.();
            banner.disconnect(record.destroy);
            banner.set_style(record.style);
            for (const [actor, style] of record.parts) actor.set_style(style);
            for (const area of record.corners) area.destroy();
        }
        this.records.clear();
        if (this.tray.get_parent() === this.parent && (!this.previousSibling || this.previousSibling.get_parent() === this.parent))
            this.parent.set_child_above_sibling(this.tray, this.previousSibling);
        this.bin.set_style(this.original.style);
        this.tray.clip_to_allocation = this.original.clip;
        this.tray.bannerAlignment = this.original.align;
        this.bin.translation_x = this.original.x;
        this.bin.translation_y = this.original.y;
        this.bin = null;
    }
}

// Separate views of the same notification objects preserve actions and dismissal.
// Destroying a view does not dismiss its notification.
export function buildNotificationCenter(bar, embedded = false) {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
        style: 'spacing: 10px;'});
    box.add_child(new St.Label({text: 'Notifications', style: 'font-weight: bold; font-size: 18px;'}));
    const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
    box.add_child(list);
    const empty = new St.Label({text: 'No notifications', y_align: Clutter.ActorAlign.START,
        y_expand: true, style: `color: ${bar._theme.muted}; padding: 20px;`});
    // Keep the placeholder in the same stack: toggling a sibling after the
    // final collapse changes BoxLayout spacing and forces another drawer fit.
    const emptySlot = new St.Widget({name: 'bezel-notification-empty', layout_manager: new Clutter.BinLayout(),
        clip_to_allocation: true, height: 0, x_expand: true});
    emptySlot.add_child(empty);
    list.add_child(emptySlot);
    const messages = new Map();
    const oldestFirst = settingChoice(bar._overlay._settings, 'notifications-order', 'newest-first',
        ['newest-first', 'oldest-first']) === 'oldest-first';
    let sequence = 0;
    const timestamp = notification => notification.datetime
        ? notification.datetime.to_unix() * 1000000 + notification.datetime.get_microsecond() : 0;
    // Sort across sources as well as live arrivals, so reopening preserves order.
    const orderedRows = () => [...messages.values()].sort((a, b) =>
        (oldestFirst ? 1 : -1) * (a.time - b.time || a.sequence - b.sequence));
    const timelines = new Set();
    let layoutTimeline = null;
    let pending = 0;
    let stopped = false;
    const animate = (duration, actor, paint, complete) => {
        if (!duration) { paint(1); complete?.(); return null; }
        const timeline = new Clutter.Timeline({duration, actor});
        timelines.add(timeline);
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        timeline.connect('new-frame', () => paint(timeline.get_progress()));
        timeline.connect('completed', () => {
            timelines.delete(timeline);
            paint(1);
            complete?.();
        });
        timeline.start();
        return timeline;
    };
    const reflow = (duration = motionDuration(bar)) => {
        if (stopped || !box.get_stage() || !bar._popout) return;
        if (layoutTimeline) { layoutTimeline.stop(); timelines.delete(layoutTimeline); layoutTimeline = null; }
        const width = Math.max(1, embedded ? box.width : bar._popupWidth - 36);
        const rows = orderedRows();
        rows.forEach((row, index) => {
            if (list.get_child_at_index(index) !== row.slot) list.set_child_at_index(row.slot, index);
        });
        const visible = rows.filter(row => !row.collapsing);
        const emptyFrom = emptySlot.height;
        empty.height = -1;
        empty.height = Math.ceil(empty.get_preferred_height(width)[1]);
        const emptyTarget = visible.length ? 0 : empty.height;
        emptySlot.height = emptyTarget;
        const sizes = rows.map(row => {
            const from = row.slot.height;
            if (!row.leaving) {
                row.message.width = width;
                row.message.height = -1;
                row.message.height = Math.ceil(row.message.get_preferred_height(width)[1]);
            }
            const last = visible.at(-1) === row;
            const target = row.collapsing ? 0 : row.message.height + (last ? 0 : 10);
            row.slot.height = target;
            return {row, from: row.entering ? 0 : from, target, x: row.message.translation_x};
        });
        // Measure final content once, then restore the current visual heights.
        for (let parent = box.get_parent(); parent; parent = parent.get_parent()) {
            parent._refreshPageHeight?.();
            if (parent === bar._popupContent) break;
        }
        bar._popupLockedHeight = false;
        const height = bar._fitPopup(true);
        for (const {row, from} of sizes) row.slot.height = from;
        emptySlot.height = emptyFrom;
        if (Number.isFinite(height)) bar._setDashboardSize(bar._popupWidth, height, duration);
        for (const {row} of sizes) row.entering = false;
        const finish = () => {
            layoutTimeline = null;
            for (const {row} of sizes) {
                if (!row.collapsing) continue;
                messages.delete(row.notification);
                row.slot.destroy();
            }
            bar._popupScroll?.get_parent?.()?._bezelSyncOverflow?.();
        };
        layoutTimeline = animate(duration, list, progress => {
            emptySlot.height = emptyFrom + (emptyTarget - emptyFrom) * progress;
            for (const {row, from, target, x} of sizes) {
                row.slot.height = from + (target - from) * progress;
                if (!row.leaving) row.message.translation_x = x * (1 - progress);
            }
        }, finish);
    };
    const queueReflow = () => {
        if (pending || stopped) return;
        pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pending = 0;
            reflow();
            return GLib.SOURCE_REMOVE;
        });
    };
    const add = notification => {
        if (stopped || messages.has(notification)) return;
        const message = new MessageList.NotificationMessage(notification);
        message.y_align = Clutter.ActorAlign.START;
        message.y_expand = true;
        if (message._actionBin?.layout_manager && 'scalingEnabled' in message._actionBin.layout_manager)
            message._actionBin.layout_manager.scalingEnabled = false;
        message.set_style(`background-color: ${bar._popupGlass ? hexToRgba(bar._theme.surface, 0.24) : bar._theme.surface}; color: ${bar._theme.fg}; border-radius: 16px;`);
        if (message._header) message._header.set_style(`color: ${bar._theme.muted};`);
        message._header?.closeButton.set_style(`color: ${bar._theme.fg}; background-color: ${bar._theme.bg}; border-radius: 12px;`);
        styleActions(message, bar._theme, {glass: !!bar._popupGlass});
        const slot = new St.Widget({name: 'bezel-notification-slot', layout_manager: new Clutter.BinLayout(), x_expand: true,
            clip_to_allocation: true, height: 0});
        slot.add_child(message);
        const row = {notification, message, slot, time: timestamp(notification), sequence: sequence++,
            entering: true, leaving: false, collapsing: false};
        messages.set(notification, row);
        // Use GNOME's final expanded layout; our slot and frame share the reveal
        // timing instead of competing with its independent preferred-height tween.
        for (const method of ['expand', 'unexpand']) {
            const native = message[method].bind(message);
            message[method] = () => { if (stopped || row.leaving) return; native(false); queueReflow(); };
        }
        message.connect_after('close', () => {
            if (stopped || row.leaving) return;
            row.leaving = true;
            message.reactive = false;
            const from = message.translation_x;
            const duration = motionDuration(bar);
            animate(Math.round(duration / 2), message, progress => {
                message.translation_x = from + (message.width + 48 - from) * progress;
            }, () => {
                row.collapsing = true;
                reflow(duration);
            });
        });
        notification.connectObject('notify::title', queueReflow, 'notify::body', queueReflow,
            'notify::gicon', queueReflow, 'action-added', queueReflow, 'action-removed', queueReflow,
            'notify::datetime', () => { row.time = timestamp(notification); queueReflow(); }, message);
        list.insert_child_at_index(slot, orderedRows().indexOf(row));
        if (motionDuration(bar)) message.translation_x = 48;
        queueReflow();
    };
    const sources = new Set();
    const watch = source => {
        if (stopped || sources.has(source)) return;
        sources.add(source);
        source.notifications.forEach(add);
        source.connectObject('notification-added', (_source, notification) => add(notification),
            'destroy', () => sources.delete(source), box);
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (pending) GLib.source_remove(pending);
        pending = 0;
        for (const timeline of timelines) timeline.stop();
        timelines.clear();
        layoutTimeline = null;
        bar._notificationControllers.delete(controller);
    };
    const controller = {stop, get moving() { return timelines.size > 0; }};
    bar._notificationControllers ??= new Set();
    bar._notificationControllers.add(controller);
    box._preparePopup = () => { if (pending) GLib.source_remove(pending); pending = 0; reflow(0); };
    box.connect('destroy', stop);
    bar._popupCleanups.push(stop);
    Main.messageTray.getSources().forEach(watch);
    Main.messageTray.connectObject('source-added', (_tray, source) => watch(source), box);
    return box;
}

function styleActions(message, theme, options = {}) {
    message._header?.expandButton?.set_style(`color: ${theme.fg}; background-color: ${theme.bg}; border-radius: 12px;`);
    const tracked = new Map();
    const apply = () => {
        const buttons = message._buttonBox?.get_children() ?? [];
        buttons.forEach((button, index) => {
            // Override the shell theme's individual button rounding for the
            // whole joined row, including interior actions and single actions.
            const corners = options.corners?.() ?? [12, 12];
            const left = index === 0 ? corners[0] : 0;
            const right = index === buttons.length - 1 ? corners[1] : 0;
            if (!tracked.has(button)) {
                const entry = {style: button.get_style(), hover: button.track_hover, signals: []};
                tracked.set(button, entry);
                button.track_hover = true;
                for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
                    entry.signals.push(button.connect(signal, () => entry.feedback()));
                entry.signals.push(button.connect('destroy', () => tracked.delete(button)));
            }
            const entry = tracked.get(button);
            entry.feedback = () => {
                const active = button.hover || button.has_key_focus();
                const background = active ? hexToRgba(theme.accent, options.glass ? 0.16 : 0.25)
                    : options.glass ? hexToRgba(theme.bg, 0.12) : theme.bg;
                button.set_style(`color: ${theme.fg}; background-color: ${background}; min-height: 24px; padding: 10px 8px; border-radius: 0 0 ${right}px ${left}px; border: none; box-shadow: none;`);
            };
            entry.feedback();
        });
    };
    apply();
    const notification = message.notification;
    const signals = ['action-added', 'action-removed'].map(signal => notification?.connect(signal, apply)).filter(Boolean);
    let notificationAlive = !!notification;
    if (notification) signals.push(notification.connect('destroy', () => { notificationAlive = false; }));
    let stopped = false;
    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        if (notificationAlive) signals.forEach(id => notification.disconnect(id));
        for (const [button, entry] of tracked) {
            entry.signals.forEach(id => button.disconnect(id));
            button.track_hover = entry.hover;
            button.set_style(entry.style);
        }
        tracked.clear();
    };
    message.connect('destroy', cleanup);
    cleanup.refresh = apply;
    return cleanup;
}
