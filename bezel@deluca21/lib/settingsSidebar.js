import {appPickerList} from './appPickerPreferences.js';
// A separate settings shell, sharing Bezel's existing editors and write paths.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SettingsWindow} from './settings.js';
import {readBars, saveBars, normalizeBars, barAppearancePreset, DATE_FORMATS, presetBars, applyPreset} from './config.js';
import {patchBar, addBar, removeBar, setFloating, setKind, setCustomColor, shortcutLabel, useRecommendedShortcuts, createGroup} from './settingsModel.js';
import {PRESETS, resolveTheme} from './theme.js';
import {LOGIN_THEMES} from './loginMotion.js';
import {layoutPreview} from './layoutPreview.js';
import {savedLayouts, matchingLayout, restoreLayout, deleteLayout, saveLayout, nextLayoutName, rememberLayout} from './profiles.js';
import {optionCards, barPicture, palettePicture} from './settingsCards.js';

const sections = [
    ['bar', 'Bars & docks', 'view-grid-symbolic', 'THE SHELL', 'modules position size apps groups'],
    ['frame', 'Screen border', 'video-display-symbolic', 'THE SHELL', 'frame corners'],
    ['notifications', 'Notifications', 'preferences-system-notifications-symbolic', 'THE SHELL', 'history order position frame'],
    ['dashboard', 'Dashboard', 'x-office-calendar-symbolic', 'THE SHELL', 'weather clock date position'],
    ['launcher', 'Launcher', 'system-search-symbolic', 'THE SHELL', 'search files folders web width'],
    ['look', 'Appearance', 'applications-graphics-symbolic', 'THE DESKTOP', 'palette colours theme glass blur tint material surfaces highlight'],
    ['layouts', 'Layouts', 'view-paged-symbolic', 'THE DESKTOP', 'profiles presets save restore'],
    ['desktop', 'Desktop', 'user-desktop-symbolic', 'THE DESKTOP', 'overview startup'],
    ['shortcuts', 'Shortcuts', 'input-keyboard-symbolic', 'THE SESSION', 'keyboard bindings'],
    ['opening', 'Animations', 'media-playback-start-symbolic', 'THE SESSION', 'motion liquid login lock unlock transitions drawers drip grow shift pour duration'],
    ['settings', 'Settings window', 'preferences-system-symbolic', 'THE SESSION', 'classic sidebar layout'],
];
const box = (spacing = 12, props = {}) => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing, ...props});
const detach = widget => widget.get_parent()?.remove(widget);

