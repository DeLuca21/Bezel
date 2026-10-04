import {shortcutEditor} from './shortcutEditor.js';
import {moduleType} from './moduleIdentity.js';
import {FEATURE_OPTIONS, NUMBER_OPTIONS} from './moduleFeatures.js';
import {buildGroupEditor} from './groupEditor.js';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {readBars, saveBars, barGroups, groupAppearance, barAppearancePreset, isSpacer, spacerLabel, applyPreset, presetBars, EDGES, DATE_FORMATS, barDateFormat, barTimeFormat, settingChoice, settingFlag, MODULE_SWITCHES, switchOn, hoverEnabled, sliderLayout, powerLayout, powerDim, PANEL_MODULES, hexColor} from './config.js';
import {PRESETS, resolveTheme} from './theme.js';
import {layoutPreview} from './layoutPreview.js';
import {savedLayouts, saveLayout, restoreLayout, deleteLayout, matchingLayout, layoutIsClean, captureCleanLayout, rememberLayout, noteRevertedLayout} from './profiles.js';
import {LOGOS} from './logos.js';
import {MODULES, addBar, removeBar, addModule, removeModule, patchBar, setFloating, setKind,
    createGroup, deleteGroup, assignGroup, resizeSpacer, reorderModule, moveModule, undoPreset, setCustomColor, patchModule, patchGroup,
    shortcutLabel, acceleratorFromEvent, assignShortcut, useRecommendedShortcuts,
    indicatorNames, setIndicatorShown, moveIndicator} from './settingsModel.js';

const MODULE_NOTES = {
    window: 'The app you are using right now. Clicking it on the bar focuses that window.',
};

const vertical = (spacing = 12, props = {}) => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing, ...props});
const horizontal = (spacing = 8, props = {}) => new Gtk.Box({spacing, ...props});
const label = (text, css = '', props = {}) => {
    const widget = new Gtk.Label({label: text, xalign: 0, wrap: true, ...props});
    if (css) widget.add_css_class(css);
    return widget;
};
const clear = box => { while (box.get_first_child()) box.remove(box.get_first_child()); };
const nameOf = id => isSpacer(id) ? spacerLabel(id) : (MODULES.find(([key]) => key === moduleType(id))?.[1] ?? id) + (id.includes('@') ? ` ${id.split('@')[1]}` : '');
const titleCase = value => value[0].toUpperCase() + value.slice(1);
const button = (text, callback, css = '', props = {}) => {
    const widget = new Gtk.Button({label: text, ...props});
    if (css) widget.add_css_class(css);
    widget.connect('clicked', callback);
    return widget;
};
const flow = (max = 4) => new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, hexpand: true,
    min_children_per_line: 1, max_children_per_line: max, row_spacing: 8, column_spacing: 8});
const boundsOf = (widget, ancestor) => {
    try {
        const result = widget.compute_bounds(ancestor);
        const rect = Array.isArray(result) ? (result[0] ? result[1] : null) : result;
        if (!rect) return null;
        return {
            x: rect.x ?? rect.get_x?.() ?? 0,
            y: rect.y ?? rect.get_y?.() ?? 0,
            width: rect.width ?? rect.get_width?.() ?? 0,
            height: rect.height ?? rect.get_height?.() ?? 0,
        };
    } catch {
        return null;
    }
};
const stringValue = text => {
    const value = new GObject.Value();
    value.init(GObject.TYPE_STRING);
    value.set_string(text);
    return value;
};
const scroller = child => new Gtk.ScrolledWindow({child, hscrollbar_policy: Gtk.PolicyType.NEVER,
    vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, hexpand: true, vexpand: true});
const REMOTE_METADATA = 'https://raw.githubusercontent.com/DeLuca21/Bezel/master/bezel@deluca21/metadata.json';
const UPDATE_COMMANDS = [
    'rm -rf /tmp/bezel-install',
    'git clone --depth 1 https://github.com/DeLuca21/Bezel.git /tmp/bezel-install',
    'mkdir -p ~/.local/share/gnome-shell/extensions',
    'rm -rf ~/.local/share/gnome-shell/extensions/bezel@deluca21',
    'cp -a /tmp/bezel-install/bezel@deluca21 ~/.local/share/gnome-shell/extensions/',
    'glib-compile-schemas --strict ~/.local/share/gnome-shell/extensions/bezel@deluca21/schemas',
    'rm -rf /tmp/bezel-install',
];
const textOf = contents => new TextDecoder().decode(contents instanceof Uint8Array ? contents
    : typeof contents.toArray === 'function' ? contents.toArray() : contents.get_data());
const versionParts = value => String(value || '').split('.').map(part => {
    const number = parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
});
const versionDelta = (local, remote) => {
    const left = versionParts(local);
    const right = versionParts(remote);
    const count = Math.max(left.length, right.length);
    for (let i = 0; i < count; i++) {
        const diff = (right[i] || 0) - (left[i] || 0);
        if (diff) return diff;
    }
    return 0;
};

export class SettingsWindow {
    constructor(application, settings, directory) {
        this.settings = settings;
        this.directory = directory;
        this.mode = 'bar';
        this.barIndex = 0;
        this.barTab = 'contents';
        this.moduleId = null;
        this.window = new Adw.ApplicationWindow({application, title: 'Bezel Settings', modal: false, resizable: true});
        this.window.add_css_class('bezel-settings');
        const monitor = this.window.get_display().get_monitors().get_item(0)?.get_geometry();
        this.window.set_default_size(Math.min(1120, Math.round((monitor?.width ?? 1280) * .8)),
            Math.min(860, Math.round((monitor?.height ?? 900) * .8)));
        this.css = new Gtk.CssProvider();
        Gtk.StyleContext.add_provider_for_display(this.window.get_display(), this.css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);
        this._build();
        this.changed = settings.connect('changed', (_settings, key) => {
            if (this.writing) return;
            if (key === 'group-preview' || key === 'layout-baseline') return;
            if (key === 'preferences-group') { this.groupId = settings.get_string(key) || null; this.mode = 'bar'; }
            if (key === 'preferences-bar') {
                const index = settings.get_int(key);
                if (index >= 0) { this.barIndex = index; this.mode = 'bar'; this.moduleId = null; }
            }
            this._queueRefresh();
        });
        this.window.connect('close-request', () => {
            this._closeItemPopover();
            settings.disconnect(this.changed);
            settings.set_int('preferences-bar', -1);
            settings.set_string('preferences-group', '');
            settings.set_string('group-preview', '');
            this.versionCancel?.cancel();
            if (this.refreshId) GLib.source_remove(this.refreshId);
            if (this.cardId) GLib.source_remove(this.cardId);
            if (this.laneId) GLib.source_remove(this.laneId);
            this.refreshId = this.cardId = this.laneId = 0;
            Gtk.StyleContext.remove_provider_for_display(this.window.get_display(), this.css);
            return false;
        });
        this._refresh();
    }

    open(index = -1) {
        if (index >= 0) { this.barIndex = index; this.mode = 'bar'; }
        this.groupId = this.settings.get_string('preferences-group') || null;
        try {
            const target = JSON.parse(this.settings.get_string('preferences-target') || '{}');
            if (['bar', 'look', 'frame', 'shortcuts', 'opening', 'desktop'].includes(target.page)) this.mode = target.page;
            if (['contents', 'size', 'appearance', 'apps'].includes(target.tab)) this.barTab = target.tab;
        } catch {}
        this._refresh();
        this._checkVersion();
        this.window.present();
    }

    _write(action, rebuild = true) {
        const wasWriting = this.writing;
        this.writing = true;
        try { action(); } finally { this.writing = wasWriting; }
        this.monitor.queue_draw();
        this._status();
        if (rebuild) this._queueRefresh();
    }

