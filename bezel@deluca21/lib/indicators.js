import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Core GNOME controls already have Bezel equivalents. Only adopt extension roles.
const CORE = new Set(['activities', 'appMenu', 'dateMenu', 'quickSettings', 'a11y', 'a11yMenu', 'keyboard', 'dwellClick', 'screenRecording', 'screenSharing', 'remoteAccess']);

function stripColor(style) {
    return `${style ?? ''}`.replace(/(?:^|;)\s*color\s*:[^;]*/gi, '').replace(/^;+/, '').trim();
}

export class IndicatorBridge {
    constructor(bar) {
        this.bar = bar;
        this.records = new Map();
        this.signals = [];
        this.icons = new Map();
        this.containers = new Map();
        this.verticalLayouts = new Map();
        this.host = new St.BoxLayout({
            orientation: bar._actor.orientation, style_class: 'bezel-indicators',
            style: `color: ${bar._theme.fg};`, x_align: Clutter.ActorAlign.CENTER,
        });
        this.host.connect('destroy', () => {
            this.destroyed = true;
            if (this.pending) GLib.source_remove(this.pending);
            this.pending = 0;
        });
        const parent = bar._zones.end;
        if (bar._state.kind === 'dock')
            bar._dockContent.add_child(this.host);
        else
            this._placeHost(parent);
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
            for (const signal of ['child-added', 'child-removed'])
                this.signals.push([box, box.connect(signal, () => this.queueSync())]);
        }
        this.sync();
    }

    gap() {
        return this.bar._overlay._settings.get_int('indicator-spacing');
    }

    _placeHost(parent) {
        const before = this.bar._overlay._settings.get_string('indicator-side') === 'before';
        const index = this.bar._vertical
            ? (before ? parent.get_n_children() : 0)
            : (before ? 0 : parent.get_n_children());
        parent.insert_child_at_index(this.host, index);
    }

    queueSync() {
        if (this.pending || this.destroyed || this._syncing) return;
        this.pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.pending = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    sync() {
        if (this.destroyed || this._syncing) return;
        this._syncing = true;
        let changed = false;
        try {
            for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
                if (CORE.has(role) || this.records.has(indicator)) continue;
                const actor = indicator.container;
                const parent = actor?.get_parent();
                if (![Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox].includes(parent)) continue;
                const record = {role, actor, visible: actor.visible, parent, index: parent.get_children().indexOf(actor), menu: null, menuSignal: 0};
                record.destroySignal = indicator.connect('destroy', () => {
                    this.records.delete(indicator);
                    this.queueSync();
                });
                record.visibilitySignal = actor.connect('notify::visible', () => {
                    if (!this.destroyed && this.bar._overlay._settings.get_strv('hidden-indicators').includes(role) && actor.visible)
                        actor.hide();
                });
                record.menuSetSignal = indicator.connect('menu-set', () => this.configureMenu(indicator, record));
                this.records.set(indicator, record);
                parent.remove_child(actor);
                this.host.add_child(actor);
                actor._bezelRole = role;
                record.dragCleanup = this.bar._dragItem(actor, () => this.host.get_children().filter(child => child.visible && !child._bezelGap), ordered => {
                    this.bar._overlay._settings.set_strv('indicator-order', ordered.map(child => child._bezelRole));
                });
                record.layout = [actor, indicator].filter((item, index, list) => list.indexOf(item) === index).map(item => ({
                    actor: item, style: item.get_style?.(), x: item.x_align, y: item.y_align, expand: item.x_expand,
                }));
                this.prepare(actor);
                this.configureMenu(indicator, record);
                changed = true;
            }
            const settings = this.bar._overlay._settings;
            const hidden = settings.get_strv('hidden-indicators');
            for (const record of this.records.values()) {
                if (hidden.includes(record.role)) record.actor.hide();
            }
            const order = settings.get_strv('indicator-order');
            const rank = role => { const i = order.indexOf(role); return i < 0 ? order.length : i; };
            const records = [...this.records.values()].sort((a, b) => rank(a.role) - rank(b.role));
            records.forEach((record, index) => this.host.set_child_at_index(record.actor, index));
            const roles = records.map(record => record.role);
            if (JSON.stringify(settings.get_strv('known-indicators')) !== JSON.stringify(roles))
                settings.set_strv('known-indicators', roles);
            this.host.set_style(`color: ${this.bar._theme.fg};`);
            this.spaceChildren();
            this.host.visible = this.records.size > 0;
            this.bar._indicatorMenuOpen = [...this.records.values()].some(record => record.menu?.isOpen);
            if (changed)
                this.bar._place();
        } finally {
            this._syncing = false;
        }
    }

    prepare(actor) {
        if (!actor || actor._bezelGap)
            return;
        if (actor instanceof St.Icon && !this.icons.has(actor)) {
            const record = {size: actor.icon_size, style: actor.get_style(), x: actor.x_align};
            record.destroy = actor.connect('destroy', () => this.icons.delete(actor));
            this.icons.set(actor, record);
        }
        this.compact(actor);
        if (actor instanceof St.Icon) {
            const record = this.icons.get(actor);
            const requested = this.bar._overlay._settings.get_int('indicator-icon-size');
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const available = Math.max(1, this.bar._actor.width - this.bar._actor.get_theme_node().get_horizontal_padding());
            const size = this.bar._vertical ? Math.min(requested, this.bar._state.iconSize, Math.floor(available / scale)) : requested;
            actor.icon_size = size;
            if (this.bar._vertical) actor.x_align = Clutter.ActorAlign.CENTER;
            actor.set_style(`${stripColor(record?.style)}; icon-size: ${size}px; width: ${size}px; height: ${size}px; color: ${this.bar._theme.fg};`);
        }
        if (this.bar._vertical && actor !== this.host && !this.verticalLayouts.has(actor) &&
            (actor instanceof St.Label || (actor instanceof St.BoxLayout &&
                actor.get_children().some(child => child instanceof St.Label || child.clutter_text)))) {
            const saved = {x: actor.x_align, orientation: actor.orientation,
                width: actor.width_set ? actor.width : -1};
            if (actor instanceof St.BoxLayout) {
                actor.orientation = Clutter.Orientation.VERTICAL;
                actor.x_align = Clutter.ActorAlign.CENTER;
            } else {
                saved.ellipsize = actor.clutter_text.ellipsize;
                saved.alignment = actor.clutter_text.line_alignment;
                actor.width = Math.max(1, this.bar._actor.width - 12);
                actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                actor.clutter_text.line_alignment = Pango.Alignment.CENTER;
                actor.x_align = Clutter.ActorAlign.CENTER;
                actor.set_style(`${stripColor(actor.get_style())}; color: ${this.bar._theme.fg};`);
            }
            saved.destroy = actor.connect('destroy', () => this.verticalLayouts.delete(actor));
            this.verticalLayouts.set(actor, saved);
        }
        if (!this.containers.has(actor) && actor !== this.host) {
            const added = actor.connect('child-added', (_parent, child) => {
                if (!this._syncing && !child._bezelGap)
                    this.prepare(child);
            });
            const destroyed = actor.connect('destroy', () => this.containers.delete(actor));
            this.containers.set(actor, [added, destroyed]);
        }
        for (const child of actor.get_children())
            this.prepare(child);
    }

    compact(actor) {
        actor.x_align = Clutter.ActorAlign.CENTER;
        actor.y_align = Clutter.ActorAlign.CENTER;
        actor.x_expand = false;
        actor.set_style?.(`${stripColor(actor.get_style?.())}; min-width: 0; min-height: 0; padding: 0; -minimum-hpadding: 0; -natural-hpadding: 0; color: ${this.bar._theme.fg};`);
    }

    spaceChildren() {
        const gap = this.gap();
        for (const spacer of this.host.get_children().filter(child => child._bezelGap))
            this.host.remove_child(spacer);
        const kids = this.host.get_children().filter(child => child.visible && child._bezelRole);
        kids.forEach((child, index) => {
            child.margin_top = child.margin_bottom = child.margin_left = child.margin_right = 0;
            if (index >= kids.length - 1 || gap <= 0)
                return;
            const spacer = new St.Widget({
                reactive: false, x_expand: false, y_expand: false,
                width: this.bar._vertical ? 1 : gap,
                height: this.bar._vertical ? gap : 1,
            });
            spacer._bezelGap = true;
            this.host.insert_child_above(spacer, child);
        });
        if (this.bar._vertical) {
            const cap = Math.max(12, this.bar._actor.width - 8);
            this.host.x_align = Clutter.ActorAlign.CENTER;
            this.host.x_expand = false;
            for (const record of this.records.values()) {
                if (record.actor.width > cap) {
                    record.railWidth ??= record.actor.width_set ? record.actor.width : -1;
                    record.actor.width = cap;
                }
            }
        }
    }

    configureMenu(indicator, record) {
        this.restoreMenu(record);
        const menu = indicator.menu;
        if (!menu) return;
        record.menu = menu;
        record.arrowSide = menu._boxPointer?._userArrowSide;
        menu._boxPointer?.updateArrowSide?.({left: St.Side.LEFT, right: St.Side.RIGHT, top: St.Side.TOP, bottom: St.Side.BOTTOM}[this.bar._state.edge]);
        record.menuSignal = menu.connect('open-state-changed', () => {
            this.bar._indicatorMenuOpen = [...this.records.values()].some(item => item.menu?.isOpen);
            if (menu.isOpen) {
                this.bar._close();
                if (this.bar._state.autohide) this.bar._slide(true, true);
            } else if (this.bar._state.autohide) {
                this.bar._slideLater();
            }
        });
    }

    restoreMenu(record) {
        if (!record.menu) return;
        if (record.menuSignal) record.menu.disconnect(record.menuSignal);
        record.menuSignal = 0;
        record.menu.close();
        if (record.arrowSide !== undefined)
            record.menu._boxPointer?.updateArrowSide?.(record.arrowSide);
        record.menu = null;
    }

    destroy() {
        this.destroyed = true;
        if (this.pending) GLib.source_remove(this.pending);
        this.pending = 0;
        for (const [object, id] of this.signals) object.disconnect(id);
        for (const [actor, ids] of this.containers)
            for (const id of ids) actor.disconnect(id);
        this.containers.clear();
        for (const [icon, record] of this.icons) {
            icon.disconnect(record.destroy);
            icon.icon_size = record.size;
            icon.x_align = record.x;
            icon.set_style(record.style);
        }
        this.icons.clear();
        for (const [actor, saved] of this.verticalLayouts) {
            actor.disconnect(saved.destroy);
            actor.x_align = saved.x;
            if (actor instanceof St.BoxLayout)
                actor.orientation = saved.orientation;
            else {
                actor.width = saved.width;
                actor.clutter_text.ellipsize = saved.ellipsize;
                actor.clutter_text.line_alignment = saved.alignment;
            }
        }
        this.verticalLayouts.clear();
        for (const [indicator, record] of this.records) {
            record.dragCleanup?.();
            for (const item of record.layout ?? []) {
                item.actor.set_style?.(item.style);
                item.actor.x_align = item.x;
                item.actor.y_align = item.y;
                item.actor.x_expand = item.expand;
            }
            record.actor.margin_top = record.actor.margin_bottom = record.actor.margin_left = record.actor.margin_right = 0;
            if (record.railWidth >= 0)
                record.actor.width = record.railWidth;
            else if (record.railWidth === -1)
                record.actor.width_set = false;
            this.restoreMenu(record);
            record.actor.disconnect(record.visibilitySignal);
            record.actor.visible = record.visible;
            indicator.disconnect(record.destroySignal);
            indicator.disconnect(record.menuSetSignal);
            if (record.actor.get_parent() === this.host) {
                this.host.remove_child(record.actor);
                record.parent.insert_child_at_index(record.actor, Math.min(record.index, record.parent.get_n_children()));
            }
        }
        this.records.clear();
        this.host.destroy();
    }
}
