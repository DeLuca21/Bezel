import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PRESETS} from './lib/theme.js';
import {readBars, saveBars, PLACES, DATE_FORMATS, DEFAULT_GROUPS, GROUP_CHOICES, presetBars, applyPreset, isSpacer, nextSpacerId, spacerLabel} from './lib/config.js';
import {layoutPreview} from './lib/layoutPreview.js';
import {LOGOS, logoFile} from './lib/logos.js';
import {saveLayout, savedLayouts, restoreLayout} from './lib/profiles.js';

const MODULES = [
    ['logo', 'Logo'],
    ['workspaces', 'Workspaces'],
    ['window', 'Active window'],
    ['apps', 'Pinned and running apps'],
    ['clock', 'Clock'],
    ['date', 'Date'],
    ['weather', 'Weather'],
    ['dashboard', 'Dashboard'],
    ['volume', 'Volume'],
    ['network', 'Network'],
    ['battery', 'Battery'],
    ['power', 'Power'],
    ['screenshot', 'Screenshot'],
    ['dnd', 'Do Not Disturb'],
    ['nightlight', 'Night Light'],
    ['dark', 'Dark style'],
    ['performance', 'Performance'],
    ['vpn', 'VPN'],
    ['settings', 'Settings'],
];

const EDGES = [['left', 'Left'], ['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom']];

