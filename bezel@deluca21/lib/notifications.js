import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import {settingChoice} from './config.js';

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
        this.layer = new Clutter.Actor({reactive: false, layout_manager: new Clutter.FixedLayout(),
            x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
        this.tray.add_child(this.layer);
        this.bin.set_style('padding: 0; margin: 0;');
        this.signals = [
            this.bin.connect('child-added', (_bin, child) => this.decorate(child)),
            this.bin.connect('notify::allocation', () => this.position()),
            this.tray.connect('notify::allocation', () => this.position()),
            this.bin.connect('notify::y', () => this.position()),
            this.bin.connect('notify::opacity', () => { this.layer.opacity = this.bin.opacity; }),
        ];
        for (const child of this.bin.get_children()) this.decorate(child);
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

    position() {
        if (!this.bin || this.positioning) return;
        this.positioning = true;
        try {
            const banner = this.records.keys().next().value;
            if (!banner?.has_allocation() || !this.layer.has_allocation()) return;
            const [bx, by] = banner.get_transformed_position();
            const [width, height] = banner.get_transformed_size();
            if (![bx, by, width, height].every(Number.isFinite) || width < 1 || height < 1) return;
            const corner = this._corner();
            const gap = this.framed ? 0 : 12;
            const left = corner.endsWith('left');
            const bottom = corner.startsWith('bottom');
            const x = left
                ? this.monitor.x + this.sides.left + gap
                : this.monitor.x + this.monitor.width - this.sides.right - gap - width;
            const y = bottom
                ? this.monitor.y + this.monitor.height - this.sides.bottom - gap - height - this.bin.y
                : this.monitor.y + this.sides.top + gap + this.bin.y;
            this.tray.bannerAlignment = left ? Clutter.ActorAlign.START : Clutter.ActorAlign.END;
            this.bin.translation_x += x - bx;
            this.bin.translation_y += y - by;
            this.layer.opacity = this.bin.opacity;
            this.frame?.setNotification({
                width, height, corner, edge: bottom ? 'bottom' : 'top',
                progress: Math.max(0, Math.min(1, (height + this.bin.y) / Math.max(1, height))),
            });
        } finally { this.positioning = false; }
    }

    decorate(banner) {
        if (!(banner instanceof St.Widget) || this.records.has(banner))
            return;
        if (!banner.has_style_class_name('notification-banner')) {
            const id = banner.connect('notify::style-class', () => {
                banner.disconnect(id);
                this.decorate(banner);
            });
            return;
        }
        const record = {style: banner.get_style(), corners: [], parts: []};
        record.destroy = banner.connect('destroy', () => {
            for (const area of record.corners) area.destroy();
            this.records.delete(banner);
            this.frame?.setNotification(null);
        });
        this.records.set(banner, record);
        const radii = {
            'top-right': `0 0 0 ${this.radius}px`,
            'top-left': `0 0 ${this.radius}px 0`,
            'bottom-right': `${this.radius}px 0 0 0`,
            'bottom-left': `0 ${this.radius}px 0 0`,
        };
        this._bannerStyle(banner, record, radii);
        for (const [actor, style] of [[banner._header, `color: ${this.theme.muted};`],
            [banner._header?.closeButton, `color: ${this.theme.fg}; background-color: ${this.theme.surface}; border-radius: 12px;`]]) {
            if (!actor) continue;
            record.parts.push([actor, actor.get_style()]);
            actor.set_style(style);
        }
        this.position();
    }

    // The frame actor is hidden while a monitor is fullscreen, so a banner
    // joined to that frame would have nothing behind it.
    _frameOpen() {
        const actor = this.frame?.actor;
        if (!this.framed || !actor?.visible)
            return false;
        const index = this.monitor?.index;
        if (index == null)
            return true;
        return !global.display.get_monitor_in_fullscreen(index);
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
        banner.set_style(`${record.style ? `${record.style};` : ''} margin: 0; background-color: ${open ? 'transparent' : this.theme.bg}; color: ${this.theme.fg}; border: none; border-radius: ${open ? (radii ?? joined)[corner] : `${this.radius}px`}; box-shadow: ${open ? 'none' : '0 3px 10px rgba(0,0,0,0.22)'};`);
    }

    restyle() {
        for (const [banner, record] of this.records)
            this._bannerStyle(banner, record);
    }

    setHistoryOpen(open) {
        // Presentation only: never alter GNOME's global notification queue gate.
        if (!this.bin || Boolean(open) === Boolean(this.historyOpen)) return;
        this.historyOpen = Boolean(open);
        if (open) this.wasVisible = this.bin.visible;
        this.bin.visible = open ? false : this.wasVisible ?? true;
    }

    destroy() {
        this.setHistoryOpen(false);
        this.frame?.setNotification(null);
        if (!this.bin) return;
        this.tray.disconnect(this.sourceAdded);
        for (const [source, ids] of this.sourceSignals)
            ids.forEach(id => source.disconnect(id));
        this.sourceSignals.clear();
        for (const timer of this.deliveryTimers) GLib.source_remove(timer);
        this.deliveryTimers.clear();
        for (const [index, id] of this.signals.entries())
            (index === 2 ? this.tray : this.bin).disconnect(id);
        this.layer?.destroy();
        for (const [banner, record] of this.records) {
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
    const empty = new St.Label({text: 'No notifications', style: `color: ${bar._theme.muted}; padding: 20px;`});
    box.add_child(empty);
    const messages = new Map();
    const fitHistory = () => {
        bar._popupLockedHeight = false;
        const fit = () => {
            if ((!embedded && bar._popoutId !== 'notifications') || !bar._popout)
                return;
            bar._popupLockedHeight = false;
            bar._fitPopup();
        };
        fit();
        bar._later?.('_historyFitId', 60, fit);
    };
    const add = notification => {
        if (messages.has(notification)) return;
        const message = new MessageList.NotificationMessage(notification);
        // Reserve the complete action row while its reveal scales. Otherwise a
        // scrolling BoxLayout can allocate the scaled minimum and clip labels.
        if (message._actionBin?.layout_manager && 'scalingEnabled' in message._actionBin.layout_manager)
            message._actionBin.layout_manager.scalingEnabled = false;
        message.set_style(`background-color: ${bar._theme.surface}; color: ${bar._theme.fg}; border-radius: 16px;`);
        if (message._header) message._header.set_style(`color: ${bar._theme.muted};`);
        message._header?.closeButton.set_style(`color: ${bar._theme.fg}; background-color: ${bar._theme.bg}; border-radius: 12px;`);
        styleActions(message, bar._theme);
        messages.set(notification, message);
        const shrinkHistory = () => {
            if (!messages.delete(notification))
                return;
            // Closing the drawer destroys these views. The scroll adjustment is
            // already gone by then, so only refit while the shade is open.
            if ((!embedded && bar._popoutId !== 'notifications') || !bar._popout)
                return;
            empty.visible = messages.size === 0;
            bar._popupScroll?.get_parent?.()?._bezelSyncOverflow?.();
            fitHistory();
        };
        message.connect_after('close', () => {
            message.destroy();
            shrinkHistory();
        });
        message.connect('destroy', shrinkHistory);
        box.insert_child_at_index(message, 1);
        empty.hide();
        bar._popupScroll?.get_parent?.()?._bezelSyncOverflow?.();
        fitHistory();
    };
    const sources = new Set();
    const watch = source => {
        if (sources.has(source)) return;
        sources.add(source);
        source.notifications.forEach(add);
        source.connectObject('notification-added', (_source, notification) => add(notification), box);
    };
    Main.messageTray.getSources().forEach(watch);
    Main.messageTray.connectObject('source-added', (_tray, source) => watch(source), box);
    return box;
}

function styleActions(message, theme) {
    message._header?.expandButton?.set_style(`color: ${theme.fg}; background-color: ${theme.bg}; border-radius: 12px;`);
    const apply = () => {
        for (const button of message._buttonBox?.get_children() ?? [])
            button.set_style(`color: ${theme.fg}; background-color: ${theme.bg}; min-height: 24px; padding: 10px 8px;`);
    };
    apply();
    message.notification?.connectObject('action-added', apply, message);
}