export class SidebarSettingsWindow extends SettingsWindow {
    _build() {
        // Keep the mature editors, previews, profile actions and their lifecycle.
        super._build();
        this.barTab = 'shape';
        this.appearanceTab = 'palette';
        for (const widget of [this.presets, this.savedRow, this.side, this.editorScroll, this.editButton]) detach(widget);
        this.window.add_css_class('sidebar-settings');
        this.card.remove_css_class('editor-card');
        this.card.spacing = 24;
        this.card.margin_top = 20;
        this.card.margin_bottom = 28;
        this.card.margin_start = 28;
        this.card.margin_end = 28;
        this.editorScroll.set_child(null);
        const clamp = new Adw.Clamp({maximum_size: 720, tightening_threshold: 620, child: this.card});
        this.editorScroll.set_child(clamp);
        this.search = new Gtk.SearchEntry({placeholder_text: 'Search settings', margin_start: 12, margin_end: 12, margin_bottom: 12});
        this.list = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
        this.rows = [];
        for (const section of sections) {
            const row = new Gtk.ListBoxRow();
            row.section = section;
            const line = new Gtk.Box({spacing: 12, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10});
            line.append(new Gtk.Image({icon_name: section[2]}));
            line.append(new Gtk.Label({label: section[1], xalign: 0}));
            row.set_child(line);
            this.list.append(row);
            this.rows.push(row);
        }
        this.list.set_header_func((row, before) => {
            row.set_header(!before || before.section[3] !== row.section[3]
                ? new Gtk.Label({label: row.section[3], xalign: 0, margin_start: 12, margin_top: 20, margin_bottom: 6, css_classes: ['sidebar-heading']}) : null);
        });
        this.list.set_filter_func(row => this._matches(row));
        this.list.connect('row-selected', (_list, row) => { if (row && !this.selecting) this.choose(row.section[0]); });
        this.search.connect('search-changed', () => {
            this.list.invalidate_filter();
            this.list.invalidate_headers();
            const query = this.search.text.trim().toLowerCase();
            if (['glass', 'blur', 'tint', 'material'].some(term => query.includes(term))) this.appearanceTab = 'glass';
            else if (query.includes('palette') || query.includes('theme') || query.includes('colour')) this.appearanceTab = 'palette';
            const first = this.rows.find(row => this._matches(row));
            this.empty.visible = !first;
            if (first && !this._matches(this.list.get_selected_row())) this.list.select_row(first);
            else if (first && this.mode === 'look') this._queueCard();
        });
        const navigation = box(0);
        navigation.append(this.search);
        navigation.append(new Gtk.ScrolledWindow({child: this.list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));
        const sidebar = new Adw.ToolbarView({content: navigation});
        sidebar.add_top_bar(new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: 'Bezel'}), show_end_title_buttons: false}));
        this.empty = new Gtk.Label({label: 'No matching settings', visible: false, css_classes: ['dim-label']});
        navigation.append(this.empty);
        const versionRow = this.versionButton.get_parent();
        detach(versionRow);
        const footer = box(2, {margin_top: 12, margin_bottom: 14, margin_start: 16, margin_end: 16});
        footer.add_css_class('version-footer');
        footer.append(versionRow);
        this.updateStatus = new Gtk.Button({label: 'Checking for updates…', has_frame: false, halign: Gtk.Align.FILL,
            tooltip_text: 'About Bezel and updates', css_classes: ['update-status']});
        this.updateStatus.get_child().xalign = 0;
        this.updateStatus.get_child().wrap = true;
        this.updateStatus.connect('clicked', () => this._about());
        footer.append(this.updateStatus);
        navigation.append(footer);
        this.page = new Adw.NavigationPage({title: 'Bars & docks'});
        const pageBody = box(0);
        this.barStrip = box(0, {margin_top: 10, margin_bottom: 4, margin_start: 24, margin_end: 24});
        this.barStrip.add_css_class('bar-picker');
        pageBody.append(this.barStrip);
        pageBody.append(this.editorScroll);
        const toolbar = new Adw.ToolbarView({content: pageBody});
        const header = new Adw.HeaderBar();
        this.addBarButton = new Gtk.Button({label: 'Add bar', tooltip_text: 'Add a bar'});
        this.addBarButton.connect('clicked', () => this._nameBar());
        header.pack_end(this.addBarButton);
        this.removeBarButton = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Remove selected bar'});
        this.removeBarButton.connect('clicked', () => this._message('Remove this bar?', 'Its modules and appearance settings will be removed.', () => this._write(() => { removeBar(this.settings, this.barIndex); this.barIndex = 0; })));
        header.pack_end(this.removeBarButton);
        header.pack_end(this.editButton);
        toolbar.add_top_bar(header);
        this.page.set_child(toolbar);
        this.split = new Adw.NavigationSplitView({min_sidebar_width: 220, max_sidebar_width: 280, sidebar_width_fraction: .26,
            sidebar: new Adw.NavigationPage({title: 'Bezel', child: sidebar}), content: this.page});
        this.window.set_content(this.split);
        this.window.set_focus(this.list);
        this.window.connect('close-request', () => {
            this._flushNumbers();
            if (this.selectionIdle) GLib.source_remove(this.selectionIdle);
            this.selectionIdle = 0;
            this.list.set_header_func(null);
            this.list.set_filter_func(null);
            return false;
        });
    }

    choose(mode, index = this.barIndex) {
        this._flushNumbers();
        super.choose(mode === 'liquid' ? 'opening' : mode, index);
    }

    _write(action, rebuild = true) {
        this._flushNumbers();
        super._write(action, rebuild);
    }

    _selectBar(index) {
        // Let GTK finish activating the current control before replacing its page.
        if (this.selectionIdle) GLib.source_remove(this.selectionIdle);
        this.selectionIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.selectionIdle = 0;
            if (!this._closed) this.choose('bar', index);
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncBarPicker() {
        if (!this.barStrip || this.mode !== 'bar' || this.groupId) return;
        const bars = readBars(this.settings);
        const signature = JSON.stringify([this.barIndex, bars.map(bar => [bar.edge, bar.kind, bar.sections, bar.margin])]);
        if (signature === this.barPickerSignature) return;
        this.barPickerSignature = signature;
        while (this.barStrip.get_first_child()) this.barStrip.remove(this.barStrip.get_first_child());
        const choices = bars.map((bar, index) => ({id: String(index),
            title: `${bar.edge[0].toUpperCase()}${bar.edge.slice(1)} ${bar.kind === 'dock' ? 'dock' : 'bar'}`,
            preview: barPicture({edge: bar.edge, kind: bar.kind, sections: bar.sections, margin: bar.margin, compact: true})}));
        this.barStrip.append(optionCards(choices, String(this.barIndex), id => this._selectBar(Number(id)), Math.min(4, bars.length)));
    }

    _matches(row) {
        return row && `${row.section[1]} ${row.section[4]}`.toLowerCase().includes(this.search.text.trim().toLowerCase());
    }

    _about() {
        super._about();
        this.about?.add_css_class('sidebar-settings');
    }

    _applyVersion() {
        super._applyVersion();
        if (this.updateStatus) {
            this.updateStatus.label = this._updateText();
            this.updateStatus.get_child().xalign = 0;
            this.updateStatus.get_child().wrap = true;
        }
    }

    _loadCss() {
        const theme = resolveTheme(this.settings);
        const channels = [1, 3, 5].map(index => parseInt(theme.accent.slice(index, index + 2), 16) / 255);
        const accentText = channels.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0) > .55 ? theme.bg : theme.fg;
        this.css.load_from_string(`
            @define-color window_bg_color ${theme.bg};
            @define-color window_fg_color ${theme.fg};
            @define-color view_bg_color ${theme.bg};
            @define-color view_fg_color ${theme.fg};
            @define-color headerbar_bg_color ${theme.bg};
            @define-color headerbar_fg_color ${theme.fg};
            @define-color card_bg_color ${theme.surface};
            @define-color card_fg_color ${theme.fg};
            @define-color sidebar_bg_color ${theme.bg};
            @define-color sidebar_fg_color ${theme.fg};
            @define-color popover_bg_color ${theme.surface};
            @define-color popover_fg_color ${theme.fg};
            @define-color dialog_bg_color ${theme.bg};
            @define-color dialog_fg_color ${theme.fg};
            @define-color accent_bg_color ${theme.accent};
            @define-color accent_color ${theme.accent};
            @define-color accent_fg_color ${accentText};
            @define-color borders ${theme.border};
            window.sidebar-settings, .sidebar-settings navigation-view, .sidebar-settings toolbarview { background-color: ${theme.bg}; color: ${theme.fg}; }
            .sidebar-settings label { color: inherit; }
            .sidebar-settings button { color: ${theme.fg}; }
            .sidebar-settings .navigation-sidebar row { color: ${theme.fg}; }
            .sidebar-settings .navigation-sidebar row:selected label, .sidebar-settings .navigation-sidebar row:selected image { color: ${theme.accent}; }
            .sidebar-settings headerbar { background-color: ${theme.bg}; color: ${theme.fg}; box-shadow: none; }
            .sidebar-settings .navigation-sidebar row:selected { background-color: alpha(${theme.accent}, .14); color: ${theme.accent}; }
            .sidebar-settings .boxed-list > row { background-color: ${theme.surface}; color: ${theme.fg}; }
            .sidebar-settings .dim-label, .sidebar-settings .muted, .sidebar-settings .subtitle { color: ${theme.muted}; opacity: 1; }
            .sidebar-settings entry, .sidebar-settings searchentry, .sidebar-settings spinbutton { background-color: ${theme.surface}; color: ${theme.fg}; }
            .sidebar-settings switch:checked { background-color: ${theme.accent}; }
            .sidebar-settings button.version-tag, .sidebar-settings button.version-refresh, .sidebar-settings button.update-status {
                background: transparent; background-image: none; border: none; box-shadow: none; padding: 2px 0; min-height: 0;
            }
            .sidebar-settings button.version-tag { font-size: 12px; font-weight: 700; color: ${theme.muted}; }
            .sidebar-settings button.version-tag.has-update, .sidebar-settings button.version-tag:hover { color: ${theme.accent}; }
            .sidebar-settings button.version-refresh { color: ${theme.muted}; margin-right: 6px; }
            .sidebar-settings button.update-status { font-size: 11px; color: ${theme.muted}; }
            .sidebar-settings button.update-status:hover { color: ${theme.accent}; }

            .sidebar-settings .sidebar-heading { color: @window_fg_color; opacity: .55; font-size: 11px; font-weight: 700; }
            .sidebar-settings .navigation-sidebar { background: transparent; }
            .sidebar-settings .navigation-sidebar row { border-radius: 9px; margin: 2px 6px; }
            .sidebar-settings .heading { font-weight: 700; }
            .sidebar-settings .muted { opacity: .65; font-size: 12px; }
            .sidebar-settings .subheading { font-weight: 700; }
            .sidebar-settings .segment { background: alpha(currentColor, .07); border-radius: 10px; padding: 4px; }
            .sidebar-settings button.is-on { background: alpha(@accent_bg_color, .16); outline: 2px solid @accent_bg_color; }
            .sidebar-settings .preset-card { padding: 12px; border-radius: 12px; }
            .sidebar-settings .bar-picker button.option-card { padding: 8px 12px; border-radius: 12px; }
            .sidebar-settings .bar-picker .option-title { font-size: 12px; }
            .sidebar-settings .option-title { font-size: 14px; font-weight: 700; }
            .sidebar-settings button.option-card { background: alpha(currentColor, .065); background-image: none; box-shadow: none;
                border: 2px solid transparent; border-radius: 12px; padding: 8px 8px; }
            .sidebar-settings button.option-card:hover { background: alpha(currentColor, .10); }
            .sidebar-settings button.option-card.selected { background: alpha(@accent_bg_color, .12); border-color: @accent_bg_color; }
            .sidebar-settings .layout-tile { background: alpha(currentColor, .065); border-radius: 18px; border: 2px solid transparent; }
            .sidebar-settings .layout-tile.selected { background: alpha(@accent_bg_color, .12); border-color: @accent_bg_color; }
            .sidebar-settings .lane { background: @card_bg_color; border-radius: 12px; padding: 16px; box-shadow: 0 1px 4px alpha(black, .12); }
            .sidebar-settings .group { background: alpha(@accent_bg_color, .08); border-radius: 10px; padding: 8px; }
            .sidebar-settings .pinned-app { background: alpha(currentColor, .07); border-radius: 10px; padding: 4px 10px; }
            .sidebar-settings .module-chip { border-radius: 8px; }
            .sidebar-settings .drop-hover { outline: 2px solid @accent_bg_color; }
            .sidebar-settings .segment button { border-radius: 8px; border: none; box-shadow: none; background-image: none; background-color: transparent; }
            .sidebar-settings .segment button.is-on { background-color: alpha(@accent_bg_color, .18); color: @accent_color; outline: none; box-shadow: 0 1px 3px alpha(black, .15); }

        `);
    }

    _syncGroupEditorChrome() {
        this.side.visible = false;
        this.presets.visible = true;
        this.savedRow.visible = true;
        this.editButton.visible = this.mode === 'bar';
        for (const widget of [this.barStrip, this.addBarButton, this.removeBarButton]) if (widget) widget.visible = this.mode === 'bar' && !this.groupId;
    }

    _refresh() {
        this._flushNumbers();
        super._refresh();
        this._syncBarPicker();
        this._finishPage();
    }

    _refreshCard() {
        this._flushNumbers();
        super._refreshCard();
        this._syncBarPicker();
        this._finishPage();
    }

    _finishPage() {
        const section = sections.find(item => item[0] === (this.mode === 'liquid' ? 'opening' : this.mode)) ?? sections[0];
        this.page.title = section[1];
        this.selecting = true;
        this.list.select_row(this.rows.find(row => row.section === section));
        this.selecting = false;
        const build = {layouts: () => this._layoutsPage(), settings: () => this._settingsPage(),
            notifications: () => this._notificationsPage(), dashboard: () => this._dashboardPage(), launcher: () => this._launcherPage()};
        build[this.mode]?.();
    }

    _group(title, description = '') {
        const group = new Adw.PreferencesGroup({title: GLib.markup_escape_text(title, -1), description: GLib.markup_escape_text(description, -1)});
        this.card.append(group);
        return group;
    }

    _switch(group, title, value, apply, subtitle = '', rebuild = false) {
        const row = new Adw.SwitchRow({title, subtitle, use_markup: false, active: value});
        row.connect('notify::active', () => this._write(() => apply(row.active), rebuild));
        group.add(row);
        return row;
    }

    _spin(group, title, value, min, max, step, apply, subtitle = '', enabled = true) {
        const row = new Adw.SpinRow({title, subtitle, use_markup: false, sensitive: enabled, digits: 0, numeric: true});
        row.adjustment = new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5});
        // SpinRow's own default value can replace the adjustment's initial value
        // during construction. Set it after all construct properties are applied.
        row.value = value;
        const index = this.barIndex;
        row.connect('notify::value', () => {
            this.pendingNumbers ??= new Map();
            this.pendingNumbers.set(row, {apply, value: Math.round(row.value), index});
            if (this.numberIdle) GLib.source_remove(this.numberIdle);
            this.numberIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this.numberIdle = 0;
                this._flushNumbers();
                return GLib.SOURCE_REMOVE;
            });
        });
        group.add(row);
        return row;
    }

    _flushNumbers() {
        if (this.numberIdle) GLib.source_remove(this.numberIdle);
        this.numberIdle = 0;
        if (!this.pendingNumbers?.size) return;
        const pending = [...this.pendingNumbers.values()];
        this.pendingNumbers.clear();
        const index = this.barIndex;
        this._write(() => {
            try {
                for (const change of pending) {
                    this.barIndex = change.index;
                    change.apply(change.value);
                }
            } finally { this.barIndex = index; }
        }, false);
    }

    _combo(group, title, choices, current, apply, subtitle = '', rebuild = false) {
        const row = new Adw.ComboRow({title, subtitle, use_markup: false, model: Gtk.StringList.new(choices.map(([, name]) => name)),
            selected: Math.max(0, choices.findIndex(([id]) => id === current))});
        row.connect('notify::selected', () => {
            const choice = choices[row.selected];
            if (choice) this._write(() => apply(choice[0]), rebuild);
        });
        group.add(row);
        return row;
    }

    _visual(group, title, subtitle, options, selected, apply, columns = 2) {
        const content = box(8, {margin_top: 12, margin_bottom: 12, margin_start: 16, margin_end: 16});
        content.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['option-title']}));
        if (subtitle) content.append(new Gtk.Label({label: subtitle, xalign: 0, wrap: true, css_classes: ['dim-label', 'caption']}));
        content.append(optionCards(options, selected, id => this._write(() => apply(id)), columns));
        const row = new Gtk.ListBoxRow({child: content, activatable: false, selectable: false});
        group.add(row);
    }

    _toggle(title, value, callback) {
        const line = new Gtk.Box({spacing: 12});
        const caption = new Gtk.Label({label: title, xalign: 0, wrap: true, hexpand: true});
        const control = new Gtk.Switch({active: value, valign: Gtk.Align.CENTER});
        let syncing = false;
        control.connect('notify::active', () => { if (!syncing) this._write(() => callback(control.active), false); });
        line.append(caption); line.append(control);
        line._setActive = active => { syncing = true; control.active = active; syncing = false; };
        Object.defineProperty(line, 'label', {get: () => caption.label, set: text => { caption.label = text; }});
        return line;
    }

    _barCard(bar) {
        if (!bar) return;
        const bars = readBars(this.settings);
        this.addBarButton.sensitive = bars.length < 4;
        this.removeBarButton.sensitive = bars.length > 1;
        const tabs = this._segments([['shape', 'Shape'], ['contents', 'Modules'], ['appearance', 'Appearance'], ['apps', 'Applications']],
            this.barTab === 'size' ? 'shape' : this.barTab, value => { this.barTab = value; this._queueCard(); }, false);
        this.card.append(tabs);
        if (this.barTab === 'contents') {
            this._contents(bar);
        } else if (this.barTab === 'appearance') this._appearance(bar);
        else if (this.barTab === 'apps') this._apps(bar);
        else this._barShape(bar);
    }

    _nameBar() {
        const free = ['top', 'bottom', 'left', 'right'].filter(edge => !readBars(this.settings).some(bar => bar.edge === edge));
        if (!free.length) return;
        const dialog = new Adw.AlertDialog({heading: 'Add a bar', body: 'Choose a screen edge. You can change its style next.'});
        const choice = new Gtk.DropDown({model: Gtk.StringList.new(free.map(edge => edge[0].toUpperCase() + edge.slice(1)))});
        dialog.extra_child = choice;
        dialog.add_response('cancel', 'Cancel'); dialog.add_response('add', 'Add bar');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'add') this._write(() => { addBar(this.settings, free[choice.selected]); this.barIndex = readBars(this.settings).length - 1; });
        });
        dialog.present(this.window);
    }

    _barShape(bar) {
        const patch = values => patchBar(this.settings, this.barIndex, values);
        const shape = this._group('Shape');
        this._visual(shape, 'Style', 'A continuous bar, separate islands, or a dock that fits your applications.', [
            {id: 'panel', title: 'One bar', preview: barPicture({edge: bar.edge, margin: bar.margin})},
            {id: 'pills', title: 'Islands', preview: barPicture({edge: bar.edge, sections: 'pills', margin: bar.margin})},
            {id: 'dock', title: 'Dock', preview: barPicture({edge: bar.edge, kind: 'dock'})},
        ], bar.kind === 'dock' ? 'dock' : bar.sections === 'pills' ? 'pills' : 'panel', id => {
            setKind(this.settings, this.barIndex, id === 'dock' ? 'dock' : 'panel');
            patch({sections: id === 'pills' ? 'pills' : 'one', ...(id === 'dock' ? {fitContent: true, margin: bar.margin || 12} : {})});
        }, 3);
        this._visual(shape, 'Attachment', 'Join the screen edge or leave a gap around the bar.', [
            {id: 'attached', title: 'Attached', preview: barPicture({edge: bar.edge, kind: bar.kind, sections: bar.sections, margin: 0, frame: true})},
            {id: 'floating', title: 'Floating', preview: barPicture({edge: bar.edge, kind: bar.kind, sections: bar.sections, margin: 12})},
        ], bar.margin ? 'floating' : 'attached', id => setFloating(this.settings, this.barIndex, id === 'floating'));
        const placement = shape;
        this._visual(placement, 'Screen edge', 'Place this bar at any edge of your desktop.', ['top', 'bottom', 'left', 'right'].map(edge => ({id: edge,
            title: edge[0].toUpperCase() + edge.slice(1), preview: barPicture({edge, kind: bar.kind, margin: bar.margin, sections: bar.sections})})), bar.edge, id => patch({edge: id}), 4);
        if (bar.margin) this._spin(placement, 'Distance from edge', bar.margin, 0, 64, 2, value => patch({margin: value}), 'Pixels');
        const size = this._group('Size');
        for (const [key, title, min, max, step, unit] of [['thickness', 'Thickness', 44, 88, 2, 'Pixels'], ['iconSize', 'Icon size', 12, 40, 2, 'Pixels'],
            ['appSpacing', 'Application spacing', 0, 32, 1, 'Pixels']])
            this._spin(size, title, bar[key], min, max, step, value => patch({[key]: value}), unit);
        if (bar.kind === 'dock') {
            this._switch(size, 'Fit to applications', bar.fitContent, value => patch({fitContent: value}), 'The dock grows with its contents.', true);
            this._spin(size, 'Minimum dock length', bar.dockMinLength, 64, 10000, 8, value => patch({dockMinLength: value}), 'Pixels');
        }
        if (bar.kind !== 'dock' || !bar.fitContent) this._spin(size, 'Length', bar.length, 20, 100, 5, value => patch({length: value}), 'Percentage of the screen edge');
        const behavior = this._group('Visibility');
        this._switch(behavior, 'Hide automatically', bar.autohide, value => patch({autohide: value}), 'Reveal the bar when the pointer reaches its edge.');
        this._switch(behavior, 'Reserve space', bar.reserveSpace, value => patch({reserveSpace: value}), 'Keep application windows clear of this bar.', true);
        if (bar.reserveSpace) this._spin(behavior, 'Reserved offset', bar.reserveOffset, 0, 64, 2, value => patch({reserveOffset: value}), 'Extra space between windows and the bar, in pixels');
    }

    _appearance(bar) {
        const patch = values => patchBar(this.settings, this.barIndex, values);
        const surface = this._group('Surface');
        const material = new Adw.ActionRow({title: 'Glass & blur', use_markup: false, subtitle: 'Manage materials for bars, docks, drawers and the screen border together.', activatable: true});
        material.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        material.connect('activated', () => { this.appearanceTab = 'glass'; this._selectAppearance(); });
        surface.add(material);
        this._spin(surface, 'Background opacity', bar.barOpacity, 0, 100, 5, value => patch({barOpacity: value}), 'Percent · attached full-width bars share the screen border');
        this._spin(surface, 'Corner rounding', bar.rounding, 0, 48, 2, value => patch({rounding: value}), 'Pixels');
        const framed = this.settings.get_boolean('show-frame');
        this._spin(surface, 'Shadow', bar.barShadow, 0, 24, 1, value => patch({barShadow: value}), framed ? 'The screen border provides the shadow while enabled.' : 'Pixels · zero removes the shadow', !framed);
        const colours = this._group('Colours');
        this._switch(colours, 'Use separate bar colours', bar.ownColors, value => patch({ownColors: value}),
            framed ? 'Turn off the screen border to use separate colours.' : 'Override the desktop palette for this bar.', true).sensitive = !framed;
        if (bar.ownColors && !framed) this._ownColours(bar);
        const groups = this._group('Module groups', 'Defaults for groups. Individual groups can override these in Modules.');
        this._switch(groups, 'Colour group backgrounds', bar.colourGroups, value => patch({colourGroups: value}));
        for (const [key, title, max, unit] of [['groupPadding', 'End padding', 32, 'Pixels'], ['groupInset', 'Side padding', 12, 'Pixels'],
            ['groupRounding', 'Corner rounding', 48, 'Pixels'], ['groupOpacity', 'Opacity', 100, 'Percent']])
            this._spin(groups, title, bar[key], 0, max, 1, value => patch({[key]: value}), unit);
        const presets = this._group('Quick looks', 'Apply a coordinated shape and group treatment to this bar.');
        this._visual(presets, 'Look', '', [
            {id: 'frame', title: 'In-frame', preview: barPicture({margin: 0, frame: true})},
            {id: 'floating', title: 'Floating dock', preview: barPicture({edge: bar.edge, kind: 'dock'})},
            {id: 'minimal', title: 'Icons only', preview: barPicture({kind: 'dock', opacity: 0})},
        ], '', id => {
            const bars = readBars(this.settings);
            bars[this.barIndex] = barAppearancePreset(bars[this.barIndex], id);
            saveBars(this.settings, bars);
            if (id === 'frame') this.settings.set_boolean('show-frame', true);
        }, 3);
    }

    _contents(bar) {
        const group = this._group('Module groups', 'Drag modules between the start, centre and end. Click a module to configure it.');
        this._switch(group, 'Colour group backgrounds', bar.colourGroups, value => patchBar(this.settings, this.barIndex, {colourGroups: value}));
        const create = new Adw.ButtonRow({title: 'Create a group…', start_icon_name: 'list-add-symbolic'});
        create.connect('activated', () => this._nameDialog('Create a group', 'Give this group a name, then drag modules into it.', '', name => {
            this._write(() => createGroup(this.settings, this.barIndex, name), false);
            this._queueLanes();
        }));
        group.add(create);
        this.lanes = box(16);
        this.card.append(this.lanes);
        this._fillLanes(bar);
    }

    _apps(bar) {
        const patch = values => patchBar(this.settings, this.barIndex, values);
        const behavior = this._group('Application buttons');
        this._switch(behavior, 'Show running applications', bar.runningApps, value => patch({runningApps: value}));
        this._combo(behavior, 'Click action', [['cycle', 'Cycle windows'], ['minimize', 'Minimise / restore'], ['activate', 'Activate'], ['previews', 'Window list']], bar.appClick, value => patch({appClick: value}));
        this._switch(behavior, 'Animate presses', bar.appPress, value => patch({appPress: value}));
        const indicators = this._group('Indicators');
        this._visual(indicators, 'Running applications', 'Mark applications that have open windows.', [['line', 'Line'], ['dot', 'Dot'], ['none', 'None']].map(([id, title]) => ({id, title,
            preview: barPicture({kind: 'dock', indicator: id})})), bar.appIndicator, id => patch({appIndicator: id}), 3);
        this._visual(indicators, 'Focused application', 'Highlight the application you are using.', [['none', 'None'], ['line', 'Accent line'], ['background', 'Background'], ['both', 'Both']].map(([id, title]) => ({id, title,
            preview: barPicture({kind: 'dock', indicator: 'none', focus: id})})), bar.appFocus, id => patch({appFocus: id}), 4);
        const hover = this._group('Pointer feedback');
        this._visual(hover, 'Hover effect', 'How an application button responds to the pointer.', [['none', 'None'], ['highlight', 'Highlight'], ['lift', 'Lift'], ['both', 'Both']].map(([id, title]) => ({id, title,
            preview: barPicture({kind: 'dock', hover: id})})), bar.appHover, id => patch({appHover: id}), 4);
        const pins = this._group('Pinned applications', 'Drag to reorder. These stay on the bar even when they are closed.');
        const container = box(0, {margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16});
        container.append(this._pinnedApps(bar));
        pins.add(new Gtk.ListBoxRow({child: container, activatable: false, selectable: false}));
    }

    _openingCard() {
        const drawers = this._group('Drawers', 'How dashboard, quick controls and other drawers open and move.');
        this._combo(drawers, 'Motion style', [['standard', 'Standard'], ['liquid', 'Liquid']], this.settings.get_boolean('liquid-motion') ? 'liquid' : 'standard',
            value => this.settings.set_boolean('liquid-motion', value === 'liquid'), 'Standard uses the usual wipe. Liquid adds spring and droplet motion.', true);
        this._spin(drawers, 'Opening duration', this.settings.get_int('animation-duration'), 0, 800, 20, value => this.settings.set_int('animation-duration', value), 'Milliseconds · also controls bar autohide');
        if (this.settings.get_boolean('liquid-motion')) {
            this._combo(drawers, 'Opening effect', [['grow', 'Grow'], ['drip', 'Drip'], ['drip-grow', 'Drip then grow'], ['drop-expand', 'Drop & expand'], ['unfold', 'Unfold']], this.settings.get_string('liquid-open-style'), value => this.settings.set_string('liquid-open-style', value), 'Grow springs open; Drip forms a droplet; Unfold settles with a bounce.');
            this._combo(drawers, 'Switching drawers', [['off', 'Off'], ['shift', 'Shift'], ['pour', 'Pour']], this.settings.get_boolean('liquid-shift') ? 'shift' : this.settings.get_boolean('liquid-pour') ? 'pour' : 'off', value => {
                this.settings.set_boolean('liquid-shift', value === 'shift'); this.settings.set_boolean('liquid-pour', value === 'pour');
            }, 'Shift follows the screen border. Pour drains into the next drawer.');
            this._spin(drawers, 'Motion duration scale', this.settings.get_int('liquid-duration-scale'), 25, 300, 25, value => this.settings.set_int('liquid-duration-scale', value), 'Percent of the standard duration');
        }
        const layouts = this._group('Layout changes');
        this._combo(layouts, 'Transition', [['none', 'Off'], ['fade', 'Fade'], ['slide', 'Slide'], ['retreat', 'Retreat'], ['wipe', 'Wipe']], this.settings.get_string('layout-transition'), value => this.settings.set_string('layout-transition', value));
        this._spin(layouts, 'Duration', this.settings.get_int('layout-transition-duration'), 0, 1600, 40, value => this.settings.set_int('layout-transition-duration', value), 'Milliseconds');
        const session = this._group('Login & lock screen', 'Use one style for login, lock and unlock.');
        const triggers = [['login-animation', 'Animate login'], ['lock-animation', 'Animate lock'], ['unlock-animation', 'Animate unlock']];
        for (const [key, title] of triggers) this._switch(session, title, this.settings.get_boolean(key), value => this.settings.set_boolean(key, value), '', true);
        const enabled = triggers.some(([key]) => this.settings.get_boolean(key));
        const style = this._combo(session, 'Animation style', LOGIN_THEMES.map(([id, title]) => [id, title]), this.settings.get_string('login-animation-theme'), value => this.settings.set_string('login-animation-theme', value));
        style.sensitive = enabled;
        this._spin(session, 'Speed', this.settings.get_int('login-animation-speed'), 25, 200, 5, value => this.settings.set_int('login-animation-speed', value), 'Percent · 100 is the normal speed', enabled);
        const preview = new Adw.ButtonRow({title: 'Preview animation', start_icon_name: 'media-playback-start-symbolic'});
        preview.connect('activated', () => this.settings.set_int('preview-login-animation', (this.settings.get_int('preview-login-animation') + 1) % 2147483647));
        session.add(preview);
    }

    _liquidCard() {
        // Existing launcher links to Liquid land on its new home in Animations.
        this._openingCard();
    }

    _selectAppearance() {
        if (this.selectionIdle) GLib.source_remove(this.selectionIdle);
        this.selectionIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.selectionIdle = 0;
            if (!this._closed) this.choose('look');
            return GLib.SOURCE_REMOVE;
        });
    }

    _glassPage() {
        const master = this._group('Glass');
        this._switch(master, 'Enable glass', this.settings.get_boolean('liquid-glass-enabled'), value => this.settings.set_boolean('liquid-glass-enabled', value), 'Keep individual surface choices when glass is off.', true);
        const glass = this._group('Glass surfaces', 'Choose where to use translucent glass instead of a solid background.');
        for (const [key, title, subtitle] of [['drawers', 'Drawers', 'Dashboard, quick controls and popouts'], ['docks', 'Docks', 'All application docks'],
            ['panels', 'Bars', 'All panel bars'], ['frame', 'Screen border', 'Attached bars and drawers inherit this material']])
            this._switch(glass, title, this.settings.get_boolean(`liquid-glass-${key}`), value => this.settings.set_boolean(`liquid-glass-${key}`, value), subtitle, true);
        glass.sensitive = this.settings.get_boolean('liquid-glass-enabled');
        const enabled = this.settings.get_boolean('liquid-glass-enabled') && ['drawers', 'docks', 'panels', 'frame'].some(key => this.settings.get_boolean(`liquid-glass-${key}`));
        const finish = this._group('Glass finish', 'A shared treatment for every glass surface.');
        finish.sensitive = this.settings.get_boolean('liquid-glass-enabled') && (enabled || (this.settings.get_boolean('app-blur-enabled') && this.settings.get_string('app-blur-finish') === 'glass'));
        this._switch(finish, 'Live window blur', this.settings.get_boolean('liquid-live-blur'), value => this.settings.set_boolean('liquid-live-blur', value), 'Blurs windows behind glass. May reduce performance.');
        this._switch(finish, 'Highlight edges', this.settings.get_boolean('liquid-edge-highlight'), value => this.settings.set_boolean('liquid-edge-highlight', value));
        this._spin(finish, 'Blur radius', this.settings.get_int('liquid-blur-radius'), 0, 64, 2, value => this.settings.set_int('liquid-blur-radius', value), 'Pixels');
        this._spin(finish, 'Tint', this.settings.get_int('liquid-tint'), 0, 100, 2, value => this.settings.set_int('liquid-tint', value), 'Percent');
        for (const [key, title] of [['brightness', 'Brightness'], ['contrast', 'Contrast']])
            this._spin(finish, title, this.settings.get_int(`liquid-${key}`), 0, 200, 5, value => this.settings.set_int(`liquid-${key}`, value), 'Percent · 100 is unchanged');
        const apps = this._group('Application blur', 'Cached application blur, with foreground content above the backdrop. Dynamic blurs windows behind the app; static blurs wallpaper.');
        const appToggle = this._switch(apps, 'Blur applications', this.settings.get_boolean('app-blur-enabled'), value => this.settings.set_boolean('app-blur-enabled', value), 'Off by default; begin with a small whitelist.', true);
        this._combo(apps, 'Apply to', [['whitelist', 'Only whitelisted apps'], ['blacklist', 'All apps except blacklist']], this.settings.get_string('app-blur-policy'), value => this.settings.set_string('app-blur-policy', value), '', true);
        apps.description += ' Select an application window to add its window class.';
        this._combo(apps, 'Backdrop finish', [['blur', 'Blur'], ['glass', 'Glass']], this.settings.get_string('app-blur-finish'), value => this.settings.set_string('app-blur-finish', value), 'Glass uses the shared glass finish controls.', true);
        const highlight = this._switch(apps, 'Highlight app edges', this.settings.get_boolean('app-glass-highlight'), value => this.settings.set_boolean('app-glass-highlight', value), 'An independent highlight for app glass.');
        highlight.sensitive = this.settings.get_string('app-blur-finish') === 'glass';
        this._combo(apps, 'Blur type', [['static', 'Static wallpaper'], ['dynamic', 'Dynamic backdrop']], this.settings.get_string('app-blur-type'), value => this.settings.set_string('app-blur-type', value));
        this._spin(apps, 'Sigma', this.settings.get_int('app-blur-sigma'), 0, 100, 1, value => this.settings.set_int('app-blur-sigma', value), 'Blur strength · radius is twice Sigma', this.settings.get_string('app-blur-finish') === 'blur');
        this._spin(apps, 'Brightness', this.settings.get_int('app-blur-brightness'), 0, 100, 5, value => this.settings.set_int('app-blur-brightness', value), 'Percent · 100 = 1.00', this.settings.get_string('app-blur-finish') === 'blur');
        this._spin(apps, 'Opacity', this.settings.get_int('app-blur-window-opacity'), 0, 255, 5, value => this.settings.set_int('app-blur-window-opacity', value), 'Foreground content · 255 is fully opaque');
        this._spin(apps, 'Corner radius', this.settings.get_int('app-blur-corner-radius'), 0, 64, 1, value => this.settings.set_int('app-blur-corner-radius', value), 'Pixels');
        this._switch(apps, 'Round maximized and fullscreen windows', this.settings.get_boolean('app-blur-round-maximized'), value => this.settings.set_boolean('app-blur-round-maximized', value));
        this._switch(apps, 'Opaque focused window', this.settings.get_boolean('app-blur-opaque-focused'), value => this.settings.set_boolean('app-blur-opaque-focused', value), 'Keep the active app fully readable; blur other selected apps.');
        this._switch(apps, 'Blur on overview', this.settings.get_boolean('app-blur-overview'), value => this.settings.set_boolean('app-blur-overview', value));
        this._switch(apps, 'Unblur when fullscreen', this.settings.get_boolean('app-blur-unblur-fullscreen'), value => this.settings.set_boolean('app-blur-unblur-fullscreen', value));
        const appEnabled = this.settings.get_boolean('app-blur-enabled');
        const disableRows = widget => {
            for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling()) {
                if (child instanceof Adw.PreferencesRow && child !== appToggle) child.sensitive = child.sensitive && appEnabled;
                else disableRows(child);
            }
        };
        disableRows(apps);
        for (const key of [this.settings.get_string('app-blur-policy')]) {
            const list = appPickerList(this.settings, `app-blur-${key}`, this.window);
            list.sensitive = appEnabled;
            this.card.append(list);
        }
    }

    _paletteCard() {
        this.card.append(this._segments([['palette', 'Palette'], ['glass', 'Glass & blur']], this.appearanceTab, value => {
            this.appearanceTab = value;
            this._queueCard();
        }, false));
        if (this.appearanceTab === 'glass') { this._glassPage(); return; }
        const current = this.settings.get_string('theme');
        const custom = {id: 'custom', name: 'Custom', ...Object.fromEntries(['bg', 'surface', 'fg', 'muted', 'accent', 'group'].map(key => [key, this.settings.get_string(`custom-${key}`)]))};
        const group = this._group('Palette', 'These colours are used by the screen border, bars and drawers.');
        this._visual(group, 'Choose a palette', '', [...PRESETS, {...resolveTheme({get_string: key => key === 'theme' ? 'wallpaper' : this.settings.get_string(key)}), id: 'wallpaper', name: 'Wallpaper'}, custom].map(palette => ({id: palette.id, title: palette.name, preview: palettePicture(palette)})), current,
            id => this.settings.set_string('theme', id), 3);
        if (current === 'wallpaper') {
            const wallpaper = this._group('Wallpaper colours', 'Updates automatically when your wallpaper changes.');
            this._combo(wallpaper, 'Style', [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']], this.settings.get_string('wallpaper-style'), value => this.settings.set_string('wallpaper-style', value));
            this._combo(wallpaper, 'Colourfulness', [['muted', 'Muted'], ['vibrant', 'Vibrant'], ['monochrome', 'Monochrome']], this.settings.get_string('wallpaper-variant'), value => this.settings.set_string('wallpaper-variant', value));
            let swatches = [];
            try { swatches = JSON.parse(this.settings.get_string('wallpaper-palette')).swatches ?? []; } catch {}
            this._combo(wallpaper, 'Source colour', [['-1', 'Automatic'], ...swatches.map((color, index) => [String(index), color])], String(this.settings.get_int('wallpaper-swatch')), value => this.settings.set_int('wallpaper-swatch', Number(value)));
            if (swatches.length) {
                const row = new Adw.ActionRow({title: 'Wallpaper swatches'});
                const choices = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
                swatches.forEach((color, index) => {
                    const tile = new Gtk.Button({tooltip_text: color, child: this._swatches({bg: color, surface: color, accent: color, fg: color}, 22)});
                    tile.connect('clicked', () => this.settings.set_int('wallpaper-swatch', index)); choices.append(tile);
                });
                row.add_suffix(choices); wallpaper.add(row);
            }
            const status = this.settings.get_string('wallpaper-status');
            if (status) wallpaper.add(new Adw.ActionRow({title: status}));
        }
        if (current !== 'custom') return;
        const colours = this._group('Custom colours');
        for (const [key, title] of [['bg', 'Frame'], ['surface', 'Cards'], ['fg', 'Text'], ['muted', 'Secondary text'], ['accent', 'Accent'], ['group', 'Group accent'], ['border', 'Dividers']]) {
            const row = new Adw.ActionRow({title});
            const picker = this._colorChoice(this.settings.get_string(`custom-${key}`), hex => this._write(() => setCustomColor(this.settings, key, hex)));
            picker.valign = Gtk.Align.CENTER;
            row.add_suffix(picker); colours.add(row);
        }
    }

    _glassLink(group, subtitle) {
        const row = new Adw.ActionRow({title: 'Glass & blur', use_markup: false, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', () => { this.appearanceTab = 'glass'; this._selectAppearance(); });
        group.add(row);
    }

    _frameCard() {
        const group = this._group('Screen border', 'A frame around your desktop, with rounded inner corners.');
        this._switch(group, 'Show screen border', this.settings.get_boolean('show-frame'), value => this.settings.set_boolean('show-frame', value), '', true);
        this._glassLink(group, 'Change the border material in Appearance.');
        for (const [key, title, min, max] of [['frame-width', 'Width', 4, 48], ['frame-radius', 'Corner radius', 0, 80], ['frame-shadow', 'Shadow', 0, 24]])
            this._spin(group, title, this.settings.get_int(key), min, max, 1, value => this.settings.set_int(key, value), 'Pixels', this.settings.get_boolean('show-frame'));
    }

    _notificationsPage() {
        const display = this._group('Display');
        this._switch(display, 'Use Bezel notifications', this.settings.get_boolean('frame-notifications'), value => this.settings.set_boolean('frame-notifications', value), 'Show notification history in the Bezel drawer.');
        this._glassLink(display, 'Change drawer materials in Appearance.');
        this._positionGroup('notifications', 'Drawer position');
        this._combo(display, 'Banner animation', [['default', 'Default'], ['grow', 'Grow'], ['drip', 'Drip'], ['drip-grow', 'Drip then grow'], ['drop-expand', 'Drop then expand'], ['unfold', 'Unfold']], this.settings.get_string('notifications-animation'), value => this.settings.set_string('notifications-animation', value), 'Independent of drawer motion. Default keeps the native slide.');
        const history = this._group('History');
        this._combo(history, 'Order', [['newest-first', 'Newest first'], ['oldest-first', 'Oldest first']], this.settings.get_string('notifications-order'), value => this.settings.set_string('notifications-order', value));
        this._spin(history, 'Maximum height', this.settings.get_int('notifications-max-height'), 240, 1600, 40, value => this.settings.set_int('notifications-max-height', value), 'Pixels · limited by the available screen height');
    }

    _positionGroup(key, title) {
        const group = this._group(title);
        const container = box(0, {margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16});
        container.append(this._spotGrid(`${key}-position`));
        group.add(new Gtk.ListBoxRow({child: container, activatable: false, selectable: false}));
    }

    _dashboardPage() {
        this._positionGroup('dashboard', 'Drawer position');
        const opening = this._group('Opening');
        this._switch(opening, 'Open from the top edge', this.settings.get_boolean('edge-panels'), value => this.settings.set_boolean('edge-panels', value), 'Reveal the dashboard when the pointer reaches the top of the screen.');
        const content = this._group('Content');
        this._switch(content, 'Show weather', this.settings.get_boolean('weather-dashboard'), value => this.settings.set_boolean('weather-dashboard', value));
        this._glassLink(content, 'Change drawer materials in Appearance.');
        const clock = this._group('Clock & date');
        this._combo(clock, 'Time format', [['24h', '24-hour'], ['12h', '12-hour']], this.settings.get_string('dashboard-time-format'), value => this.settings.set_string('dashboard-time-format', value));
        this._switch(clock, 'Show seconds', this.settings.get_boolean('dashboard-clock-seconds'), value => this.settings.set_boolean('dashboard-clock-seconds', value));
        this._combo(clock, 'Date format', Object.entries(DATE_FORMATS).map(([id, format]) => [id, format.label]), this.settings.get_string('dashboard-date-format'), value => this.settings.set_string('dashboard-date-format', value));
    }

    _desktopCard() {
        const edges = this._group('Screen edges');
        this._switch(edges, 'Bottom edge opens power', this.settings.get_boolean('power-hover'), value => this.settings.set_boolean('power-hover', value));
        this._spin(edges, 'Hover delay', this.settings.get_int('hover-delay'), 100, 1000, 50, value => this.settings.set_int('hover-delay', value), 'Milliseconds before an edge drawer opens');
        this._spin(edges, 'Keep hover drawers open', this.settings.get_int('liquid-hover-hold'), 0, 10000, 50, value => this.settings.set_int('liquid-hover-hold', value), 'Minimum open time in milliseconds for Liquid drawers');
        const backdrop = this._group('Overview background', 'Fill the space around workspace previews on every screen.');
        const mode = this.settings.get_string('overview-background');
        this._combo(backdrop, 'Style', [['off', 'Off'], ['dimmed', 'Dimmed wallpaper'], ['blurred', 'Blurred wallpaper'], ['gradient', 'Gradient']], mode, value => this.settings.set_string('overview-background', value), '', true);
        if (mode === 'dimmed' || mode === 'blurred')
            this._spin(backdrop, 'Dimming', this.settings.get_int('overview-dim'), 0, 100, 5, value => this.settings.set_int('overview-dim', value), 'Percent');
        if (mode === 'blurred')
            this._spin(backdrop, 'Blur radius', this.settings.get_int('overview-blur'), 0, 100, 2, value => this.settings.set_int('overview-blur', value), 'Pixels');
        if (mode === 'gradient')
            this._spin(backdrop, 'Colour strength', this.settings.get_int('overview-gradient-strength'), 0, 100, 5, value => this.settings.set_int('overview-gradient-strength', value), 'Percent · follows your palette');
        const gnome = this._group('GNOME shell');
        for (const [key, title, subtitle] of [['hide-gnome-panel', 'Hide GNOME top bar', 'Use Bezel bars in place of the standard top bar.'],
            ['hide-overview-dock', 'Hide Overview dock', 'Keep Bezel as your application dock in the overview.'],
            ['disable-startup-overview', 'Skip overview on startup', 'Go straight to the desktop after signing in.']])
            this._switch(gnome, title, this.settings.get_boolean(key), value => this.settings.set_boolean(key, value), subtitle);
    }

    _launcherPage() {
        const window = this._group('Search window');
        this._spin(window, 'Width', this.settings.get_int('launcher-width'), 360, 1000, 20, value => this.settings.set_int('launcher-width', value), 'Pixels');
        const web = this._group('Web search');
        this._combo(web, 'Search engine', [['ddg', 'DuckDuckGo'], ['g', 'Google'], ['w', 'Wikipedia'], ['gh', 'GitHub'], ['yt', 'YouTube']], this.settings.get_string('launcher-web-engine'), value => this.settings.set_string('launcher-web-engine', value));
        const files = this._group('File search', 'Hidden folders and symlinks are excluded.');
        this._switch(files, 'Search files', this.settings.get_boolean('launcher-files'), value => this.settings.set_boolean('launcher-files', value));
        const entry = new Adw.EntryRow({title: 'Search folders', text: this.settings.get_strv('launcher-file-roots').join('; '), show_apply_button: true});
        entry.connect('apply', () => this._write(() => this.settings.set_strv('launcher-file-roots', entry.text.split(';').map(value => value.trim()).filter(value => value.startsWith('/') || value === '~' || value.startsWith('~/'))), false));
        files.add(entry);
        files.description = 'Separate folders with a semicolon, for example ~/Documents; ~/Downloads. Searches cover up to 6 levels and 15,000 entries.';
    }

    _shortcutCard() {
        const group = this._group('Keyboard');
        this._combo(group, 'Super key opens', [['overview', 'Overview'], ['launcher', 'Launcher']], this.settings.get_boolean('super-launcher') ? 'launcher' : 'overview', value => this.settings.set_boolean('super-launcher', value === 'launcher'));
        for (const [key, title] of [['launcher-shortcut', 'Launcher'], ['overview-shortcut', 'Overview']]) {
            const row = new Adw.ActionRow({title});
            const current = new Gtk.Button({label: shortcutLabel(this.settings.get_strv(key)[0]), valign: Gtk.Align.CENTER});
            current.connect('clicked', () => this._captureShortcut(key, title, current));
            const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: `Clear ${title.toLowerCase()} shortcut`});
            clear.connect('clicked', () => this._write(() => { this.settings.set_strv(key, []); current.label = shortcutLabel(''); }, false));
            row.add_suffix(current); row.add_suffix(clear); group.add(row);
        }
        const recommended = new Adw.ButtonRow({title: 'Use Super + Space for the launcher', start_icon_name: 'input-keyboard-symbolic'});
        recommended.connect('activated', () => this._write(() => useRecommendedShortcuts(this.settings)));
        group.add(recommended);
    }

    _settingsPage() {
        const group = this._group('Settings window');
        this._combo(group, 'Layout', [['classic', 'Classic'], ['sidebar', 'Sidebar']], this.settings.get_string('settings-layout'), value => this.settings.set_string('settings-layout', value), 'Switch between the two settings designs.');
        const about = new Adw.ButtonRow({title: 'About Bezel', start_icon_name: 'help-about-symbolic'});
        about.connect('activated', () => this._about());
        group.add(about);
    }

    _layoutsPage() {
        const saved = this._group('Saved layouts', 'Save your desktop arrangement and appearance together.');
        const active = matchingLayout(this.settings);
        const profiles = savedLayouts(this.settings);
        const gallery = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true,
            min_children_per_line: 2, max_children_per_line: 2, column_spacing: 18, row_spacing: 18});
        for (const profile of profiles) {
            const body = box(8, {margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10});
            body.add_css_class('layout-tile');
            if (active?.name === profile.name) body.add_css_class('selected');
            let bars;
            try { bars = normalizeBars(JSON.parse(profile.values.config?.value || '{}').bars || [{}]); } catch { bars = readBars(this.settings); }
            const themeId = profile.values.theme?.value;
            const palette = themeId === 'custom'
                ? Object.fromEntries(['bg', 'surface', 'fg', 'muted', 'accent', 'group', 'border'].map(key => [key, profile.values[`custom-${key}`]?.value ?? this.settings.get_string(`custom-${key}`)]))
                : PRESETS.find(palette => palette.id === themeId);
            body.append(layoutPreview(this.settings, bars, profile.values['show-frame']?.value ?? false, 130, null, palette));
            const name = new Gtk.Label({label: profile.name, xalign: 0, ellipsize: 3, css_classes: ['option-title']});
            body.append(name);
            body.append(new Gtk.Label({label: `${palette?.name ?? (themeId === 'custom' ? 'Custom' : 'Desktop palette')} · ${bars.length} ${bars.length === 1 ? 'bar' : 'bars'}`, xalign: 0, css_classes: ['dim-label', 'caption']}));
            const footer = new Gtk.Box({spacing: 8});
            const load = new Gtk.Button({label: active?.name === profile.name ? 'In use' : 'Switch', hexpand: true, sensitive: active?.name !== profile.name});
            load.connect('clicked', () => this._confirmLayout(() => this._write(() => restoreLayout(this.settings, profile))));
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Delete saved layout'});
            remove.connect('clicked', () => this._message('Delete saved layout?', `Delete “${profile.name}”? Your current desktop will stay as it is.`, () => this._write(() => deleteLayout(this.settings, profile.name))));
            footer.append(load); footer.append(remove); body.append(footer);
            gallery.insert(body, -1);
        }
        if (profiles.length) saved.add(gallery);
        else saved.add(new Adw.ActionRow({title: 'No saved layouts yet', subtitle: 'Save your current setup below to create your first layout.'}));
        const actions = this._group('');
        const save = new Adw.ButtonRow({title: 'Save current setup…', start_icon_name: 'document-save-symbolic'});
        save.connect('activated', () => this._nameDialog('Save current setup', 'Give this layout a name.', nextLayoutName(this.settings), name => {
            const action = () => this._write(() => saveLayout(this.settings, name));
            if (savedLayouts(this.settings).some(profile => profile.name === name)) this._message('Replace saved layout?', `Replace “${name}”?`, action);
            else action();
        }, 'Save'));
        actions.add(save);
        const undo = new Adw.ButtonRow({title: 'Undo last layout change', start_icon_name: 'edit-undo-symbolic', sensitive: this.undo.sensitive});
        undo.connect('activated', () => this.undo.emit('clicked'));
        actions.add(undo);
        const builtins = this._group('Starting points', 'Replace the current layout with a preset.');
        this._visual(builtins, 'Desktop layout', '', [['caelestia', 'Bezel'], ['panel', 'Panel'], ['dock', 'Dock'], ['hybrid', 'Top + dock'], ['islands', 'Islands'], ['split', 'Split']].map(([id, title]) => ({id, title, preview: layoutPreview(this.settings, presetBars(id), id === 'caelestia', 100)})), '', id => {
            this._confirmLayout(() => this._write(() => {
                applyPreset(this.settings, id, new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('favorite-apps'));
                rememberLayout(this.settings); this.barIndex = 0; this.moduleId = null;
            }));
        }, 2);
    }
}