export default class BezelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._window = window;
        window.set_default_size(1040, 780);
        window.search_enabled = true;
        this._buildPages(settings);
        const changed = settings.connect('changed', () => this._preview?.queue_draw());
        window.connect('notify::visible-page', () => {
            if (!this._pagesDirty)
                return;
            const page = window.get_visible_page();
            if (!page || page === this._pages?.[0])
                return;
            this._pagesDirty = false;
            this._refreshCombo(settings);
        });
        window.connect('close-request', () => { settings.disconnect(changed); return false; });
    }

    _buildPages(settings) {
        const visible = this._window.get_visible_page();
        const selectedTitle = visible?.title ?? this._pages?.[0]?.title;
        const scroll = pageScrollValue(visible);
        const barIndex = this._barIndex ?? 0;
        for (const page of this._pages ?? []) this._window.remove(page);
        this._appsGroup = null;
        this._appsBarCombo = null;
        this._indicatorCombo = null;
        this._savedGroup = null;
        this._savedRows = [];
        this._barIndex = barIndex;
        this._pages = [this._profilesPage(settings), this._barPage(settings), this._appsPage(settings),
            this._launcherPage(settings), this._borderPage(settings), this._lookPage(settings)];
        for (const page of this._pages) this._window.add(page);
        const next = this._pages.find(page => page.title === selectedTitle) ?? this._pages[0];
        this._window.set_visible_page(next);
        restorePageScroll(next, scroll);
    }

    _profilesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Layouts', icon_name: 'view-grid-symbolic'});
        const hero = new Adw.PreferencesGroup({title: 'Make it yours',
            description: 'A continuous shell, a taskbar, a compact dock — or a combination. Built-in layouts replace bar geometry. Save a named preset to keep your custom layout; pins and logo actions carry over.'});
        this._preview = layoutPreview(settings, null, null, 240);
        hero.add(this._preview);
        page.add(hero);
        const presets = new Adw.PreferencesGroup({title: 'Start with a layout'});
        const grid = new Gtk.Grid({column_spacing: 14, row_spacing: 14, column_homogeneous: true});
        for (const [index, [id, title, description]] of [
            ['caelestia', 'Bezel', 'Left rail · continuous frame · joined drawers'],
            ['panel', 'Panel', 'Full-width taskbar · apps and system controls'],
            ['dock', 'Dock', 'Compact app dock · content-sized and floating'],
            ['hybrid', 'Top bar + dock', 'System controls above · applications below'],
        ].entries()) {
            const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
                margin_top: 8, margin_bottom: 12, margin_start: 12, margin_end: 12});
            content.append(layoutPreview(settings, presetBars(id), id === 'caelestia', 120));
            const name = new Gtk.Label({label: title}); name.add_css_class('heading');
            content.append(name);
            const hint = new Gtk.Label({label: description, wrap: true}); hint.add_css_class('dim-label');
            content.append(hint);
            const button = new Gtk.Button({child: content, hexpand: true});
            button.connect('clicked', () => {
                const favorites = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('favorite-apps');
                applyPreset(settings, id, favorites);
                this._barIndex = 0;
                this._preview.queue_draw();
                this._pagesDirty = true;
            });
            grid.attach(button, index % 2, Math.floor(index / 2), 1, 1);
        }
        presets.add(grid);
        const undo = new Adw.ButtonRow({title: 'Undo last preset', start_icon_name: 'edit-undo-symbolic'});
        undo.connect('activated', () => {
            try {
                const previous = JSON.parse(settings.get_string('previous-layout'));
                if (typeof previous.config !== 'string' || typeof previous.frame !== 'boolean')
                    return;
                settings.set_string('config', previous.config);
                settings.set_boolean('show-frame', previous.frame);
                if (Number.isInteger(previous.indicatorBar)) settings.set_int('indicator-bar', Math.max(0, Math.min(4, previous.indicatorBar)));
                settings.set_string('previous-layout', '');
                this._barIndex = 0;
                this._preview.queue_draw();
                this._pagesDirty = true;
            } catch { /* No previous preset. */ }
        });
        presets.add(undo);
        page.add(presets);
        const saved = new Adw.PreferencesGroup({title: 'Saved layouts',
            description: 'Save all Bezel settings: bars, pins, logo actions, theme, frame and behavior. Saving an existing name replaces that preset.'});
        const name = new Adw.EntryRow({title: 'Preset name', show_apply_button: true});
        name.connect('apply', () => {
            if (!name.text.trim()) return;
            saveLayout(settings, name.text);
            this._renderSaved(settings);
        });
        saved.add(name);
        this._savedGroup = saved;
        this._savedRows = [];
        this._renderSaved(settings);
        page.add(saved);
        return page;
    }

    _renderSaved(settings) {
        if (!this._savedGroup)
            return;
        for (const row of this._savedRows ?? [])
            this._savedGroup.remove(row);
        this._savedRows = [];
        for (const profile of savedLayouts(settings)) {
            const row = new Adw.ActionRow({title: profile.name});
            const load = new Gtk.Button({label: 'Load', valign: Gtk.Align.CENTER});
            load.connect('clicked', () => {
                try {
                    restoreLayout(settings, profile);
                    this._preview.queue_draw();
                    this._pagesDirty = true;
                } catch (error) {
                    this._window.add_toast(new Adw.Toast({title: `Could not load preset: ${error.message}`}));
                }
            });
            row.add_suffix(load);
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Delete saved preset', valign: Gtk.Align.CENTER});
            remove.connect('clicked', () => {
                settings.set_string('saved-layouts', JSON.stringify(savedLayouts(settings).filter(item => item.name !== profile.name)));
                this._renderSaved(settings);
            });
            row.add_suffix(remove);
            this._savedGroup.add(row);
            this._savedRows.push(row);
        }
    }

    _barPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Bar', icon_name: 'view-list-symbolic'});
        this._writing = false;
        const bars = readBars(settings);
        this._barIndex = Math.min(Math.max(0, this._barIndex ?? 0), Math.max(0, bars.length - 1));

        const picker = new Adw.PreferencesGroup({
            title: 'Bars',
            description: 'Each panel or dock has its own apps, modules, position, and window reservation. Changes apply immediately.',
        });
        page.add(picker);
        this._barCombo = new Adw.ComboRow({
            title: 'Selected bar',
            model: new Gtk.StringList({strings: bars.map((bar, index) => barLabel(bar, index))}),
            selected: this._barIndex,
        });
        this._barCombo.connect('notify::selected', () => {
            if (this._writing)
                return;
            this._barIndex = this._barCombo.selected;
            this._loadBar(settings);
        });
        picker.add(this._barCombo);
        const add = new Adw.ButtonRow({title: 'Add a bar'});
        add.connect('activated', () => {
            const current = readBars(settings);
            if (current.length >= 4)
                return;
            current.push({
                edge: EDGES.find(([edge]) => !current.some(bar => bar.edge === edge))?.[0] ?? 'right',
                thickness: 48,
                reserveSpace: false,
                reserveOffset: current[0]?.reserveOffset ?? 0,
                iconSize: 22,
                modules: [{id: 'clock', place: 'center'}],
                pinned: [],
            });
            saveBars(settings, current);
            this._barIndex = current.length - 1;
            this._refreshCombo(settings);
        });
        const remove = new Adw.ButtonRow({title: 'Remove selected bar'});
        remove.connect('activated', () => {
            const current = readBars(settings);
            if (current.length < 2)
                return;
            const target = settings.get_int('indicator-bar');
            if (target === this._barIndex + 1) settings.set_int('indicator-bar', 0);
            else if (target > this._barIndex + 1) settings.set_int('indicator-bar', target - 1);
            current.splice(this._barIndex, 1);
            saveBars(settings, current);
            this._barIndex = Math.max(0, this._barIndex - 1);
            this._refreshCombo(settings);
        });
        this._removeRow = remove;
        this._addRow = add;
        picker.add(add);
        picker.add(remove);
        this._modulesPage = page;
        this._moduleGroupMap = null;
        this._moduleRows = new Map();
        const place = new Adw.PreferencesGroup({title: 'Layout',
            description: 'Where this bar sits and what it opens.'});
        page.add(place);
        const size = new Adw.PreferencesGroup({title: 'Size and space'});
        page.add(size);
        this._sizeGroup = size;
        this._kind = choice('Layout', bars[0].kind, [['panel', 'Panel / rail'], ['dock', 'Compact dock']], value => this._patch(settings, {kind: value}));
        this._logoAction = choice('Logo opens', bars[0].logoAction, [['launcher', 'Bezel app launcher'], ['overview', 'GNOME Overview'], ['apps', 'GNOME app grid']], value => this._patch(settings, {logoAction: value}));
        this._showLogo = bool('Show logo on this bar / dock', bars[0].modules.some(item => item.id === 'logo'), value => {
            if (this._writing) return;
            const modules = readBars(settings)[this._barIndex].modules.filter(item => item.id !== 'logo');
            if (value) {
                const insertAt = modules.findIndex(item => !isSpacer(item.id));
                modules.splice(insertAt < 0 ? modules.length : insertAt, 0, {id: 'logo', place: 'start'});
            }
            this._patch(settings, {modules});
            this._renderModules(settings);
        });
        this._logoPreset = choice('Distro logo', bars[0].logoIcon, [['custom', 'Custom / icon theme'],
            ...LOGOS.map(([id, title]) => [`distro:${id}`, title])], value => {
            if (this._writing) return;
            this._patch(settings, {logoIcon: value === 'custom' ? 'view-app-grid-symbolic' : value});
            this._loadBar(settings);
        });
        this._logoImage = new Gtk.Image({pixel_size: 24});
        this._logoPreset.add_prefix(this._logoImage);
        this._logoIcon = new Adw.EntryRow({title: 'Logo icon name or image path', text: bars[0].logoIcon, show_apply_button: true});
        this._logoIcon.connect('apply', () => { this._patch(settings, {logoIcon: this._logoIcon.text}); this._loadBar(settings); });
        const browseLogo = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Choose a logo image'});
        browseLogo.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose a logo image'});
            dialog.open(this._window, null, (source, result) => {
                try {
                    const file = source.open_finish(result);
                    if (file.get_path()) { this._logoIcon.text = file.get_path(); this._patch(settings, {logoIcon: file.get_path()}); this._loadBar(settings); }
                } catch { /* Picker cancelled. */ }
            });
        });
        this._logoIcon.add_suffix(browseLogo);
        this._edge = choice('Edge', bars[0].edge, EDGES, value => this._patch(settings, {edge: value}));
        this._thickness = spin('Thickness', bars[0].thickness, 44, 88, value => this._patch(settings, {thickness: value}));
        this._iconSize = spin('Icon size', bars[0].iconSize, 12, 40, value => this._patch(settings, {iconSize: value}));
        this._reserve = bool('Reserve space for windows', bars[0].reserveSpace !== false, value => this._patch(settings, {reserveSpace: value}));
        this._offset = spin('Reserve offset', Number(bars[0].reserveOffset) || 0, 0, 64, value => this._patch(settings, {reserveOffset: value}));
        this._autohide = bool('Hide until the pointer hits that edge', bars[0].autohide === true, value => this._patch(settings, {autohide: value}));
        this._length = spin('Bar length (%)', bars[0].length, 20, 100, value => this._patch(settings, {length: value}));
        this._floating = bool('Floating bar', bars[0].margin > 0, value => this._patch(settings, {margin: value ? 12 : 0}));
        this._fitContent = bool('Fit dock to its applications', bars[0].fitContent, value => this._patch(settings, {fitContent: value}));
        this._dockMinLength = spin('Minimum dock length (px)', bars[0].dockMinLength, 64, 1200, value => this._patch(settings, {dockMinLength: value}));
        this._margin = spin('Distance from screen edge', bars[0].margin, 0, 64, value => this._patch(settings, {margin: value}));
        this._rounding = spin('Floating panel / dock rounding', bars[0].rounding, 0, 48, value => this._patch(settings, {rounding: value}));
        this._appSpacing = spin('Space between app icons', bars[0].appSpacing, 0, 32, value => this._patch(settings, {appSpacing: value}));
        this._batteryPercentage = bool('Show battery percentage on this bar', bars[0].batteryPercentage, value => this._patch(settings, {batteryPercentage: value}));
        this._running = bool('Show running apps alongside pinned apps', bars[0].runningApps, value => this._patch(settings, {runningApps: value}));
        place.add(this._kind);
        place.add(this._edge);
        place.add(this._showLogo);
        place.add(this._logoPreset);
        place.add(this._logoAction);
        place.add(this._logoIcon);
        place.add(this._floating);
        place.add(this._autohide);
        size.add(this._fitContent);
        size.add(this._dockMinLength);
        size.add(this._length);
        size.add(this._margin);
        size.add(this._rounding);
        size.add(this._running);
        size.add(this._appSpacing);
        size.add(this._batteryPercentage);
        size.add(this._thickness);
        size.add(this._iconSize);
        size.add(this._reserve);
        size.add(this._offset);

        const intro = new Adw.PreferencesGroup({
            title: 'Modules',
            description: 'Items in the same group share one cluster on the bar and one drawer. Put Weather in Clock to show it beside the time. Put Power in Status to open power with quick controls. Empty space is an invisible gap you can place and resize.',
        });
        page.add(intro);
        intro.add(settingSwitch(settings, 'edit-mode', 'Rearrange by dragging on the bar'));
        if (settings.settings_schema.has_key('date-format'))
            intro.add(combo(settings, 'date-format', 'Date format', Object.entries(DATE_FORMATS).map(([id, item]) => [id, item.label])));
        this._loadBar(settings);
        return page;
    }

    _refreshCombo(settings) {
        const bars = readBars(settings);
        this._writing = true;
        this._barCombo.model = new Gtk.StringList({strings: bars.map((bar, index) => barLabel(bar, index))});
        this._barCombo.selected = this._barIndex;
        if (this._appsBarCombo) {
            this._appsBarCombo.model = new Gtk.StringList({strings: bars.map((bar, index) => barLabel(bar, index))});
            this._appsBarCombo.selected = this._barIndex;
        }
        this._refreshIndicators(settings);
        this._writing = false;
        this._loadBar(settings);
    }

    _loadBar(settings) {
        const bar = readBars(settings)[this._barIndex];
        if (!bar)
            return;
        this._writing = true;
        if (this._appsBarCombo)
            this._appsBarCombo.selected = this._barIndex;
        this._logoAction.selected = ['launcher', 'overview', 'apps'].indexOf(bar.logoAction);
        this._logoIcon.text = bar.logoIcon;
        this._showLogo.active = bar.modules.some(item => item.id === 'logo');
        this._logoPreset.selected = Math.max(0, LOGOS.findIndex(([id]) => bar.logoIcon === `distro:${id}`) + 1);
        const file = logoFile(bar.logoIcon);
        if (file) this._logoImage.set_from_file(file.get_path());
        else this._logoImage.set_from_icon_name(bar.logoIcon);
        this._kind.selected = bar.kind === 'dock' ? 1 : 0;
        setSpin(this._length, bar.length);
        this._length.sensitive = bar.kind !== 'dock' || !bar.fitContent;
        this._floating.active = bar.margin > 0;
        this._fitContent.active = bar.fitContent;
        this._fitContent.visible = bar.kind === 'dock';
        this._dockMinLength.visible = bar.kind === 'dock' && bar.fitContent;
        setSpin(this._dockMinLength, bar.dockMinLength);
        setSpin(this._margin, bar.margin);
        setSpin(this._rounding, bar.rounding);
        this._running.active = bar.runningApps;
        setSpin(this._appSpacing, bar.appSpacing);
        this._batteryPercentage.active = bar.batteryPercentage;
        this._edge.selected = Math.max(0, EDGES.findIndex(([id]) => id === bar.edge));
        setSpin(this._thickness, bar.thickness);
        setSpin(this._iconSize, bar.iconSize || 22);
        this._reserve.active = bar.reserveSpace !== false;
        setSpin(this._offset, Number(bar.reserveOffset) || 0);
        this._autohide.active = bar.autohide === true;
        this._removeRow.sensitive = readBars(settings).length > 1;
        this._addRow.sensitive = readBars(settings).length < 4;
        this._writing = false;
        this._renderModules(settings);
        this._renderApps(settings);
    }

    _patch(settings, values) {
        if (this._writing)
            return;
        const bars = readBars(settings);
        bars[this._barIndex] = {...bars[this._barIndex], ...values};
        saveBars(settings, bars);
        if (['edge', 'kind', 'margin', 'fitContent'].some(key => key in values))
            this._refreshCombo(settings);
    }

    _replaceGroupRows(section, key, rows) {
        for (const row of this._moduleRows.get(key) ?? [])
            section.remove(row);
        this._moduleRows.set(key, rows);
        for (const row of rows)
            section.add(row);
    }

    _renderModules(settings) {
        const scroll = pageScrollValue(this._modulesPage);
        this._writing = true;
        const bar = readBars(settings)[this._barIndex];
        this._showLogo.active = bar.modules.some(item => item.id === 'logo');
        const sections = [
            ['clock', 'Clock group', 'One cluster and the calendar drawer. Add Weather here to show it beside the time.'],
            ['status', 'Status group', 'One cluster and a combined drawer. Add Power here to open it with quick controls.'],
            ['tools', 'Tools group', 'A spare cluster for mixing modules.'],
            ['', 'On their own', 'Enabled modules that are not in a cluster. Add empty space here to offset items.'],
        ];
        if (!this._moduleGroupMap) {
            this._moduleGroupMap = new Map();
            for (const [groupId, title, description] of sections) {
                const section = new Adw.PreferencesGroup({title, description});
                this._modulesPage.add(section);
                this._moduleGroupMap.set(groupId, section);
            }
            const available = new Adw.PreferencesGroup({title: 'Available',
                description: 'Turn a module on, then add it to a group if you want it clustered.'});
            this._modulesPage.add(available);
            this._moduleGroupMap.set('available', available);
        }
        const used = new Set(bar.modules.map(item => item.id));
        for (const [groupId, title] of sections) {
            const items = groupId
                ? bar.modules.filter(item => item.group === groupId && !isSpacer(item.id))
                : bar.modules.filter(item => !item.group);
            const rows = items.map(item => this._moduleRow(settings, item.id, item));
            if (!groupId && nextSpacerId(bar.modules)) {
                const addSpace = new Adw.ButtonRow({title: 'Add empty space'});
                addSpace.connect('activated', () => {
                    if (this._writing)
                        return;
                    const current = readBars(settings)[this._barIndex];
                    const id = nextSpacerId(current.modules);
                    if (!id)
                        return;
                    const insertAt = current.modules.findIndex(item => !isSpacer(item.id));
                    const modules = [...current.modules];
                    modules.splice(insertAt < 0 ? 0 : insertAt, 0, {id, place: 'start', group: '', size: 24});
                    this._patch(settings, {modules});
                    this._renderModules(settings);
                });
                rows.push(addSpace);
            }
            if (groupId) {
                const addable = MODULES.filter(([id]) => !items.some(item => item.id === id));
                if (addable.length) {
                    const add = new Adw.ComboRow({
                        title: `Add to ${title.replace(' group', '')}`,
                        model: new Gtk.StringList({strings: addable.map(([, name]) => name)}),
                    });
                    const button = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
                    button.add_css_class('suggested-action');
                    button.connect('clicked', () => {
                        if (this._writing)
                            return;
                        const [id] = addable[add.selected] ?? [];
                        if (!id)
                            return;
                        const current = readBars(settings)[this._barIndex];
                        this._patch(settings, {modules: [...current.modules.filter(item => item.id !== id),
                            {id, place: current.modules.find(item => item.id === id)?.place ?? PLACES[id], group: groupId}]});
                        this._renderModules(settings);
                    });
                    add.add_suffix(button);
                    rows.push(add);
                }
            }
            this._replaceGroupRows(this._moduleGroupMap.get(groupId), groupId, rows);
        }
        const unused = MODULES.filter(([id]) => !used.has(id));
        const available = this._moduleGroupMap.get('available');
        this._replaceGroupRows(available, 'available', unused.map(([id]) => this._moduleRow(settings, id, null)));
        available.visible = unused.length > 0;
        this._writing = false;
        restorePageScroll(this._modulesPage, scroll);
    }

    _moduleRow(settings, id, item) {
        const spacer = isSpacer(id);
        const row = new Adw.ActionRow({
            title: spacer ? spacerLabel(id) : MODULES.find(([key]) => key === id)?.[1] ?? id,
            subtitle: spacer ? 'Invisible gap. Turn on edit mode to see and drag it.' : '',
        });
        const position = new Gtk.DropDown({
            model: new Gtk.StringList({strings: ['Start', 'Center', 'End']}),
            selected: ['start', 'center', 'end'].indexOf(item?.place ?? PLACES[id] ?? 'center'),
            valign: Gtk.Align.CENTER, sensitive: Boolean(item),
        });
        position.connect('notify::selected', () => {
            if (this._writing)
                return;
            const current = readBars(settings)[this._barIndex];
            this._patch(settings, {modules: current.modules.map(module => module.id === id
                ? {...module, place: ['start', 'center', 'end'][position.selected]} : module)});
        });
        row.add_suffix(position);
        if (item) {
            const shift = delta => {
                if (this._writing)
                    return;
                const current = readBars(settings)[this._barIndex];
                const index = current.modules.findIndex(module => module.id === id);
                const next = index + delta;
                if (index < 0 || next < 0 || next >= current.modules.length)
                    return;
                const modules = [...current.modules];
                const [moved] = modules.splice(index, 1);
                modules.splice(next, 0, moved);
                this._patch(settings, {modules});
                this._renderModules(settings);
            };
            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Move earlier on the bar',
            });
            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Move later on the bar',
            });
            up.connect('clicked', () => shift(-1));
            down.connect('clicked', () => shift(1));
            row.add_suffix(up);
            row.add_suffix(down);
        }
        if (spacer && item) {
            const size = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower: 8, upper: 400, value: item.size ?? 24, step_increment: 4}),
                valign: Gtk.Align.CENTER,
            });
            size.connect('value-changed', () => {
                if (this._writing)
                    return;
                const current = readBars(settings)[this._barIndex];
                this._patch(settings, {modules: current.modules.map(module => module.id === id
                    ? {...module, size: size.get_value()} : module)});
            });
            row.add_suffix(size);
        } else {
            const group = new Gtk.DropDown({
                model: new Gtk.StringList({strings: GROUP_CHOICES.map(([, title]) => title)}),
                selected: Math.max(0, GROUP_CHOICES.findIndex(([key]) => key === (item?.group ?? ''))),
                valign: Gtk.Align.CENTER, sensitive: Boolean(item),
            });
            group.connect('notify::selected', () => {
                if (this._writing)
                    return;
                const current = readBars(settings)[this._barIndex];
                this._patch(settings, {modules: current.modules.map(module => module.id === id
                    ? {...module, group: GROUP_CHOICES[group.selected][0]} : module)});
                this._renderModules(settings);
            });
            row.add_suffix(group);
        }
        const enabled = new Gtk.Switch({active: Boolean(item), valign: Gtk.Align.CENTER});
        enabled.connect('notify::active', () => {
            if (this._writing)
                return;
            const current = readBars(settings)[this._barIndex].modules;
            this._patch(settings, {modules: enabled.active
                ? [...current, {id, place: PLACES[id] ?? 'center', group: DEFAULT_GROUPS[id] ?? '',
                    ...(spacer ? {size: 24} : {})}]
                : current.filter(module => module.id !== id)});
            this._renderModules(settings);
        });
        row.add_suffix(enabled);
        return row;
    }

    _launcherPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Launcher', icon_name: 'system-search-symbolic'});
        const launcher = new Adw.PreferencesGroup({title: 'Applications at your fingertips',
            description: 'Choose independent shortcuts for the searchable launcher and GNOME Overview. Alt+Tab remains the GNOME app switcher. Super alone can keep its normal Overview behavior.'});
        this._superLauncher = choice('Super key alone', settings.get_boolean('super-launcher'), [[false, 'GNOME Overview'], [true, 'Bezel launcher']], value => settings.set_boolean('super-launcher', value));
        launcher.add(this._superLauncher);
        launcher.add(this._shortcutRow(settings, 'launcher-shortcut', 'Launcher shortcut'));
        launcher.add(this._shortcutRow(settings, 'overview-shortcut', 'Overview shortcut'));
        const recommended = new Adw.ActionRow({title: 'Super for Overview · Super+Space for launcher',
            subtitle: 'Temporarily replaces GNOME’s Super+Space input-source shortcut while Bezel is enabled.'});
        const useShortcuts = new Gtk.Button({label: 'Use this setup', valign: Gtk.Align.CENTER});
        this._recommendedShortcuts = useShortcuts;
        recommended.add_suffix(useShortcuts);
        recommended.activatable_widget = useShortcuts;
        useShortcuts.connect('clicked', () => {
            settings.set_boolean('super-launcher', false);
            settings.set_strv('overview-shortcut', []);
            settings.set_strv('launcher-shortcut', ['<Super>space']);
            this._refreshShortcutLabels(settings);
        });
        launcher.add(recommended);
        launcher.add(spin('Launcher width', settings.get_int('launcher-width'), 360, 1000, value => settings.set_int('launcher-width', value)));
        page.add(launcher);
        const indicators = new Adw.PreferencesGroup({title: 'Extension panel icons',
            description: 'Automatically adopts third-party GNOME panel indicators and their existing menus. Icons appear once on the primary monitor. Automatic placement prefers a horizontal panel. Select any existing bar below. Disabling this returns them to the GNOME panel.'});
        indicators.add(settingSwitch(settings, 'panel-indicators', 'Show extension panel indicators'));
        indicators.add(choice('Extension icons', settings.get_string('indicator-side') === 'before',
            [[false, 'After the widgets'], [true, 'Before the widgets']],
            value => settings.set_string('indicator-side', value ? 'before' : 'after')));
        this._indicatorCombo = new Adw.ComboRow({title: 'Bar for extension icons'});
        this._refreshIndicators(settings);
        this._indicatorCombo.connect('notify::selected', () => {
            if (!this._writing) settings.set_int('indicator-bar', this._indicatorCombo.selected);
        });
        indicators.add(this._indicatorCombo);
        indicators.add(settingSpin(settings, 'indicator-icon-size', 'Extension icon size', 12, 40));
        indicators.add(settingSpin(settings, 'indicator-spacing', 'Space between extensions', 0, 40));
        this._indicatorOrderGroup = new Adw.PreferencesGroup({title: 'Extension icon order',
            description: 'Move extensions earlier or later along the selected bar. New extensions appear here after reopening preferences.'});
        this._indicatorOrderRows = [];
        page.add(this._indicatorOrderGroup);
        page.add(indicators);
        this._launcherPageWidget = page;
        this._renderIndicatorOrder(settings);
        return page;
    }

    _renderIndicatorOrder(settings) {
        if (!this._indicatorOrderGroup)
            return;
        const scroll = pageScrollValue(this._launcherPageWidget);
        for (const row of this._indicatorOrderRows ?? [])
            this._indicatorOrderGroup.remove(row);
        this._indicatorOrderRows = [];
        const names = [...new Set([...settings.get_strv('indicator-order'), ...settings.get_strv('known-indicators')])];
        for (const [index, name] of names.entries()) {
            const row = new Adw.ActionRow({title: name});
            const shown = new Gtk.Switch({active: !settings.get_strv('hidden-indicators').includes(name),
                valign: Gtk.Align.CENTER, tooltip_text: 'Show on Bezel'});
            shown.connect('notify::active', () => {
                const hidden = settings.get_strv('hidden-indicators').filter(role => role !== name);
                if (!shown.active) hidden.push(name);
                settings.set_strv('hidden-indicators', hidden);
            });
            row.add_suffix(shown);
            for (const [offset, icon] of [[-1, 'go-up-symbolic'], [1, 'go-down-symbolic']]) {
                const button = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER,
                    sensitive: index + offset >= 0 && index + offset < names.length,
                    tooltip_text: offset < 0 ? 'Move earlier' : 'Move later'});
                button.connect('clicked', () => {
                    const reordered = [...names];
                    [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
                    settings.set_strv('indicator-order', reordered);
                    this._renderIndicatorOrder(settings);
                });
                row.add_suffix(button);
            }
            this._indicatorOrderGroup.add(row);
            this._indicatorOrderRows.push(row);
        }
        restorePageScroll(this._launcherPageWidget, scroll);
    }

    _shortcutRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const value = settings.get_strv(key)[0];
        const [valid, keyval, mods] = Gtk.accelerator_parse(value ?? '');
        this._shortcutButtons ??= {};
        const button = new Gtk.Button({label: valid ? Gtk.accelerator_get_label(keyval, mods) : 'Set shortcut…', valign: Gtk.Align.CENTER});
        this._shortcutButtons[key] = button;
        button.connect('clicked', () => {
            const dialog = new Adw.Window({title, transient_for: this._window, modal: true, default_width: 510, default_height: 220});
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 20});
            box.append(new Adw.HeaderBar());
            const hint = new Gtk.Label({label: 'Press a key combination. Escape cancels; Backspace clears.\nInput-source conflicts are restored when Bezel is disabled.', wrap: true, margin_start: 24, margin_end: 24, margin_bottom: 24});
            box.append(hint);
            // Let the recorder receive combinations already grabbed by the compositor.
            dialog.connect('map', () => dialog.get_surface()?.inhibit_system_shortcuts(null));
            dialog.connect('close-request', () => {
                dialog.get_surface()?.restore_system_shortcuts();
                this._shortcutDialog = null;
                this._shortcutController = null;
                return false;
            });
            const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
            this._shortcutDialog = dialog;
            this._shortcutController = controller;
            controller.connect('key-pressed', (_controller, keyval, _code, state) => {
                if (keyval === Gdk.KEY_Escape) { dialog.close(); return true; }
                if (keyval === Gdk.KEY_BackSpace) { settings.set_strv(key, []); dialog.close(); this._refreshShortcutLabels(settings); return true; }
                const mods = state & Gtk.accelerator_get_default_mod_mask();
                if (!Gtk.accelerator_valid(keyval, mods) || !(mods & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK))) return true;
                const accelerator = Gtk.accelerator_name(keyval, mods);
                const other = key === 'launcher-shortcut' ? 'overview-shortcut' : 'launcher-shortcut';
                if (settings.get_strv(other).includes(accelerator)) { hint.label = 'That shortcut already opens the other Bezel action. Choose another.'; return true; }
                const conflict = shortcutConflict(accelerator);
                if (conflict) { hint.label = `Already assigned to ${conflict}. Change it in GNOME Keyboard settings or choose another combination.`; return true; }
                settings.set_strv(key, [accelerator]);
                dialog.close();
                this._refreshShortcutLabels(settings);
                return true;
            });
            dialog.add_controller(controller);
            dialog.set_content(box);
            dialog.present();
        });
        row.add_suffix(button);
        const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', tooltip_text: 'Clear shortcut', valign: Gtk.Align.CENTER});
        clear.connect('clicked', () => { settings.set_strv(key, []); this._refreshShortcutLabels(settings); });
        row.add_suffix(clear);
        return row;
    }

    _refreshShortcutLabels(settings) {
        for (const key of ['launcher-shortcut', 'overview-shortcut']) {
            const button = this._shortcutButtons?.[key];
            if (!button)
                continue;
            const value = settings.get_strv(key)[0];
            const [valid, keyval, mods] = Gtk.accelerator_parse(value ?? '');
            button.label = valid ? Gtk.accelerator_get_label(keyval, mods) : 'Set shortcut…';
        }
        if (this._superLauncher)
            this._superLauncher.selected = settings.get_boolean('super-launcher') ? 1 : 0;
    }

    _refreshIndicators(settings) {
        if (!this._indicatorCombo) return;
        const writing = this._writing;
        this._writing = true;
        this._indicatorCombo.model = new Gtk.StringList({strings: ['Automatic', ...readBars(settings).map(barLabel)]});
        this._indicatorCombo.selected = Math.min(settings.get_int('indicator-bar'), readBars(settings).length);
        this._writing = writing;
    }

    _appsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Apps', icon_name: 'view-app-grid-symbolic'});
        const picker = new Adw.PreferencesGroup();
        this._appsBarCombo = new Adw.ComboRow({title: 'Bar to customize',
            model: new Gtk.StringList({strings: readBars(settings).map((bar, index) => barLabel(bar, index))}),
            selected: this._barIndex});
        this._appsBarCombo.connect('notify::selected', () => {
            if (!this._writing)
                this._barCombo.selected = this._appsBarCombo.selected;
        });
        picker.add(this._appsBarCombo);
        page.add(picker);
        this._appsGroup = new Adw.PreferencesGroup({title: 'Pinned apps', description: 'These pins belong only to that Bezel bar; adding or removing them never changes GNOME or Dash to Dock favorites. Right-click an app on the bar to pin or unpin it.'});
        this._appRows = [];
        page.add(this._appsGroup);
        const add = new Adw.ButtonRow({title: 'Add applications', start_icon_name: 'list-add-symbolic'});
        add.connect('activated', () => this._appPicker(settings));
        const actions = new Adw.PreferencesGroup(); actions.add(add); page.add(actions);
        this._renderApps(settings);
        return page;
    }

    _renderApps(settings) {
        if (!this._appsGroup)
            return;
        for (const row of this._appRows)
            this._appsGroup.remove(row);
        this._appRows = [];
        const bar = readBars(settings)[this._barIndex];
        this._appsGroup.title = `Pinned apps · ${barLabel(bar, this._barIndex)}`;
        for (const [index, id] of bar.pinned.entries()) {
            const app = Gio.DesktopAppInfo.new(id.slice(4));
            const row = new Adw.ActionRow({title: app?.get_display_name() ?? id.slice(4), subtitle: id.slice(4)});
            if (app?.get_icon())
                row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 32}));
            for (const [offset, icon, tooltip] of [[-1, 'go-up-symbolic', 'Move earlier'], [1, 'go-down-symbolic', 'Move later'], [0, 'user-trash-symbolic', 'Unpin']]) {
                const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER});
                button.add_css_class('flat');
                button.connect('clicked', () => {
                    const pinned = [...readBars(settings)[this._barIndex].pinned];
                    if (!offset)
                        pinned.splice(index, 1);
                    else if (index + offset >= 0 && index + offset < pinned.length)
                        [pinned[index], pinned[index + offset]] = [pinned[index + offset], pinned[index]];
                    this._patch(settings, {pinned});
                    this._renderApps(settings);
                });
                row.add_suffix(button);
            }
            this._appsGroup.add(row);
            this._appRows.push(row);
        }
        if (!bar.pinned.length) {
            const empty = new Adw.ActionRow({title: 'No pinned apps yet', subtitle: 'Add applications below, or pin a running app from its right-click menu.'});
            this._appsGroup.add(empty); this._appRows.push(empty);
        }
    }

    _appPicker(settings) {
        const selectedBar = this._barIndex;
        const dialog = new Adw.Window({title: 'Add applications', transient_for: this._window, modal: true, default_width: 520, default_height: 620});
        const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        root.append(new Adw.HeaderBar());
        const search = new Gtk.SearchEntry({placeholder_text: 'Search installed applications', margin_start: 18, margin_end: 18});
        root.append(search);
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, margin_start: 18, margin_end: 18, margin_bottom: 18});
        list.add_css_class('boxed-list');
        const scroll = new Gtk.ScrolledWindow({vexpand: true, child: list}); root.append(scroll);
        for (const app of Gio.AppInfo.get_all().filter(app => app.should_show() && app.get_id()).sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))) {
            const row = new Adw.ActionRow({title: app.get_display_name(), subtitle: app.get_id()});
            row._search = `${app.get_display_name()} ${app.get_id()}`.toLowerCase();
            row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 28}));
            const id = `app:${app.get_id()}`;
            const toggle = new Gtk.CheckButton({active: readBars(settings)[selectedBar].pinned.includes(id), valign: Gtk.Align.CENTER});
            toggle.connect('toggled', () => {
                const bars = readBars(settings);
                if (!bars[selectedBar])
                    return;
                bars[selectedBar].pinned = toggle.active ? [...new Set([...bars[selectedBar].pinned, id])] : bars[selectedBar].pinned.filter(value => value !== id);
                // The Apps module is what gives a dock its running-app behavior.
                if (!bars[selectedBar].modules.some(module => module.id === 'apps'))
                    bars[selectedBar].modules.push({id: 'apps', place: 'start'});
                saveBars(settings, bars);
                this._renderApps(settings);
                this._renderModules(settings);
            });
            row.add_suffix(toggle); list.append(row);
        }
        list.set_filter_func(row => row._search.includes(search.text.toLowerCase()));
        search.connect('search-changed', () => list.invalidate_filter());
        dialog.set_content(root); dialog.present(); search.grab_focus();
    }

    _borderPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Frame & motion', icon_name: 'window-new-symbolic'});
        const weather = new Adw.PreferencesGroup({
            title: 'Weather',
            description: 'Uses GNOME Weather for location, units and forecasts. Put Weather in the Clock group on the Bar page to show it beside the time. The dashboard can also show a short forecast.',
        });
        page.add(weather);
        weather.add(settingSwitch(settings, 'weather-dashboard', 'Show weather on the dashboard'));
        const frame = new Adw.PreferencesGroup({
            title: 'Screen border',
            description: 'Thickness is the thin sides. The bar side uses the bar thickness. Inner corners use the radius.',
        });
        page.add(frame);
        frame.add(settingSwitch(settings, 'show-frame', 'Show border'));
        frame.add(settingSpin(settings, 'frame-width', 'Thin side thickness', 4, 48));
        frame.add(settingSpin(settings, 'frame-radius', 'Inner corner radius', 0, 80));
        frame.add(settingSpin(settings, 'frame-shadow', 'Inner frame shadow', 0, 24));
        frame.add(settingSpin(settings, 'dashboard-width', 'Dashboard width', 480, 1200));
        frame.add(settingSwitch(settings, 'hide-gnome-panel', 'Hide the GNOME top bar'));
        frame.add(settingSwitch(settings, 'hide-overview-dock', 'Hide the GNOME overview dock'));
        frame.add(settingSwitch(settings, 'frame-notifications', 'Show arriving notifications on the frame'));
        const motion = new Adw.PreferencesGroup({
            title: 'Hover and motion',
            description: 'Opening a drawer only redraws the frame tiles around it. Keep hover delays short if a drawer feels late.',
        });
        page.add(motion);
        motion.add(settingSwitch(settings, 'edge-panels', 'Hover top-center for dashboard'));
        motion.add(settingSwitch(settings, 'power-hover', 'Also hover bottom-center for power'));
        motion.add(settingSwitch(settings, 'status-hover', 'Open quick controls on hover'));
        motion.add(settingSwitch(settings, 'clock-hover', 'Open calendar when hovering the clock'));
        motion.add(settingSwitch(settings, 'power-button-hover', 'Open power menu when hovering its button'));
        motion.add(settingSwitch(settings, 'dashboard-hover', 'Open dashboard when hovering its button'));
        motion.add(settingSpin(settings, 'hover-delay', 'Hover delay (ms)', 100, 1000));
        motion.add(settingSpin(settings, 'animation-duration', 'Drawer animation (ms, 0 disables)', 0, 800));
        const positions = new Adw.PreferencesGroup({
            title: 'Drawer positions',
            description: 'Icon follows the button. Corners join this monitor’s frame. Arriving banners use the notification position.',
        });
        page.add(positions);
        for (const [id, title] of [['power', 'Power'], ['dashboard', 'Dashboard'], ['notifications', 'Notification history']])
            positions.add(choice(`${title} position`, settings.get_string(`${id}-position`),
                [['icon', 'At the icon'], ['right', 'Right centre'], ['left', 'Left centre'],
                 ['top-left', 'Top left'], ['top-center', 'Top centre'],
                 ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom centre'],
                 ['bottom-right', 'Bottom right']], value => settings.set_string(`${id}-position`, value)));
        if (settings.settings_schema.has_key('power-style')) {
            const style = choice('Power menu style', settings.get_string('power-style'),
                [['list', 'Icons and labels'], ['rail', 'Icons only']],
                value => settings.set_string('power-style', value));
            style.subtitle = 'Changes the buttons’ appearance. Power position controls where the menu opens.';
            positions.add(style);
        }
        if (settings.settings_schema.has_key('slider-style'))
            positions.add(choice('Volume and brightness', settings.get_string('slider-style'),
                [['drawer', 'Inside quick controls'], ['edge', 'Right-edge sliders on hover']],
                value => settings.set_string('slider-style', value)));
        if (settings.settings_schema.has_key('session-dim'))
            positions.add(settingSwitch(settings, 'session-dim', 'Dim the desktop behind the power menu'));
        return page;
    }

    _lookPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Look', icon_name: 'preferences-color-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Palette'});
        page.add(group);
        group.add(combo(settings, 'theme', 'Palette', [
            ...PRESETS.map(item => [item.id, item.name]),
            ['custom', 'Custom'],
        ]));
        const custom = new Adw.PreferencesGroup({title: 'Custom palette', description: 'Choose colours with the picker or enter #RRGGBB / #RGB, then select Custom above.'});
        for (const [key, title] of [['bg', 'Frame'], ['surface', 'Cards'], ['fg', 'Text'], ['muted', 'Secondary text'], ['accent', 'Accent'], ['border', 'Dividers']]) {
            const row = new Adw.EntryRow({title, text: settings.get_string(`custom-${key}`), show_apply_button: true});
            row.connect('apply', () => {
                if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(row.text)) {
                    settings.set_string(`custom-${key}`, row.text);
                    row.remove_css_class('error');
                } else {
                    row.add_css_class('error');
                }
            });
            const rgba = new Gdk.RGBA();
            rgba.parse(row.text);
            const picker = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false}),
                rgba, valign: Gtk.Align.CENTER, tooltip_text: `Choose ${title.toLowerCase()} colour`});
            picker.connect('notify::rgba', () => {
                const color = picker.rgba;
                const hex = '#' + [color.red, color.green, color.blue].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
                row.text = hex;
                row.remove_css_class('error');
                settings.set_string(`custom-${key}`, hex);
            });
            row.connect('apply', () => {
                const color = new Gdk.RGBA();
                if (color.parse(settings.get_string(`custom-${key}`))) picker.rgba = color;
            });
            row.add_suffix(picker);
            custom.add(row);
        }
        page.add(custom);
        return page;
    }
}