    _queueRefresh() {
        if (this.refreshId) return;
        this.refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _build() {
        const root = vertical(0);
        const header = new Adw.HeaderBar({title_widget: new Gtk.Box()});
        const brand = horizontal(10);
        const icon = Gtk.Image.new_from_file(`${this.directory}/icons/bezel.png`);
        icon.pixel_size = 28;
        brand.append(icon);
        brand.append(label('Bezel', 'brand'));
        header.pack_start(brand);
        this.editButton = button('Edit bars', () => {
            const next = !this.settings.get_boolean('edit-mode');
            this.editButton.label = next ? 'Done editing' : 'Edit bars';
            if (next) this.editButton.add_css_class('is-on');
            else this.editButton.remove_css_class('is-on');
            this._write(() => this.settings.set_boolean('edit-mode', next), false);
        });
        header.pack_end(this.editButton);
        root.append(header);
        const content = vertical(14, {margin_top: 8, margin_bottom: 18, margin_start: 18, margin_end: 18, vexpand: true});
        this.presets = horizontal(10, {homogeneous: true});
        for (const [id, name] of [['caelestia', 'Bezel'], ['panel', 'Panel'], ['dock', 'Dock'], ['hybrid', 'Top + dock'], ['islands', 'Islands'], ['split', 'Split']]) {
            const body = vertical(6);
            body.append(layoutPreview(this.settings, presetBars(id), id === 'caelestia', 96));
            body.append(label(name, '', {xalign: .5}));
            const card = new Gtk.Button({child: body, hexpand: true});
            card.add_css_class('preset-card');
            card.connect('clicked', () => this._confirmLayout(() => this._write(() => {
                const favorites = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('favorite-apps');
                applyPreset(this.settings, id, favorites);
                rememberLayout(this.settings);
                this.barIndex = 0; this.moduleId = null; this.mode = 'bar';
            })));
            this.presets.append(card);
        }
        content.append(this.presets);
        const saved = horizontal(8);
        this.saveName = new Gtk.Entry({placeholder_text: 'Name this layout', width_chars: 17, max_width_chars: 20});
        saved.append(this.saveName);
        const save = button('Save', () => this._save(), 'accent');
        saved.append(save);
        this.saveName.connect('activate', () => this._save());
        this.savedChips = horizontal(8);
        const savedScroll = new Gtk.ScrolledWindow({child: this.savedChips, hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER});
        saved.append(savedScroll);
        this.undo = button('Undo', () => this._confirmLayout(() => this._write(() => {
            undoPreset(this.settings);
            noteRevertedLayout(this.settings);
        })));
        saved.append(this.undo);
        this.savedRow = saved;
        content.append(saved);
        const body = horizontal(16, {vexpand: true});
        const sidebar = vertical(12, {width_request: 260});
        this.monitor = this._monitor();
        sidebar.append(this.monitor);
        this.selectionLabel = label('', 'muted');
        sidebar.append(this.selectionLabel);
        this.paletteButton = new Gtk.Button();
        this.paletteButton.connect('clicked', () => this.choose('look'));
        sidebar.append(this.paletteButton);
        this.nav = vertical(6);
        sidebar.append(this.nav);
        this.status = label('', 'muted');
        sidebar.append(this.status);
        this.sidebarScroll = new Gtk.ScrolledWindow({child: sidebar, hexpand: true, vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        const meta = this._metadata();
        this.versionButton = button(meta['version-name'] || 'About', () => this._about(), 'version-tag',
            {halign: Gtk.Align.START, tooltip_text: 'About Bezel'});
        this.side = vertical(8, {width_request: 260, vexpand: true});
        this.side.append(this.sidebarScroll);
        this.side.append(this.versionButton);
        body.append(this.side);
        this.card = vertical(14, {hexpand: true, valign: Gtk.Align.START});
        this.card.add_css_class('editor-card');
        this.editorScroll = scroller(this.card);
        body.append(this.editorScroll);
        content.append(body);
        root.append(content);
        this.window.set_content(root);
    }

    choose(mode, index = this.barIndex) {
        if (this.groupId) { this.groupId = null; this.groupPreviewOpen = false; this.settings.set_string('group-preview', ''); this.settings.set_string('preferences-group', ''); }
        this.mode = mode;
        this.barIndex = index;
        this.moduleId = null;
        this.editorScroll.vadjustment.value = 0;
        this._refresh();
    }

    _captureCleanLayout() {
        const wasWriting = this.writing;
        this.writing = true;
        try { captureCleanLayout(this.settings); }
        finally { this.writing = wasWriting; }
    }

    _status() {
        this._captureCleanLayout();
        const profile = matchingLayout(this.settings);
        if (!layoutIsClean(this.settings))
            this.status.label = 'Unsaved layout changes\nChanges apply live to your desktop.';
        else if (profile)
            this.status.label = `Saved as “${profile.name}”`;
        else
            this.status.label = 'Changes apply live to your desktop.';
    }

    _loadCss() {
        const theme = resolveTheme(this.settings);
        this.css.load_from_string(`
            window.bezel-settings { background: ${theme.bg}; color: ${theme.fg}; }
            .bezel-settings headerbar { background: transparent; box-shadow: none; padding: 6px 12px; }
            .bezel-settings .brand { color: ${theme.accent}; font-weight: 800; font-size: 23px; }
            .bezel-settings label { color: inherit; }
            .bezel-settings .muted { color: ${theme.muted}; font-size: 12px; }
            .bezel-settings button.version-tag,
            .bezel-settings button.version-tag:hover {
                background: transparent; background-image: none; border-color: transparent; box-shadow: none;
                padding: 2px 0; min-height: 0;
            }
            .bezel-settings button.version-tag label { color: ${theme.muted}; font-size: 12px; }
            .bezel-settings button.version-tag:hover label,
            .bezel-settings button.version-tag.has-update label { color: ${theme.accent}; }
            .bezel-settings linkbutton { background: transparent; border: none; box-shadow: none; padding: 0; min-height: 0; }
            .bezel-settings linkbutton label { color: ${theme.accent}; }
            .bezel-settings .heading { font-size: 21px; font-weight: 750; }
            .bezel-settings .subheading { font-size: 14px; font-weight: 700; }
            .bezel-settings button { background-color: ${theme.bg}; color: ${theme.fg}; background-image: none; border-radius: 14px; border: 1px solid transparent; box-shadow: none; padding: 9px 12px; min-height: 18px; }
            .bezel-settings button:hover { border-color: ${theme.accent}; }
            .bezel-settings windowcontrols { border-spacing: 4px; margin: 0 2px; padding: 0; }
            .bezel-settings windowcontrols > button,
            .bezel-settings windowcontrols > button:hover,
            .bezel-settings windowcontrols button,
            .bezel-settings windowcontrols button:hover {
                background-color: transparent; background-image: none; border: none; box-shadow: none;
                padding: 0; margin: 0; min-width: 22px; min-height: 22px; border-radius: 999px;
            }
            .bezel-settings button.is-on,
            .bezel-settings button.is-on:hover,
            .bezel-settings button.accent {
                background-color: ${theme.accent}; color: ${theme.bg}; background-image: none; border-color: transparent;
            }
            .bezel-settings .preset-card { background: ${theme.surface}; padding: 7px; border-radius: 19px; }
            .bezel-settings .editor-card { background: ${theme.surface}; padding: 20px; border-radius: 24px; }
            .bezel-settings .lane, .bezel-settings .inset { background: ${theme.bg}; border-radius: 16px; padding: 12px; }
            .bezel-settings .module-chip { background: ${theme.surface}; }
            .bezel-settings .group { border: 1px solid ${theme.border}; border-radius: 15px; padding: 10px; }
            .bezel-settings .drop-hover { box-shadow: inset 0 0 0 2px ${theme.accent}; }
            .bezel-settings .group-title { color: ${theme.accent}; font-size: 12px; font-weight: 700; }
            .bezel-settings .segment { background: ${theme.bg}; padding: 4px; border-radius: 16px; }
            .bezel-settings .segment button { padding: 7px 10px; }
            .bezel-settings entry, .bezel-settings spinbutton, .bezel-settings dropdown > button { background: ${theme.bg}; color: ${theme.fg}; border-radius: 12px; border: none; box-shadow: none; }
            .bezel-settings entry { padding: 7px 10px; }
            .bezel-settings spinbutton button { padding: 5px 9px; }
            .bezel-settings flowboxchild { padding: 0; background: transparent; }
            .bezel-settings popover contents { background: ${theme.surface}; color: ${theme.fg}; border-radius: 18px; }
            .bezel-settings scale highlight { background: ${theme.accent}; }
            .bezel-settings .palette-row { padding: 8px 12px; }
            .bezel-settings button.palette-row.is-on label { color: ${theme.bg}; }
            .bezel-settings popover.item-options { padding: 2px; }
        `);
        this.presets?.queue_draw();
        const themeNow = resolveTheme(this.settings);
        const palette = horizontal(8);
        palette.append(this._swatches(themeNow, 20));
        palette.append(label(themeNow.name, '', {hexpand: true}));
        this.paletteButton?.set_child(palette);
    }

    _refresh() {
        this._syncGroupEditorChrome();
        this._loadCss();
        const bars = readBars(this.settings);
        this.barIndex = Math.max(0, Math.min(this.barIndex, bars.length - 1));
        this.writing = true;
        this.settings.set_int('preferences-bar', this.mode === 'bar' ? this.barIndex : -1);
        this.writing = false;
        this.monitor.queue_draw();
        this.editButton.label = this.settings.get_boolean('edit-mode') ? 'Done editing' : 'Edit bars';
        this.editButton.remove_css_class('is-on');
        if (this.settings.get_boolean('edit-mode')) this.editButton.add_css_class('is-on');
        this.selectionLabel.label = this.mode === 'bar' ? `${titleCase(bars[this.barIndex].edge)} ${bars[this.barIndex].kind} selected` : 'Click a bar to edit · + adds a bar';
        clear(this.nav);
        for (const [id, title] of [['frame', 'Screen border'], ['shortcuts', 'Shortcuts'], ['opening', 'Opening & motion'], ['desktop', 'Desktop']])
            this.nav.append(button(title, () => this.choose(id), this.mode === id ? 'is-on' : '', {halign: Gtk.Align.FILL}));
        clear(this.savedChips);
        for (const profile of savedLayouts(this.settings)) {
            const chip = horizontal(0);
            chip.append(button(profile.name, () => this._confirmLayout(() => this._write(() => {
                try { restoreLayout(this.settings, profile); this.moduleId = null; }
                catch (error) { this._message('Could not load layout', error.message); }
            }))));
            chip.append(button('×', () => this._message('Delete saved layout?', `Delete “${profile.name}”? Your current desktop will stay as it is.`, () => this._write(() => deleteLayout(this.settings, profile.name))), '', {tooltip_text: `Delete ${profile.name}`}));
            this.savedChips.append(chip);
        }
        this.undo.sensitive = Boolean(this.settings.get_string('previous-layout'));
        this._status();
        const token = `${this.mode}:${this.barIndex}:${this.barTab}`;
        const reveal = this.revealModule;
        this.revealModule = false;
        const position = token === this.scrollToken && !reveal ? this.editorScroll.vadjustment.value : 0;
        this.scrollToken = token;
        clear(this.card);
        ({bar: () => this.groupId ? buildGroupEditor(this, bars[this.barIndex]) : this._barCard(bars[this.barIndex]), look: () => this._paletteCard(), frame: () => this._frameCard(),
            shortcuts: () => this._shortcutCard(), opening: () => this._openingCard(), desktop: () => this._desktopCard()})[this.mode]?.();
        this._holdScroll(position, false);
    }

    _holdScroll(position, revealEnd) {
        const adjustment = this.editorScroll.vadjustment;
        if (this._scrollWatch) {
            adjustment.disconnect(this._scrollWatch);
            this._scrollWatch = 0;
        }
        const apply = () => {
            const max = Math.max(0, adjustment.upper - adjustment.page_size);
            adjustment.value = revealEnd ? max : Math.min(position, max);
        };
        this._scrollWatch = adjustment.connect('notify::upper', apply);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            apply();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                apply();
                if (this._scrollWatch) {
                    adjustment.disconnect(this._scrollWatch);
                    this._scrollWatch = 0;
                }
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncGroupEditorChrome() {
        const editing = Boolean(this.groupId && this.mode === 'bar');
        for (const widget of [this.presets, this.savedRow, this.side, this.editButton])
            if (widget) widget.visible = !editing;
    }

    _refreshCard() {
        this._syncGroupEditorChrome();
        this._closeItemPopover();
        const bars = readBars(this.settings);
        const position = this.editorScroll.vadjustment.value;
        clear(this.card);
        this.lanes = null;
        ({bar: () => this.groupId ? buildGroupEditor(this, bars[this.barIndex]) : this._barCard(bars[this.barIndex]), look: () => this._paletteCard(), frame: () => this._frameCard(),
            shortcuts: () => this._shortcutCard(), opening: () => this._openingCard(), desktop: () => this._desktopCard()})[this.mode]?.();
        this._holdScroll(position, false);
        this.monitor.queue_draw();
    }

    _queueCard() {
        if (this.cardId) return;
        this.cardId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.cardId = 0;
            if (!this.refreshId) this._refreshCard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueLanes(openId = null) {
        this.pendingItem = openId;
        if (this.laneId) return;
        this.laneId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.laneId = 0;
            this._refreshLanes();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshLanes() {
        this._closeItemPopover();
        const bar = readBars(this.settings)[this.barIndex];
        if (!this.lanes || this.mode !== 'bar' || this.barTab !== 'contents' || !bar) {
            this.pendingItem = null;
            this._refreshCard();
            return;
        }
        this._fillLanes(bar);
        const id = this.pendingItem;
        this.pendingItem = null;
        const chip = id ? this.moduleChips.get(id) : null;
        const item = id ? bar.modules.find(module => module.id === id) : null;
        if (chip && item) this._itemPopover(chip, item);
    }

    _markChoice(widget) {
        const parent = widget.get_parent();
        const box = parent instanceof Gtk.FlowBoxChild ? parent.get_parent() : parent;
        let child = box?.get_first_child();
        while (child) {
            const choice = child instanceof Gtk.FlowBoxChild ? child.get_child() : child;
            if (choice instanceof Gtk.Button) {
                if (choice === widget) choice.add_css_class('is-on');
                else choice.remove_css_class('is-on');
            }
            child = child.get_next_sibling();
        }
    }

    _closeItemPopover() {
        const popover = this.itemPopover;
        this.itemPopover = null;
        this.itemAnchor = null;
        if (!popover) return;
        if (popover instanceof Gtk.Window) popover.close();
        else { popover.popdown(); if (popover.get_parent()) popover.unparent(); }
    }

    _monitor() {
        const area = new Gtk.DrawingArea({content_width: 250, content_height: 184, hexpand: true});
        let hits = [];
        area.set_draw_func((_area, cr, width, height) => {
            const theme = resolveTheme(this.settings);
            const color = hex => { const rgba = new Gdk.RGBA(); rgba.parse(hex); cr.setSourceRGBA(rgba.red, rgba.green, rgba.blue, 1); };
            const rect = (x, y, w, h, radius, fill) => {
                const r = Math.min(radius, w / 2, h / 2);
                cr.newSubPath(); cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
                cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
                cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
                cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5); cr.closePath(); color(fill); cr.fill();
            };
            rect(2, 2, width - 4, height - 4, 16, this.settings.get_boolean('show-frame') ? theme.accent : theme.border);
            rect(5, 5, width - 10, height - 10, 13, theme.surface);
            rect(width * .25, height * .28, width * .5, height * .42, 8, theme.bg);
            const bars = readBars(this.settings);
            hits = [];
            for (const edge of EDGES) {
                const index = bars.findIndex(bar => bar.edge === edge);
                const bar = bars[index];
                const vert = ['left', 'right'].includes(edge);
                const t = bar ? 34 : 24;
                const margin = bar?.margin ? 12 : 5;
                const length = bar ? bar.kind === 'dock' ? .54 : Math.max(.45, bar.length / 100) : .22;
                const w = vert ? t : (width - 12) * length;
                const h = vert ? (height - 12) * length : t;
                const x = vert ? edge === 'left' ? margin : width - t - margin : (width - w) / 2;
                const y = vert ? (height - h) / 2 : edge === 'top' ? margin : height - t - margin;
                const selected = this.mode === 'bar' && index === this.barIndex;
                rect(x, y, w, h, 8, selected ? theme.accent : theme.bg);
                color(selected ? theme.bg : theme.fg);
                cr.setFontSize(bar ? 11 : 18);
                const text = bar ? titleCase(edge) : '+';
                const extents = cr.textExtents(text);
                cr.moveTo(x + (w - extents.width) / 2 - extents.xBearing, y + (h - extents.height) / 2 - extents.yBearing);
                cr.showText(text);
                hits.push({x, y, w, h, edge, index});
            }
        });
        const click = new Gtk.GestureClick();
        click.connect('released', (_gesture, _count, x, y) => {
            const hit = hits.findLast(item => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
            if (!hit) { this.choose('frame'); return; }
            if (hit.index >= 0) this.choose('bar', hit.index);
            else this._write(() => { if (addBar(this.settings, hit.edge)) { this.barIndex = readBars(this.settings).length - 1; this.mode = 'bar'; } });
        });
        area.add_controller(click);
        area.tooltip_text = 'Select a bar, add one with +, or click the screen to edit the border';
        return area;
    }

    _segments(choices, current, apply, persist = true) {
        const box = horizontal(4, {homogeneous: true});
        box.add_css_class('segment');
        const widgets = new Map();
        const mark = id => {
            for (const [key, widget] of widgets) {
                if (key === id) widget.add_css_class('is-on');
                else widget.remove_css_class('is-on');
            }
        };
        for (const [id, title] of choices) {
            const widget = button(title, () => {
                mark(id);
                if (persist) this._write(() => apply(id), false);
                else apply(id);
            }, id === current ? 'is-on' : '', {hexpand: true});
            widgets.set(id, widget);
            box.append(widget);
        }
        return box;
    }

    _toggle(title, value, callback) {
        const widget = button(title, () => {
            const next = !widget.has_css_class('is-on');
            if (next) widget.add_css_class('is-on');
            else widget.remove_css_class('is-on');
            this._write(() => callback(next), false);
        }, value ? 'is-on' : '');
        widget._setActive = active => {
            if (active) widget.add_css_class('is-on'); else widget.remove_css_class('is-on');
        };
        return widget;
    }

    _step(title, value, min, max, step, callback) {
        const row = horizontal(10);
        row.append(label(title, '', {hexpand: true}));
        const spin = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: min, upper: max, value, step_increment: step, page_increment: step * 5}), numeric: true, valign: Gtk.Align.CENTER, width_chars: 4});
        spin.connect('value-changed', () => this._write(() => callback(spin.get_value_as_int()), false));
        row.append(spin);
        return row;
    }

    _heading(title, subtitle = '') {
        this.card.append(label(title, 'heading'));
        if (subtitle) this.card.append(label(subtitle, 'muted'));
    }

    _barCard(bar) {
        const top = horizontal(10);
        this.barTitle = label(`${titleCase(bar.edge)} ${bar.kind === 'dock' ? 'dock' : 'bar'}`, 'heading', {hexpand: true});
        top.append(this.barTitle);
        const remove = button('Remove bar', () => this._write(() => removeBar(this.settings, this.barIndex)));
        remove.sensitive = readBars(this.settings).length > 1;
        top.append(remove);
        this.card.append(top);
        this.card.append(this._segments([['one', 'One bar'], ['pills', 'Separate pills']], bar.sections === 'pills' ? 'pills' : 'one', value => {
            patchBar(this.settings, this.barIndex, {sections: value});
        }));
        this.card.append(this._segments([['panel', 'Panel'], ['dock', 'Dock']], bar.kind, value => {
            setKind(this.settings, this.barIndex, value);
            const edge = titleCase(readBars(this.settings)[this.barIndex].edge);
            this.barTitle.label = `${edge} ${value === 'dock' ? 'dock' : 'bar'}`;
            this.selectionLabel.label = `${edge} ${value} selected`;
            if (this.barTab === 'size') this._refreshCard();
        }));
        const toggles = flow(3);
        toggles.insert(this._toggle('Floating', bar.margin > 0, value => setFloating(this.settings, this.barIndex, value)), -1);
        toggles.insert(this._toggle('Autohide', bar.autohide, value => patchBar(this.settings, this.barIndex, {autohide: value})), -1);
        toggles.insert(this._toggle('Reserve space', bar.reserveSpace, value => patchBar(this.settings, this.barIndex, {reserveSpace: value})), -1);
        this.card.append(toggles);
        if (!this.settings.get_boolean('show-frame')) {
            this.card.append(this._toggle('Own colours', bar.ownColors === true, value => patchBar(this.settings, this.barIndex, {ownColors: value})));
            if (bar.ownColors)
                this._ownColours(bar);
        }
        this.card.append(this._segments([['contents', 'Contents'], ['size', 'Size & space'], ['appearance', 'Appearance'], ['apps', 'Apps']], this.barTab, value => {
            this.barTab = value;
            this._refreshCard();
        }, false));
        if (this.barTab === 'contents') this._contents(bar);
        else if (this.barTab === 'size') this._barSize(bar);
        else if (this.barTab === 'appearance') this._appearance(bar);
        else this._apps(bar);
    }

    _contents(bar) {
        this.moduleChips = new Map();
        this.card.append(label('Drag an item to move it. Click it for options.', 'muted'));
        this.card.append(this._toggle('Colour groups', bar.colourGroups === true, value => patchBar(this.settings, this.barIndex, {colourGroups: value})));
        this.card.append(button('+ Create group', () => this._nameDialog('Create a group', 'Give this group a name. You can add any modules or empty spaces.', '', name => {
            this._write(() => createGroup(this.settings, this.barIndex, name), false);
            this._queueLanes();
        }), 'accent'));
        this.lanes = vertical(12);
        this.card.append(this.lanes);
        this._fillLanes(bar);
    }

    _fillLanes(bar) {
        clear(this.lanes);
        this.moduleChips = new Map();
        const groups = barGroups(bar);
        const placeOf = item => item.group ? bar.modules.find(member => member.group === item.group)?.place ?? item.place : item.place;
        for (const place of ['start', 'center', 'end']) {
            const lane = vertical(9);
            lane.add_css_class('lane');
            lane.hexpand = true;
            const header = horizontal(8);
            header.append(label(titleCase(place), 'subheading', {hexpand: true}));
            const add = button('+', () => this._addPopover(add, bar, place), '', {tooltip_text: `Add to ${place}`});
            header.append(add); lane.append(header);
            const chips = flow(4);
            const seen = new Set();
            for (const item of bar.modules.filter(entry => placeOf(entry) === place)) {
                if (!item.group) {
                    const chip = this._moduleChip(item);
                    chip._bezelDropId = item.id;
                    chips.insert(chip, -1);
                    continue;
                }
                if (seen.has(item.group)) continue;
                seen.add(item.group);
                const groupId = item.group;
                const box = vertical(6);
                box.add_css_class('group');
                box._bezelDropId = `group:${groupId}`;
                const title = horizontal(8);
                const named = groups.find(group => group.id === groupId);
                const nameButton = button(named?.name ?? groupId, () => this._groupPopover(nameButton, named ?? {id: groupId, name: groupId}), '', {hexpand: true});
                title.append(nameButton);
                title.append(button('×', () => {
                    this._write(() => deleteGroup(this.settings, this.barIndex, groupId), false);
                    this._queueLanes();
                }, '', {tooltip_text: 'Ungroup, keeping all contents'}));
                box.append(title);
                const members = flow(3);
                for (const member of bar.modules.filter(module => module.group === groupId)) {
                    const chip = this._moduleChip(member);
                    chip._bezelDropId = member.id;
                    members.insert(chip, -1);
                }
                const addGroup = button('+', () => this._addPopover(addGroup, bar, place, groupId), '', {tooltip_text: 'Add to group'});
                members.insert(addGroup, -1);
                box.append(members);
                box._members = members;
                chips.insert(box, -1);
            }
            for (const group of groups.filter(entry => !bar.modules.some(item => item.group === entry.id) && entry.place === place)) {
                const row = horizontal(8);
                row.add_css_class('group');
                row._bezelDropId = `group:${group.id}`;
                row.append(label(`${group.name} · empty`, 'group-title', {hexpand: true}));
                const add = button('+', () => this._addPopover(add, bar, place, group.id), '', {tooltip_text: 'Add to group'});
                row.append(add);
                row.append(button('×', () => {
                    this._write(() => deleteGroup(this.settings, this.barIndex, group.id), false);
                    this._queueLanes();
                }, '', {tooltip_text: 'Remove empty group'}));
                chips.insert(row, -1);
            }
            if (!chips.get_first_child()) chips.insert(label('Drop-in space for your modules', 'muted'), -1);
            lane.append(chips);
            this._bindDrop(lane, chips, place);
            this.lanes.append(lane);
        }
    }

    _moduleChip(item) {
        const text = isSpacer(item.id) ? `↔ ${item.size} px` : nameOf(item.id);
        const chip = button(text, () => {
            if (chip._suppressClick || this._clickClosed(chip)) return;
            this._itemPopover(chip, item);
        }, 'module-chip', {tooltip_text: `Drag to move ${nameOf(item.id)}, or click for options`});
        this._bindDrag(chip, item.id);
        this.moduleChips.set(item.id, chip);
        return chip;
    }

    _bindDrag(chip, id) {
        const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE, propagation_phase: Gtk.PropagationPhase.CAPTURE});
        drag.connect('prepare', () => Gdk.ContentProvider.new_for_value(stringValue(id)));
        drag.connect('drag-begin', () => {
            chip._suppressClick = true;
            this._closeItemPopover();
        });
        drag.connect('drag-end', () => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            chip._suppressClick = false;
            return GLib.SOURCE_REMOVE;
        }));
        chip.add_controller(drag);
    }

    _bindDrop(lane, chips, place) {
        const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        const highlight = (x, y) => {
            lane.remove_css_class('drop-hover');
            let child = chips.get_first_child?.();
            while (child) {
                child.get_child?.()?.remove_css_class('drop-hover');
                child = child.get_next_sibling?.();
            }
            const target = this._groupUnder(chips, lane, x, y) ?? lane;
            target.add_css_class('drop-hover');
        };
        drop.connect('enter', (_target, x, y) => {
            highlight(x, y);
            return Gdk.DragAction.MOVE;
        });
        drop.connect('motion', (_target, x, y) => {
            highlight(x, y);
            return Gdk.DragAction.MOVE;
        });
        drop.connect('leave', () => {
            lane.remove_css_class('drop-hover');
            let child = chips.get_first_child?.();
            while (child) {
                child.get_child?.()?.remove_css_class('drop-hover');
                child = child.get_next_sibling?.();
            }
        });
        drop.connect('drop', (_target, value, x, y) => {
            lane.remove_css_class('drop-hover');
            const text = typeof value === 'string' ? value : value?.get_string?.() ?? '';
            if (text) this._dropOnLane(text, place, chips, lane, x, y);
            return true;
        });
        lane.add_controller(drop);
    }

    _groupUnder(chips, lane, x, y) {
        const point = this._into(chips, lane, x, y);
        for (let i = 0; ; i++) {
            const child = chips.get_child_at_index(i);
            if (!child)
                return null;
            const widget = child.get_child?.();
            if (!widget?._bezelDropId?.startsWith('group:'))
                continue;
            const rect = boundsOf(child, chips);
            if (rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height)
                return widget;
        }
    }

    _dropOnLane(id, place, chips, lane, x, y) {
        const group = this._groupUnder(chips, lane, x, y);
        if (group) {
            const members = group._members;
            const groupId = group._bezelDropId.slice(6);
            if (!members) {
                this._applyDrop(id, place, groupId, '');
                return;
            }
            const point = this._into(members, lane, x, y);
            this._applyDrop(id, place, groupId, this._dropBefore(members, point.x, point.y, id));
            return;
        }
        const point = this._into(chips, lane, x, y);
        this._applyDrop(id, place, '', this._dropBefore(chips, point.x, point.y, id));
    }

    _into(widget, ancestor, x, y) {
        const rect = boundsOf(widget, ancestor);
        return rect ? {x: x - rect.x, y: y - rect.y} : {x, y};
    }

    _dropBefore(container, x, y, dragId) {
        if (!container?.get_child_at_index)
            return '';
        for (let i = 0; ; i++) {
            const child = container.get_child_at_index(i);
            if (!child)
                return '';
            const id = child.get_child?.()?._bezelDropId || '';
            if (!id || id === dragId)
                continue;
            const rect = boundsOf(child, container);
            if (!rect)
                continue;
            const within = y >= rect.y && y < rect.y + rect.height;
            if (y < rect.y || (within && x < rect.x + rect.width / 2))
                return id;
        }
    }

    _applyDrop(id, place, group, beforeId) {
        this._write(() => moveModule(this.settings, this.barIndex, id, {place, group, beforeId}), false);
        this._queueLanes();
    }

    _clickClosed(anchor) {
        const closed = anchor._popoverClosedAt ?? 0;
        return closed > 0 && GLib.get_monotonic_time() - closed < 250000;
    }

    _trackPopover(anchor, popover) {
        popover.connect('closed', () => { anchor._popoverClosedAt = GLib.get_monotonic_time(); });
    }

    _addPopover(anchor, bar, place, group = '') {
        if (this._clickClosed(anchor)) return;
        const popover = new Gtk.Popover();
        popover.set_parent(anchor);
        const box = vertical(6, {margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        box.append(label(group ? 'Add or move into group' : `Add to ${titleCase(place)}`, 'subheading'));
        if (!group) box.append(button('Create group', () => {
            popover.popdown();
            this._nameDialog('Create a group', `This group sits in ${titleCase(place)}.`, '', name => {
                this._write(() => createGroup(this.settings, this.barIndex, name, [], place), false);
                this._queueLanes();
            });
        }));
        const finish = target => { popover.popdown(); this._queueLanes(target); };
        const add = (id, text) => box.append(button(text, () => {
            let target = id;
            this._write(() => {
                const before = new Set(readBars(this.settings)[this.barIndex].modules.map(item => item.id));
                addModule(this.settings, this.barIndex, id, place);
                target = readBars(this.settings)[this.barIndex].modules.find(item => !before.has(item.id))?.id;
                if (group && target) assignGroup(this.settings, this.barIndex, target, group);
            }, false);
            finish(target);
        }));
        add('spacer', '↔ Empty space');
        for (const [id, title] of MODULES) add(id, title);
        if (group) for (const item of bar.modules.filter(item => isSpacer(item.id) && item.group !== group))
            box.append(button(`Move ${spacerLabel(item.id)} · ${item.size} px`, () => {
                this._write(() => assignGroup(this.settings, this.barIndex, item.id, group), false);
                finish(item.id);
            }));
        const scroll = new Gtk.ScrolledWindow({child: box, min_content_width: 220, max_content_height: 350, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER});
        popover.set_child(scroll);
        this._trackPopover(anchor, popover);
        popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { if (popover.get_parent()) popover.unparent(); return GLib.SOURCE_REMOVE; }));
        popover.popup();
    }

    _itemPopover(anchor, item) {
        if (this.itemAnchor === anchor && this.itemPopover) {
            this._closeItemPopover();
            return;
        }
        this._closeItemPopover();
        const bar = readBars(this.settings)[this.barIndex];
        const live = bar.modules.find(module => module.id === item.id) ?? item;
        const placeOf = module => module.group ? bar.modules.find(member => member.group === module.group)?.place ?? module.place : module.place;
        const current = {...live, place: placeOf(live)};
        const popover = new Gtk.Popover({autohide: false});
        popover.set_parent(anchor);
        popover.add_css_class('item-options');

        anchor.add_css_class('is-on');
        this.itemPopover = popover;
        this.itemAnchor = anchor;
        const box = vertical(10, {margin_top: 10, margin_bottom: 10, margin_start: 12, margin_end: 12, width_request: 260});
        const header = horizontal(8);
        header.append(label(nameOf(current.id), 'subheading', {hexpand: true}));
        header.append(button('×', () => this._closeItemPopover()));
        header.append(button('Remove', () => {
            this._write(() => removeModule(this.settings, this.barIndex, current.id), false);
            this._queueLanes();
        }));
        box.append(header);
        const note = MODULE_NOTES[moduleType(current.id)] ?? (isSpacer(current.id) ? 'A gap. Set its width, then where it sits on the bar.' : '');
        if (note) box.append(label(note, 'muted'));
        box.append(label('On the bar', 'subheading'));
        box.append(this._segments(['start', 'center', 'end'].map(id => [id, titleCase(id)]), current.place, place => {
            const bars = readBars(this.settings);
            const target = bars[this.barIndex];
            target.modules = target.modules.map(module => module.id === current.id || (current.group && module.group === current.group) ? {...module, place} : module);
            if (current.group)
                target.groups = barGroups(target).map(group => group.id === current.group ? {...group, place} : group);
            saveBars(this.settings, bars);
            this._queueLanes(current.id);
        }));
        const groups = [['', 'Ungrouped'], ...barGroups(bar).map(group => [group.id, group.name])];
        const groupRow = horizontal(8);
        groupRow.append(label('Group', '', {hexpand: true}));
        const group = new Gtk.DropDown({model: Gtk.StringList.new(groups.map(([, name]) => name)), selected: Math.max(0, groups.findIndex(([id]) => id === (current.group || '')))});
        let groupReady = false;
        group.connect('notify::selected', () => {
            if (!groupReady) return;
            const next = groups[group.selected]?.[0] ?? '';
            if (next === (current.group || '')) return;
            this._write(() => assignGroup(this.settings, this.barIndex, current.id, next), false);
            this._queueLanes(current.id);
        });
        groupRow.append(group);
        box.append(groupRow);
        if (isSpacer(current.id)) box.append(this._step('Width', current.size, 8, 400, 4, size => {
            resizeSpacer(this.settings, this.barIndex, current.id, size);
            const chip = this.moduleChips.get(current.id);
            if (chip) chip.label = `↔ ${size} px`;
        }));
        const reorder = horizontal(8);
        const peers = current.group
            ? bar.modules.filter(module => module.group === current.group)
            : bar.modules.filter(module => !module.group && module.place === current.place);
        const index = peers.findIndex(module => module.id === current.id);
        for (const [delta, title] of [[-1, '← Earlier'], [1, 'Later →']]) {
            const next = index + delta;
            const move = button(title, () => {
                this._write(() => reorderModule(this.settings, this.barIndex, current.id, delta), false);
                this._queueLanes(current.id);
            }, '', {hexpand: true});
            move.sensitive = next >= 0 && next < peers.length;
            reorder.append(move);
        }
        box.append(reorder);
        this._moduleOptions(box, current, bar);
        popover.set_child(new Gtk.ScrolledWindow({child: box, max_content_height: 560, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));

        popover.connect('closed', () => {
            anchor._popoverClosedAt = GLib.get_monotonic_time();
            if (anchor.get_parent()) anchor.remove_css_class('is-on');
            if (this.itemPopover === popover) { this.itemPopover = null; this.itemAnchor = null; }
            if (popover.get_parent()) popover.unparent();
        });
        const escape = new Gtk.EventControllerKey();
        escape.connect('key-pressed', (_controller, key) => { if (key !== Gdk.KEY_Escape) return false; this._closeItemPopover(); return true; });
        popover.add_controller(escape);
        popover.popup();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { groupReady = true; return GLib.SOURCE_REMOVE; });
    }

    _featureOptions(box, current, write) {
        const id = moduleType(current.id);
        const bar = readBars(this.settings)[this.barIndex];
        const effective = key => key === 'powerIcons' ? current.powerIcons ?? (powerLayout(current, this.settings) === 'rail')
            : key === 'showSeconds' ? current.showSeconds ?? bar?.clockSeconds === true : current[key];
        for (const [key, [title, fallback]] of Object.entries(FEATURE_OPTIONS[id] || {})) {
            // Custom layouts contain separate time, date and calendar items.
            // Automatic-popout composition settings do not apply there.
            if (this.groupId && id === 'clock' && key !== 'showSeconds') continue;
            if (id === 'clock' && key === 'calendarTime') box.append(label('Automatic calendar popout', 'subheading'));
            box.append(this._toggle(title, key === 'powerIcons' && current.powerStyle ? current.powerStyle === 'rail' : effective(key) ?? fallback, value => write(key === 'powerIcons' ? {powerIcons: value, powerStyle: value ? 'rail' : 'list'} : {[key]: value})));
        }
        for (const [key, [title, fallback, min, max]] of Object.entries(NUMBER_OPTIONS[id] || {}))
            box.append(this._step(title, current[key] ?? fallback, min, max, 1, value => write({[key]: value})));
        if (id === 'shelf') {
            box.append(label('Dragging files out', 'subheading'));
            box.append(this._segments([['copy', 'Copy'], ['move', 'Move'], ['ask', 'Destination decides']], current.shelfDragAction || 'copy', value => write({shelfDragAction: value})));
            box.append(label('Moving is handled by the destination app. Removing an entry from the shelf never deletes the original file.', 'muted'));
        }
        if (id !== 'shortcuts') return;
        box.append(shortcutEditor(this, current, write));
    }

    _moduleOptions(box, current, bar, writeOverride = null) {
        const bindings = [];
        const toggleFor = (key, title, apply) => {
            const widget = this._toggle(title, switchOn(current, bar, key), apply);
            bindings.push([widget, key]); return widget;
        };
        const write = values => {
            Object.assign(current, values);
            for (const [widget, key] of bindings) widget._setActive(switchOn(current, bar, key));
            if (writeOverride) writeOverride(values);
            else this._write(() => patchModule(this.settings, this.barIndex, current.id, values), false);
        };
        this._featureOptions(box, current, write);
        const id = moduleType(current.id);
        if (['volume', 'microphone'].includes(id))
            box.append(toggleFor('showMute', 'Show mute button', value => write({showMute: value})));
        if (['network', 'bluetooth'].includes(id))
            box.append(toggleFor('showToggle', 'Show on/off button', value => write({showToggle: value})));
        const switches = id === 'volume' || id === 'network' ? null : MODULE_SWITCHES[id];
        if (switches) {
            box.append(label(id === 'microphone' ? 'Bar and popout' : 'On the bar', 'subheading'));
            for (const [key, title] of switches)
                box.append(toggleFor(key, title, value => {
                    const values = {[key]: value};
                    if (['showIcon', 'showValue', 'showArt'].includes(key)) {
                        const next = {...current, ...values};
                        const icon = key === 'showIcon' ? value : switchOn(next, bar, 'showIcon');
                        const reading = key === 'showValue' ? value : switchOn(next, bar, 'showValue');
                        const art = key === 'showArt' ? value : switchOn(next, bar, 'showArt');
                        if (!icon && !reading && !art)
                            values.showIcon = true;
                    }
                    write(values);
                    if (!writeOverride) this._queueLanes(current.id);
                }));
        }
        if (id === 'workspaces')
            box.append(this._segments([['pills', 'Pills'], ['numbers', 'Numbers'], ['icons', 'App icons']], current.workspaceStyle || 'pills', value => {
                write({workspaceStyle: value});
            }));
        if (id === 'volume') {
            box.width_request = 300;
            box.append(label('On the bar', 'subheading'));
            for (const [key, title] of [['showIcon', 'Icon'], ['showValue', 'Percentage']])
                box.append(toggleFor(key, title, value => {
                    const values = {[key]: value};
                    const next = {...current, ...values};
                    const icon = key === 'showIcon' ? value : switchOn(next, bar, 'showIcon');
                    const reading = key === 'showValue' ? value : switchOn(next, bar, 'showValue');
                    if (!icon && !reading)
                        values.showIcon = true;
                    write(values);
                    if (!writeOverride) this._queueLanes(current.id);
                }));
            box.append(label('In the popout', 'subheading'));
            for (const [key, title] of [['popIcon', 'Icon'], ['popValue', 'Percentage'], ['brightIcon', 'Brightness icon'], ['brightValue', 'Brightness percentage']])
                box.append(toggleFor(key, title, value => {
                    write({[key]: value});
                }));
            if (!this.groupId) {
            box.append(label('Automatic popout arrangement', 'subheading'));
            box.append(this._segments([['edge', 'Side by side'], ['stack', 'Stacked'], ['drawer', 'In drawer']], sliderLayout(current, this.settings), value => {
                write({sliderStyle: value});
            }));
            }
        }
        if (id === 'network') {
            box.append(label('On the bar', 'subheading'));
            for (const [key, title] of [['showIcon', 'Icon'], ['showValue', 'Name']])
                box.append(toggleFor(key, title, value => {
                    const values = {[key]: value};
                    const next = {...current, ...values};
                    const icon = key === 'showIcon' ? value : switchOn(next, bar, 'showIcon');
                    const reading = key === 'showValue' ? value : switchOn(next, bar, 'showValue');
                    if (!icon && !reading)
                        values.showIcon = true;
                    write(values);
                    if (!writeOverride) this._queueLanes(current.id);
                }));
            box.append(label('In the popout', 'subheading'));
            box.append(this._toggle('Name', switchOn(current, bar, 'popValue'), value => {
                write({popValue: value});
            }));
        }
        if (id === 'indicators')
            this._indicatorOptions(box);
        if (id === 'clock')
            this._formatChoices(bar, box, 'time', false);
        if (id === 'date')
            this._formatChoices(bar, box, 'date');
        if (id === 'logo')
            this._logoOptions(box, bar);
        if (id === 'power' && !this.groupId) {
            box.width_request = 340;
            box.append(this._toggle('Dim the desktop', powerDim(current, this.settings), value => {
                write({sessionDim: value});
            }));
            box.append(label('Where it opens', 'subheading'));
            box.append(this._spotGrid('power-position'));
        }
        if (!current.group && (PANEL_MODULES.has(id) || ['screenshot', 'dnd', 'nightlight', 'dark', 'awake'].includes(id)))
            box.append(this._toggle('Open on hover', hoverEnabled(current, null, this.settings), value => {
                write({hover: value});
            }));
    }

    _groupPopover(anchor, group) {
        if (this._clickClosed(anchor)) return;
        const popover = new Gtk.Popover();
        popover.set_parent(anchor);
        const bar = readBars(this.settings)[this.barIndex];
        const live = barGroups(bar).find(item => item.id === group.id) ?? group;
        const members = bar.modules.filter(item => item.group === live.id);
        const hovering = typeof live.hover === 'boolean' ? live.hover : members.some(item => hoverEnabled(item, null, this.settings)) || !members.length;
        const box = vertical(8, {margin_top: 10, margin_bottom: 10, margin_start: 12, margin_end: 12, width_request: 240});
        box.append(button('Edit popout layout…', () => {
            popover.popdown(); this.groupId = live.id;
            this.writing = true; this.settings.set_string('preferences-group', live.id); this.writing = false;
            this._queueCard();
        }));
        box.append(button('Rename', () => {
            popover.popdown();
            this._nameDialog('Rename group', 'This name is only a label.', live.name, name => {
                this._write(() => patchGroup(this.settings, this.barIndex, live.id, {name}), false);
                this._queueLanes();
            }, 'Rename');
        }));
        box.append(this._toggle('Open on hover', hovering, value => {
            this._write(() => patchGroup(this.settings, this.barIndex, live.id, {hover: value}), false);
        }));
        box.append(label('Colour', 'subheading'));
        const customRow = vertical(6);
        const showCustom = () => {
            clear(customRow);
            const saved = barGroups(readBars(this.settings)[this.barIndex]).find(item => item.id === live.id);
            if (saved?.color !== 'custom')
                return;
            const current = hexColor(saved.custom) || resolveTheme(this.settings).group;
            customRow.append(this._colorChoice(current, hex => {
                this._write(() => patchGroup(this.settings, this.barIndex, live.id, {color: 'custom', custom: hex}), false);
            }));
        };
        box.append(this._segments([['', 'Follow bar'], ['plain', 'Plain'], ['theme', 'Theme'], ['accent', 'Accent'], ['custom', 'Custom']], live.color || '', value => {
            const values = value ? {color: value} : {color: ''};
            this._write(() => patchGroup(this.settings, this.barIndex, live.id, values), false);
            showCustom();
        }));
        box.append(customRow);
        showCustom();
        box.append(label('Group shape', 'subheading'));
        const appearance = groupAppearance(live, bar);
        for (const [key, title, max] of [['padding', 'End padding', 32], ['inset', 'Side padding', 12],
            ['rounding', 'Corner rounding', 48], ['opacity', 'Opacity (%)', 100]])
            box.append(this._step(title, appearance[key], 0, max, key === 'opacity' ? 5 : 1,
                value => this._write(() => patchGroup(this.settings, this.barIndex, live.id, {[key]: value}), false)));
        box.append(button('Use bar shape defaults', () => {
            this._write(() => patchGroup(this.settings, this.barIndex, live.id,
                {padding: undefined, inset: undefined, rounding: undefined, opacity: undefined}), false);
            popover.popdown();
        }));
        popover.set_child(box);
        this._trackPopover(anchor, popover);
        popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { if (popover.get_parent()) popover.unparent(); return GLib.SOURCE_REMOVE; }));
        popover.popup();
    }

    _ownColours(bar) {
        const theme = resolveTheme(this.settings);
        for (const [key, title, fallback] of [['ownSurface', 'Surface', theme.surface], ['ownAccent', 'Accent', theme.accent]])
            this.card.append(this._barColorRow(title, hexColor(bar[key]) || fallback, hex => patchBar(this.settings, this.barIndex, {[key]: hex})));
    }

    _barColorRow(title, current, apply) {
        const row = horizontal(8);
        row.append(label(title, '', {hexpand: true}));
        row.append(this._barColorButton(current, apply));
        return row;
    }

    _colorChoice(current, apply) {
        const widget = button(current, () => this._pickColor(widget._hex || current, hex => {
            apply(hex);
            try {
                widget._hex = hex;
                widget.label = hex;
            } catch {
                /* The menu may already have closed around the colour dialog. */
            }
        }));
        widget._hex = current;
        return widget;
    }

    _pickColor(current, apply) {
        const color = new Gdk.RGBA();
        color.parse(current);
        const dialog = new Gtk.ColorDialog({with_alpha: false, title: 'Choose a colour'});
        dialog.choose_rgba(this.window, color, null, (_source, result) => {
            try {
                const rgba = dialog.choose_rgba_finish(result);
                const hex = `#${[rgba.red, rgba.green, rgba.blue].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;
                apply(hex);
            } catch {
                /* The colour dialog was cancelled. */
            }
        });
    }

    _barColorButton(current, apply) {
        return this._colorChoice(current, apply);
    }

    _spotGrid(key) {
        const grid = new Gtk.Grid({column_spacing: 6, row_spacing: 6, column_homogeneous: true});
        const choices = [['top-left', 'top-center', 'top-right'], ['left', 'icon', 'right'], ['bottom-left', 'bottom-center', 'bottom-right']];
        const buttons = [];
        choices.forEach((row, y) => row.forEach((id, x) => {
            const widget = button(id === 'icon' ? 'At icon' : id.split('-').map(titleCase).join(' '), () => {
                for (const other of buttons) {
                    if (other === widget) other.add_css_class('is-on');
                    else other.remove_css_class('is-on');
                }
                this._write(() => this.settings.set_string(`${key}`, id), false);
            }, this.settings.get_string(key) === id ? 'is-on' : '');
            buttons.push(widget);
            grid.attach(widget, x, y, 1, 1);
        }));
        return grid;
    }

    _logoOptions(box, bar) {
        box.width_request = 340;
        box.append(label('Opens', 'subheading'));
        box.append(this._segments([['launcher', 'Launcher'], ['overview', 'Overview'], ['apps', 'App grid']], bar.logoAction, value => {
            this._write(() => patchBar(this.settings, this.barIndex, {logoAction: value}), false);
        }));
        box.append(label('Icon', 'subheading'));
        const logos = flow(3);
        for (const [id, name] of LOGOS) {
            const widget = button(name, () => {
                this._markChoice(widget);
                this._write(() => patchBar(this.settings, this.barIndex, {logoIcon: `distro:${id}`}), false);
            }, bar.logoIcon === `distro:${id}` ? 'is-on' : '');
            logos.insert(widget, -1);
        }
        box.append(logos);
        const entry = new Gtk.Entry({text: bar.logoIcon, placeholder_text: 'Icon name or image path'});
        entry.connect('activate', () => this._write(() => patchBar(this.settings, this.barIndex, {logoIcon: entry.text}), false));
        box.append(entry);
    }

    _appearance(bar) {
        this.card.append(label('Start with a look, then adjust it below.', 'muted'));
        const presets = horizontal(8);
        for (const [id, title] of [['frame', 'In-frame dock'], ['floating', 'Floating dock'], ['minimal', 'Minimal icons']]) {
            presets.append(button(title, () => {
                const bars = readBars(this.settings);
                bars[this.barIndex] = barAppearancePreset(bars[this.barIndex], id);
                this._write(() => {
                    saveBars(this.settings, bars);
                    if (id === 'frame') this.settings.set_boolean('show-frame', true);
                });
            }, '', {hexpand: true}));
        }
        this.card.append(presets);
        if (bar.kind === 'dock' || bar.margin || bar.length < 100)
            this.card.append(this._step('Background opacity (%)', bar.barOpacity, 0, 100, 5,
                value => patchBar(this.settings, this.barIndex, {barOpacity: value})));
        else
            this.card.append(label('Attached bars share the screen frame background.', 'muted'));
        this.card.append(this._step('Bar corner rounding', bar.rounding, 0, 48, 2,
            value => patchBar(this.settings, this.barIndex, {rounding: value})));
        this.card.append(label('Colour groups', 'subheading'));
        this.card.append(this._toggle('Colour groups', bar.colourGroups, value => patchBar(this.settings, this.barIndex, {colourGroups: value})));
        for (const [key, title, max] of [['groupPadding', 'End padding', 32], ['groupInset', 'Side padding', 12],
            ['groupRounding', 'Group corner rounding', 48], ['groupOpacity', 'Group opacity (%)', 100]])
            this.card.append(this._step(title, bar[key], 0, max, key === 'groupOpacity' ? 5 : 1,
                value => patchBar(this.settings, this.barIndex, {[key]: value})));
        this.card.append(label('Individual groups can override these settings in Contents.', 'muted'));
    }

    _barSize(bar) {
        for (const [key, title, min, max, step] of [
            ['thickness', 'Thickness', 44, 88, 2], ['iconSize', 'Icon size', 12, 40, 2], ['appSpacing', 'App spacing', 0, 32, 1],
            ['length', 'Length (%)', 20, 100, 5], ['margin', 'Distance from edge', 0, 64, 2], ['rounding', 'Corner rounding', 0, 48, 2], ['reserveOffset', 'Reserved offset', 0, 64, 2],
        ]) this.card.append(this._step(title, bar[key], min, max, step, value => patchBar(this.settings, this.barIndex, {[key]: value})));
        if (bar.kind === 'dock') {
            this.card.append(this._toggle('Fit to applications', bar.fitContent, value => patchBar(this.settings, this.barIndex, {fitContent: value})));
            this.card.append(this._step('Minimum dock length', bar.dockMinLength, 64, 10000, 8, value => patchBar(this.settings, this.barIndex, {dockMinLength: value})));
        }
    }

    _apps(bar) {
        this.card.append(this._toggle('Show running applications', bar.runningApps, value => patchBar(this.settings, this.barIndex, {runningApps: value})));
        this.card.append(this._segments([['cycle', 'Cycle windows'], ['minimize', 'Minimize / restore'], ['activate', 'Activate'], ['previews', 'Window list']], bar.appClick, value => patchBar(this.settings, this.barIndex, {appClick: value})));
        this.card.append(label('Running indicator', 'subheading'));
        this.card.append(this._segments([['line', 'Line'], ['dot', 'Dot'], ['none', 'None']], bar.appIndicator,
            value => patchBar(this.settings, this.barIndex, {appIndicator: value})));
        this.card.append(label('Hover effect', 'subheading'));
        this.card.append(this._segments([['none', 'None'], ['highlight', 'Highlight'], ['lift', 'Lift'], ['both', 'Highlight + lift']], bar.appHover,
            value => patchBar(this.settings, this.barIndex, {appHover: value})));
        this.card.append(this._toggle('Press animation on click', bar.appPress, value => patchBar(this.settings, this.barIndex, {appPress: value})));
        this.card.append(label('Focused application', 'subheading'));
        this.card.append(this._segments([['none', 'None'], ['line', 'Accent line'], ['background', 'Background'], ['both', 'Line + background']], bar.appFocus,
            value => patchBar(this.settings, this.barIndex, {appFocus: value})));
        this.card.append(label('Pinned applications', 'subheading'));
        const pins = flow(3);
        for (const id of bar.pinned) pins.insert(button(`${GioUnix.DesktopAppInfo.new(id.slice(4))?.get_display_name() ?? id.slice(4)} ×`, () => {
            this._write(() => patchBar(this.settings, this.barIndex, {pinned: readBars(this.settings)[this.barIndex].pinned.filter(pin => pin !== id)}), false);
            this._queueCard();
        }), -1);
        const add = button('+ Pin an app', () => {
            const popover = new Gtk.Popover(); popover.set_parent(add);
            const box = vertical(6);
            const search = new Gtk.SearchEntry({placeholder_text: 'Find an application'}); box.append(search);
            const apps = vertical(4);
            const entries = [];
            for (const app of Gio.AppInfo.get_all().filter(app => app.should_show() && app.get_id()).sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))) {
                const widget = button(app.get_display_name(), () => { popover.popdown(); this._write(() => {
                    const current = readBars(this.settings)[this.barIndex];
                    patchBar(this.settings, this.barIndex, {pinned: [...new Set([...current.pinned, `app:${app.get_id()}`])]});
                    if (!current.modules.some(item => item.id === 'apps')) addModule(this.settings, this.barIndex, 'apps', 'start');
                }, false); this._queueCard(); });
                apps.append(widget); entries.push([widget, app.get_display_name().toLowerCase()]);
            }
            search.connect('search-changed', () => entries.forEach(([widget, title]) => { widget.visible = title.includes(search.text.toLowerCase()); }));
            box.append(new Gtk.ScrolledWindow({child: apps, min_content_width: 260, min_content_height: 280, hscrollbar_policy: Gtk.PolicyType.NEVER}));
            popover.set_child(box); popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { popover.unparent(); return GLib.SOURCE_REMOVE; })); popover.popup();
        });
        pins.insert(add, -1); this.card.append(pins);
    }

    _formatChoices(bar = null, parent = null, part = 'both', secondsControl = true) {
        const gnome = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format');
        const time = bar ? barTimeFormat(bar, gnome) : settingChoice(this.settings, 'dashboard-time-format', '24h', ['24h', '12h']);
        const seconds = bar ? bar.clockSeconds === true : settingFlag(this.settings, 'dashboard-clock-seconds');
        const date = bar ? barDateFormat(bar, this.settings) : settingChoice(this.settings, 'dashboard-date-format', 'long', Object.keys(DATE_FORMATS));
        const host = parent ?? this.card;
        if (part !== 'date') {
            host.append(label(bar ? 'Time' : 'Dashboard time', 'subheading'));
            host.append(this._segments([['24h', '24-hour'], ['12h', '12-hour']], time, value => {
                if (bar) patchBar(this.settings, this.barIndex, {timeFormat: value});
                else this.settings.set_string('dashboard-time-format', value);
            }));
            if (secondsControl) host.append(this._toggle('Show seconds', seconds, value => {
                if (bar) patchBar(this.settings, this.barIndex, {clockSeconds: value});
                else this.settings.set_boolean('dashboard-clock-seconds', value);
            }));
        }
        if (part === 'time')
            return;
        host.append(label(bar ? 'Date' : 'Dashboard date', 'subheading'));
        const dates = flow(1);
        for (const [id, format] of Object.entries(DATE_FORMATS)) {
            const widget = button(format.label, () => {
                this._markChoice(widget);
                this._write(() => {
                    if (bar) patchBar(this.settings, this.barIndex, {dateFormat: id});
                    else this.settings.set_string('dashboard-date-format', id);
                }, false);
            }, date === id ? 'is-on' : '');
            dates.insert(widget, -1);
        }
        host.append(dates);
    }

    _swatches(palette, height = 48) {
        const compact = height <= 24;
        const area = new Gtk.DrawingArea({content_height: height, content_width: compact ? 56 : 160, hexpand: !compact, valign: Gtk.Align.CENTER});
        area.set_draw_func((_area, cr, width, h) => ['bg', 'surface', 'accent', 'fg'].forEach((key, index) => {
            const color = new Gdk.RGBA(); color.parse(palette[key]);
            cr.setSourceRGBA(color.red, color.green, color.blue, 1); cr.rectangle(index * width / 4, 0, width / 4, h); cr.fill();
        }));
        return area;
    }

    _paletteCard() {
        this._heading('Colours', 'Choose a named palette. Custom opens a colour picker for each part.');
        const current = this.settings.get_string('theme');
        const custom = {id: 'custom', name: 'Custom', ...Object.fromEntries(['bg', 'surface', 'accent', 'fg'].map(key => [key, this.settings.get_string(`custom-${key}`)]))};
        const list = vertical(6);
        for (const palette of [...PRESETS, custom]) {
            const row = horizontal(10);
            row.append(this._swatches(palette, 22));
            row.append(label(palette.name, '', {hexpand: true, valign: Gtk.Align.CENTER}));
            const tile = new Gtk.Button({child: row, hexpand: true});
            tile.add_css_class('palette-row');
            if (palette.id === current) tile.add_css_class('is-on');
            const wasCustom = this.settings.get_string('theme') === 'custom';
            tile.connect('clicked', () => {
                this._markChoice(tile);
                this._write(() => this.settings.set_string('theme', palette.id), false);
                this._loadCss();
                if ((palette.id === 'custom') !== wasCustom) this._queueCard();
            });
            list.append(tile);
        }
        this.card.append(list);
        if (current !== 'custom') return;
        this.card.append(label('Make it your own', 'subheading'));
        for (const [key, title] of [['bg', 'Frame'], ['surface', 'Cards'], ['fg', 'Text'], ['muted', 'Secondary text'], ['accent', 'Accent'], ['group', 'Group accent'], ['border', 'Dividers']]) {
            const row = horizontal(8);
            row.append(label(title, '', {hexpand: true}));
            const color = new Gdk.RGBA(); color.parse(this.settings.get_string(`custom-${key}`));
            const picker = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false, title: `Choose ${title.toLowerCase()} colour`}), rgba: color});
            const entry = new Gtk.Entry({text: this.settings.get_string(`custom-${key}`), width_chars: 8, max_width_chars: 9});
            picker.connect('notify::rgba', () => {
                if (!picker._live) return;
                const rgba = picker.rgba;
                const hex = '#' + [rgba.red, rgba.green, rgba.blue].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
                this._write(() => setCustomColor(this.settings, key, hex), false);
                entry.text = this.settings.get_string(`custom-${key}`);
                this._loadCss();
            });
            row.append(picker);
            entry.connect('activate', () => {
                this._write(() => { if (!setCustomColor(this.settings, key, entry.text)) entry.add_css_class('error'); else entry.remove_css_class('error'); }, false);
                this._loadCss();
            });
            picker._live = true;
            row.append(entry); this.card.append(row);
        }
    }

    _frameCard() {
        this._heading('Screen border', 'Shape the frame around your desktop.');
        this.card.append(this._toggle('Show screen border', this.settings.get_boolean('show-frame'), value => this.settings.set_boolean('show-frame', value)));
        for (const [key, title, min, max] of [['frame-width', 'Border width', 4, 48], ['frame-radius', 'Corner radius', 0, 80], ['frame-shadow', 'Shadow', 0, 24]])
            this.card.append(this._step(title, this.settings.get_int(key), min, max, 1, value => this.settings.set_int(key, value)));
        for (const [key, title] of [['dashboard', 'Dashboard'], ['notifications', 'Notifications']]) {
            this.card.append(label(title, 'subheading'));
            this.card.append(this._spotGrid(`${key}-position`));
        }
    }

    _shortcutCard() {
        this._heading('Your shortcuts');
        this.card.append(this._segments([['overview', 'Super → Overview'], ['launcher', 'Super → Launcher']], this.settings.get_boolean('super-launcher') ? 'launcher' : 'overview', value => this.settings.set_boolean('super-launcher', value === 'launcher')));
        for (const [key, title] of [['launcher-shortcut', 'Launcher'], ['overview-shortcut', 'Overview']]) {
            const row = horizontal(8); row.append(label(title, '', {hexpand: true}));
            const current = button(shortcutLabel(this.settings.get_strv(key)[0]), () => this._captureShortcut(key, title, current));
            row.append(current);
            row.append(button('Clear', () => {
                this._write(() => this.settings.set_strv(key, []), false);
                current.label = shortcutLabel(this.settings.get_strv(key)[0]);
            }));
            this.card.append(row);
        }
        this.card.append(button('Use Super + Space for the launcher', () => {
            this._write(() => useRecommendedShortcuts(this.settings), false);
            this._queueCard();
        }, 'accent'));
        this.card.append(this._step('Launcher width', this.settings.get_int('launcher-width'), 360, 1000, 20, value => this.settings.set_int('launcher-width', value)));
        this.card.append(label('Launcher search', 'subheading'));
        this.card.append(this._segments([['ddg', 'DuckDuckGo'], ['g', 'Google'], ['w', 'Wikipedia'], ['gh', 'GitHub'], ['yt', 'YouTube']], this.settings.get_string('launcher-web-engine'), value => this.settings.set_string('launcher-web-engine', value)));
        this.card.append(this._toggle('Search files', this.settings.get_boolean('launcher-files'), value => this.settings.set_boolean('launcher-files', value)));
        const roots = new Gtk.Entry({text: this.settings.get_strv('launcher-file-roots').join('; '), placeholder_text: '~/Documents; ~/Downloads'});
        roots.connect('activate', () => this.settings.set_strv('launcher-file-roots', roots.text.split(';').map(value => value.trim()).filter(value => value.startsWith('/') || value === '~' || value.startsWith('~/'))));
        this.card.append(label('Search folders (separate with ; and press Enter)', 'caption'));
        this.card.append(roots);
        this.card.append(label('Hidden folders and symlinks are excluded. Searches cover up to 6 levels and 15,000 entries. Use a full path to browse deeper folders.', 'caption'));
        this.card.append(label('Actions > · Files / · Web ? · Commands $ · Shift+Enter uses the secondary action', 'caption'));

    }

    _captureShortcut(key, title, current = null) {
        const dialog = new Adw.Window({title: `${title} shortcut`, transient_for: this.window, modal: true, default_width: 380, default_height: 160});
        const hint = label('Press a shortcut. Escape cancels; Backspace clears.', '', {margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24});
        dialog.set_content(hint);
        dialog.connect('map', () => dialog.get_surface()?.inhibit_system_shortcuts(null));
        dialog.connect('close-request', () => { dialog.get_surface()?.restore_system_shortcuts(); return false; });
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval, _code, state) => {
            if (keyval === Gdk.KEY_Escape) { dialog.close(); return true; }
            if (keyval === Gdk.KEY_BackSpace) {
                this._write(() => this.settings.set_strv(key, []), false);
                if (current) current.label = shortcutLabel(this.settings.get_strv(key)[0]);
                dialog.close();
                return true;
            }
            const accelerator = acceleratorFromEvent(keyval, state);
            if (!accelerator) return true;
            const error = (() => {
                this.writing = true;
                try { return assignShortcut(this.settings, key, accelerator); }
                finally { this.writing = false; }
            })();
            if (error) hint.label = error;
            else {
                if (current) current.label = shortcutLabel(accelerator);
                this._status();
                dialog.close();
            }
            return true;
        });
        dialog.add_controller(keys); dialog.present();
    }

    _openingCard() {
        this._heading('Opening & motion', 'Choose what the screen edges open, and how motion feels.');
        for (const [key, title] of [['edge-panels', 'Top edge opens dashboard'], ['power-hover', 'Bottom edge opens power']])
            this.card.append(this._toggle(title, this.settings.get_boolean(key), value => this.settings.set_boolean(key, value)));
        this.card.append(this._step('Hover delay (ms)', this.settings.get_int('hover-delay'), 100, 1000, 50, value => this.settings.set_int('hover-delay', value)));
        this.card.append(this._step('Animation (ms)', this.settings.get_int('animation-duration'), 0, 800, 20, value => this.settings.set_int('animation-duration', value)));
        const motion = this.settings.get_string('layout-transition');
        this.card.append(this._segments([['none', 'Off'], ['fade', 'Fade'], ['retreat', 'Retreat']], ['none', 'fade', 'retreat'].includes(motion) ? motion : 'fade', value => this.settings.set_string('layout-transition', value)));
        this.card.append(this._step('Layout transition (ms)', this.settings.get_int('layout-transition-duration'), 0, 1600, 40, value => this.settings.set_int('layout-transition-duration', value)));
    }

    _desktopCard() {
        this._heading('Desktop');
        for (const [key, title] of [['weather-dashboard', 'Weather on dashboard'], ['hide-gnome-panel', 'Hide GNOME top bar'], ['hide-overview-dock', 'Hide Overview dock'], ['frame-notifications', 'Notifications on the frame']])
            this.card.append(this._toggle(title, this.settings.get_boolean(key), value => this.settings.set_boolean(key, value)));
        this._formatChoices(null);
    }

    _indicatorOptions(box) {
        box.width_request = 320;
        for (const [key, title, min, max] of [['indicator-icon-size', 'Icon size', 12, 40], ['indicator-spacing', 'Spacing', 0, 40]])
            box.append(this._step(title, this.settings.get_int(key), min, max, 1, value => {
                this._write(() => this.settings.set_int(key, value), false);
            }));
        const list = vertical(6);
        const fill = () => {
            clear(list);
            const names = indicatorNames(this.settings);
            if (!names.length)
                list.append(label('Extension icons appear here once they are running.', 'caption'));
            for (const name of names) {
                const row = horizontal(6);
                row.append(label(name, '', {hexpand: true}));
                const shown = !this.settings.get_strv('hidden-indicators').includes(name);
                let toggle;
                toggle = this._toggle(shown ? 'Shown' : 'Hidden', shown, value => {
                    this._write(() => setIndicatorShown(this.settings, name, value), false);
                    toggle.label = value ? 'Shown' : 'Hidden';
                });
                row.append(toggle);
                row.append(button('↑', () => {
                    this._write(() => moveIndicator(this.settings, name, -1), false);
                    fill();
                }));
                row.append(button('↓', () => {
                    this._write(() => moveIndicator(this.settings, name, 1), false);
                    fill();
                }));
                list.append(row);
            }
        };
        fill();
        box.append(list);
    }

    _save() {
        const name = this.saveName.text.trim().slice(0, 80);
        if (!name) { this.saveName.grab_focus(); return; }
        const save = () => this._write(() => saveLayout(this.settings, name));
        if (savedLayouts(this.settings).some(profile => profile.name === name))
            this._message('Replace saved layout?', `Replace “${name}” with your current settings?`, save);
        else save();
    }

    _nameDialog(title, body, initial, action, confirm = 'Create group') {
        const dialog = new Adw.AlertDialog({heading: title, body});
        const entry = new Gtk.Entry({text: initial, placeholder_text: 'Name', max_length: 60});
        dialog.extra_child = entry;
        dialog.add_response('cancel', 'Cancel'); dialog.add_response('create', confirm);
        dialog.close_response = 'cancel'; dialog.default_response = 'create';
        dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_response_enabled('create', Boolean(initial.trim()));
        entry.connect('changed', () => dialog.set_response_enabled('create', Boolean(entry.text.trim())));
        dialog.connect('response', (_dialog, response) => { if (response === 'create') action(entry.text.trim()); });
        dialog.present(this.window);
    }

    _metadata() {
        if (this.metadata) return this.metadata;
        try {
            const file = Gio.File.new_for_path(`${this.directory}/metadata.json`);
            const [, contents] = file.load_contents(null);
            this.metadata = JSON.parse(textOf(contents));
        } catch {
            this.metadata = {};
        }
        return this.metadata;
    }

    _about() {
        if (this.about) { this.about.present(); return; }
        const meta = this._metadata();
        const dialog = new Gtk.Window({title: 'About Bezel', transient_for: this.window, modal: true, resizable: false, destroy_with_parent: true});
        dialog.add_css_class('bezel-settings');
        dialog.set_titlebar(new Adw.HeaderBar({show_title: false}));
        const body = vertical(10, {margin_top: 6, margin_bottom: 22, margin_start: 28, margin_end: 28, width_request: 320});
        const icon = Gtk.Image.new_from_file(`${this.directory}/icons/bezel.png`);
        icon.pixel_size = 72;
        icon.halign = Gtk.Align.CENTER;
        body.append(icon);
        body.append(label(meta.name || 'Bezel', 'brand', {halign: Gtk.Align.CENTER}));
        body.append(label(meta['version-name'] || 'Version unknown', 'muted', {halign: Gtk.Align.CENTER}));
        if (meta.description) body.append(label(meta.description, '', {justify: Gtk.Justification.CENTER, hexpand: true, xalign: .5}));
        const shells = meta['shell-version'] || [];
        if (shells.length) body.append(label(`GNOME Shell ${shells[0]}–${shells[shells.length - 1]}`, 'muted', {halign: Gtk.Align.CENTER}));
        const update = label(this._updateText(), 'muted', {halign: Gtk.Align.CENTER});
        this.aboutUpdate = update;
        body.append(update);
        const updateButton = button('Update', () => this._confirmUpdate(), 'suggested-action', {halign: Gtk.Align.CENTER});
        this.aboutUpdateButton = updateButton;
        body.append(updateButton);
        this._applyVersion();
        if (meta.url) {
            const link = new Gtk.LinkButton({label: 'GitHub', uri: meta.url, halign: Gtk.Align.CENTER});
            body.append(link);
        }
        dialog.set_child(body);
        this.about = dialog;
        dialog.connect('close-request', () => { this.aboutUpdate = null; this.aboutUpdateButton = null; this.about = null; return false; });
        dialog.present();
    }

    _updateText() {
        const local = this._metadata()['version-name'];
        if (!local) return 'No version is set';
        if (this.updateError) return this.updateError;
        if (!this.updateChecked) return 'Checking for updates…';
        if (!this.updateRemote) return 'GitHub has no version yet';
        const delta = versionDelta(local, this.updateRemote);
        if (delta > 0) return `${this.updateRemote} is available`;
        if (delta < 0) return 'Newer than GitHub';
        return 'Up to date';
    }

    _applyVersion() {
        const local = this._metadata()['version-name'];
        const available = Boolean(local && this.updateRemote && versionDelta(local, this.updateRemote) > 0);
        if (this.versionButton) {
            this.versionButton.label = available ? `${local} · Update available` : (local || 'About');
            if (available) this.versionButton.add_css_class('has-update');
            else this.versionButton.remove_css_class('has-update');
        }
        if (this.aboutUpdate) this.aboutUpdate.label = this._updateText();
        if (this.aboutUpdateButton) {
            this.aboutUpdateButton.visible = available && !this.updateInstalling;
            this.aboutUpdateButton.sensitive = !this.updateInstalling;
        }
    }

    _confirmUpdate() {
        const remote = this.updateRemote;
        const dialog = new Gtk.Window({title: `Update to ${remote}?`, transient_for: this.about || this.window, modal: true, destroy_with_parent: true});
        dialog.add_css_class('bezel-settings');
        dialog.set_titlebar(new Adw.HeaderBar({show_title: false}));
        const body = vertical(12, {margin_top: 8, margin_bottom: 18, margin_start: 20, margin_end: 20, width_request: 640});
        body.append(label(`Replace the installed extension with ${remote}. Saved bars and palettes stay.`, '', {hexpand: true}));
        const commands = new Gtk.Label({label: UPDATE_COMMANDS.join('\n'), selectable: true, wrap: true, xalign: 0});
        commands.add_css_class('monospace');
        commands.add_css_class('caption');
        body.append(commands);
        const actions = horizontal(8, {halign: Gtk.Align.END});
        actions.append(button('Cancel', () => dialog.close()));
        actions.append(button('Update', () => { dialog.close(); this._runUpdate(); }, 'suggested-action'));
        body.append(actions);
        dialog.set_child(body);
        dialog.present();
    }

    _runUpdate() {
        if (this.updateInstalling) return;
        this.updateInstalling = true;
        this._applyVersion();
        if (this.aboutUpdate) this.aboutUpdate.label = 'Updating…';
        let proc;
        try {
            proc = Gio.Subprocess.new(['bash', '-lc', ['set -euo pipefail', ...UPDATE_COMMANDS].join('\n')],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (error) {
            this.updateInstalling = false;
            this._applyVersion();
            this._notice('Update failed', error.message);
            return;
        }
        proc.communicate_utf8_async(null, null, (source, result) => {
            this.updateInstalling = false;
            let output = '';
            let ok = false;
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                output = (stdout || '').trim();
                ok = source.get_successful();
            } catch (error) {
                output = error.message;
            }
            if (!ok) {
                this._applyVersion();
                if (this.aboutUpdate) this.aboutUpdate.label = 'Update failed';
                this._notice('Update failed', output.slice(0, 1200) || 'The update commands did not finish.');
                return;
            }
            if (this.aboutUpdateButton) this.aboutUpdateButton.visible = false;
            if (this.aboutUpdate) this.aboutUpdate.label = 'Installed. Log out and back in to finish.';
            if (this.versionButton) {
                this.versionButton.label = this._metadata()['version-name'] || 'About';
                this.versionButton.remove_css_class('has-update');
            }
            this._notice('Log out and back in', 'Bezel is updated. Log out and back in to load the new version.');
        });
    }

    _notice(title, body) {
        const dialog = new Adw.AlertDialog({heading: title, body});
        dialog.add_response('close', 'Close');
        dialog.present(this.about || this.window);
    }

    _checkVersion() {
        const local = this._metadata()['version-name'];
        if (!local) {
            this.updateChecked = true;
            this.updateRemote = null;
            this.updateError = 'No version is set';
            this._applyVersion();
            return;
        }
        if (this.updateRunning) return;
        this.versionCancel?.cancel();
        const cancellable = new Gio.Cancellable();
        this.versionCancel = cancellable;
        this.updateRunning = true;
        this.updateChecked = false;
        this.updateError = null;
        this._applyVersion();
        const session = new Soup.Session({timeout: 8});
        const message = Soup.Message.new('GET', REMOTE_METADATA);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                const bytes = source.send_and_read_finish(result);
                if (cancellable.is_cancelled()) return;
                if (message.get_status() !== Soup.Status.OK) throw new Error('status');
                this.updateRemote = JSON.parse(textOf(bytes))['version-name'] || null;
                this.updateError = null;
            } catch (error) {
                if (cancellable.is_cancelled() || error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                this.updateRemote = null;
                this.updateError = 'Could not check for updates';
            }
            this.updateChecked = true;
            this.updateRunning = false;
            this._applyVersion();
        });
    }

    _message(title, body, action = null) {
        const dialog = new Adw.AlertDialog({heading: title, body});
        dialog.add_response('cancel', action ? 'Cancel' : 'Close'); dialog.close_response = 'cancel';
        if (action) { dialog.add_response('apply', 'Confirm'); dialog.set_response_appearance('apply', Adw.ResponseAppearance.DESTRUCTIVE); }
        dialog.connect('response', (_dialog, response) => { if (response === 'apply') action(); });
        dialog.present(this.window);
    }

    _confirmLayout(action) {
        this._captureCleanLayout();
        if (layoutIsClean(this.settings)) { action(); return; }
        const dialog = new Adw.AlertDialog({heading: 'Keep your layout changes?', body: 'Save your current layout before switching, or discard the unsaved changes.'});
        let n = 1; while (savedLayouts(this.settings).some(profile => profile.name === `Layout ${n}`)) n++;
        const entry = new Gtk.Entry({text: `Layout ${n}`, max_length: 80}); dialog.extra_child = entry;
        dialog.add_response('cancel', 'Cancel'); dialog.add_response('discard', 'Discard changes'); dialog.add_response('save', 'Save and switch');
        dialog.close_response = 'cancel'; dialog.default_response = 'save';
        dialog.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE); dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        entry.connect('changed', () => dialog.set_response_enabled('save', Boolean(entry.text.trim()) && !savedLayouts(this.settings).some(profile => profile.name === entry.text.trim())));
        dialog.connect('response', (_dialog, response) => {
            if (response === 'cancel') return;
            if (response === 'save') this._write(() => saveLayout(this.settings, entry.text));
            action();
        });
        dialog.present(this.window);
    }
}