function pageScroller(page) {
    if (!page)
        return null;
    const visit = widget => {
        if (widget instanceof Gtk.ScrolledWindow)
            return widget;
        for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling()) {
            const found = visit(child);
            if (found)
                return found;
        }
        return null;
    };
    return visit(page);
}

function pageScrollValue(page) {
    return pageScroller(page)?.get_vadjustment()?.value ?? 0;
}

function restorePageScroll(page, value) {
    const apply = () => {
        const adjustment = pageScroller(page)?.get_vadjustment();
        if (adjustment)
            adjustment.value = Math.min(value, Math.max(0, adjustment.upper - adjustment.page_size));
        return GLib.SOURCE_REMOVE;
    };
    if (pageScroller(page)?.get_vadjustment())
        apply();
    else
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, apply);
}

function barLabel(bar, index) {
    const edge = EDGES.find(([id]) => id === bar.edge)?.[1] ?? 'Bar';
    return `${edge} bar ${index + 1}`;
}

function setSpin(row, value) {
    row._spin?.set_value(value);
}

function choice(title, current, choices, onChange) {
    const row = new Adw.ComboRow({
        title,
        model: new Gtk.StringList({strings: choices.map(([, label]) => label)}),
        selected: Math.max(0, choices.findIndex(([id]) => id === current)),
    });
    row.connect('notify::selected', () => onChange(choices[row.selected][0]));
    return row;
}

function spin(title, value, min, max, onChange) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower: min, upper: max, value, step_increment: 1}),
        valign: Gtk.Align.CENTER,
    });
    button.connect('value-changed', () => onChange(button.get_value()));
    row.add_suffix(button);
    row._spin = button;
    return row;
}

function bool(title, value, onChange) {
    const row = new Adw.SwitchRow({title, active: value});
    row.connect('notify::active', () => onChange(row.active));
    return row;
}

function settingSwitch(settings, key, title) {
    const available = settings.settings_schema.has_key(key);
    const row = new Adw.SwitchRow({title, active: available && settings.get_boolean(key), sensitive: available});
    row.connect('notify::active', () => {
        if (settings.settings_schema.has_key(key))
            settings.set_boolean(key, row.active);
    });
    return row;
}

function settingSpin(settings, key, title, min, max) {
    return spin(title, settings.get_int(key), min, max, value => settings.set_int(key, value));
}

function combo(settings, key, title, choices) {
    return choice(title, settings.get_string(key), choices, value => settings.set_string(key, value));
}

function shortcutConflict(accelerator) {
    const [, keyval, mods] = Gtk.accelerator_parse(accelerator);
    for (const schema of ['org.gnome.desktop.wm.keybindings', 'org.gnome.shell.keybindings', 'org.gnome.mutter.keybindings', 'org.gnome.mutter.wayland.keybindings']) {
        if (!Gio.SettingsSchemaSource.get_default().lookup(schema, true)) continue;
        const settings = new Gio.Settings({schema_id: schema});
        for (const key of settings.settings_schema.list_keys()) {
            if (['switch-input-source', 'switch-input-source-backward'].includes(key)) continue;
            const value = settings.get_value(key);
            if (value.get_type_string() !== 'as') continue;
            if (value.deepUnpack().some(binding => {
                const [valid, candidate, modifiers] = Gtk.accelerator_parse(binding);
                return valid && candidate === keyval && modifiers === mods;
            })) return key.replaceAll('-', ' ');
        }
    }
    return null;
}
