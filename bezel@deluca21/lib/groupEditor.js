import {moduleType} from './moduleIdentity.js';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import {barGroups, readBars, switchOn} from './config.js';
import {patchGroup, patchModule} from './settingsModel.js';
import {GROUP_ITEMS, groupLayoutPreset, groupRows, moveGroupCell, newLayoutId, normalizeGroupLayout} from './groupLayout.js';

const column = () => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10, hexpand: true});
const row = () => new Gtk.Box({spacing: 6, hexpand: true});
const text = (value, expand = false) => new Gtk.Label({label: value, xalign: 0, wrap: true, hexpand: expand});
const button = (title, run) => { const b = new Gtk.Button({label: title}); b.connect('clicked', run); return b; };
const clone = value => JSON.parse(JSON.stringify(value));

export function buildGroupEditor(owner, bar) {
    const group = barGroups(bar).find(group => group.id === owner.groupId);
    if (!group) { owner.groupId = null; owner._barCard(bar); return; }
    const members = bar.modules.filter(item => item.group === group.id);
    const layout = group.popout || groupLayoutPreset('stacked', members.map(item => item.id));
    const root = owner.card;
    const historyKey = `${owner.barIndex}:${group.id}`;
    owner.groupHistory ??= new Map();
    const history = owner.groupHistory.get(historyKey) || [];
    owner.groupHistory.set(historyKey, history);
    const save = (next, remember = true) => {
        if (remember) { history.push(clone(layout)); if (history.length > 30) history.shift(); }
        owner._write(() => patchGroup(owner.settings, owner.barIndex, group.id, {popout: normalizeGroupLayout(next)}), false);
        owner._queueCard();
    };
    const change = run => { const next = clone(layout); run(next); save(next); };
    const requestPreview = open => {
        if (open && !group.popout) owner._write(() => patchGroup(owner.settings, owner.barIndex, group.id, {popout: layout}), false);
        owner.groupPreviewOpen = open;
        owner.settings.set_string('group-preview', JSON.stringify({action: open ? 'open' : 'close', bar: owner.barIndex, group: group.id, token: Date.now()}));
    };
    const head = row();
    head.append(button('Done', () => { requestPreview(false); owner.groupId = null; owner.settings.set_string('preferences-group', ''); owner._queueCard(); }));
    head.append(text(`${group.name} · Popout layout`, true));
    const undo = button('Undo', () => { const previous = history.pop(); if (previous) save(previous, false); });
    undo.sensitive = history.length > 0; head.append(undo); root.append(head);
    root.append(text('Build rows and tabs with any items. This does not add icons to your bar.'));
    root.append(owner._toggle('Show live preview', owner.groupPreviewOpen === true, requestPreview));
    const presets = row();
    for (const [id, title] of [['quick', 'Quick controls'], ['clock', 'Clock & actions'], ['stacked', 'Stacked'], ['tabs', 'Tabs'], ['blank', 'Empty']])
        presets.append(button(title, () => save(groupLayoutPreset(id, members.map(item => item.id)))));
    root.append(presets);
    root.append(owner._step('Popout width', layout.width, 280, 900, 20, value => change(next => { next.width = value; })));
    root.append(owner._step('Spacing', layout.spacing, 0, 32, 2, value => change(next => { next.spacing = value; })));
    root.append(owner._toggle('Hide unavailable hardware', layout.hideUnavailable, value => change(next => { next.hideUnavailable = value; })));

    const popover = (anchor, content) => {
        const pop = new Gtk.Popover(); pop.set_parent(anchor); pop.set_child(content);
        pop.connect('closed', () => { if (pop.get_parent()) pop.unparent(); }); pop.popup(); return pop;
    };
    const drop = (widget, targetRow, beforeId = null) => {
        const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        target.connect('enter', () => { widget.add_css_class('drop-hover'); return Gdk.DragAction.MOVE; });
        target.connect('leave', () => widget.remove_css_class('drop-hover'));
        target.connect('drop', (_target, id) => {
            widget.remove_css_class('drop-hover');
            const item = String(id).replace(/^group-cell:/, '');
            if (!String(id).startsWith('group-cell:')) return false;
            save(moveGroupCell(layout, item, targetRow, beforeId)); return true;
        }); widget.add_controller(target);
    };
    const picker = (anchor, targetRow) => {
        const list = column(); let pop;
        const search = new Gtk.SearchEntry({placeholder_text: 'Find an item'}); list.append(search);
        const choices = column();
        const nativeUsed = new Set(groupRows(layout).flatMap(row => row.cells.map(cell => cell.module)));
        const buttons = [];
        for (const [id, spec] of Object.entries(GROUP_ITEMS)) {
            const b = button(spec.title, () => {
                pop.popdown(); change(next => {
                    const target = groupRows(next).find(row => row.id === targetRow);
                    if (target && target.cells.length < 4) target.cells.push({id: newLayoutId(next), module: id, view: ['logo', 'dashboard', 'screenshot'].includes(id) ? 'action' : 'full', span: 1});
                });
            });
            b.sensitive = !(['output', 'network', 'bluetooth'].includes(id) && nativeUsed.has(id));
            buttons.push([b, spec.title.toLowerCase()]); choices.append(b);
        }
        search.connect('search-changed', () => buttons.forEach(([b, title]) => { b.visible = title.includes(search.text.toLowerCase()); }));
        list.append(new Gtk.ScrolledWindow({child: choices, min_content_height: 220, max_content_height: 320, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));
        pop = popover(anchor, list);
    };
    const options = (anchor, cell) => {
        const box = column(); let pop;
        const edit = run => { pop.popdown(); change(next => {
            const target = groupRows(next).flatMap(row => row.cells).find(item => item.id === cell.id); if (target) run(target);
        }); };
        box.append(text(GROUP_ITEMS[cell.module].title));
        if (cell.module === 'power')
            box.append(owner._segments([['full', 'Power controls'], ['action', 'Open power menu']], cell.view,
                value => edit(item => { item.view = value; }), false));
        box.append(owner._segments([['1', 'Normal width'], ['2', 'Double width'], ['3', 'Triple width']], String(cell.span), value => edit(item => { item.span = Number(value); }), false));
        box.append(text('Width relative to other items in this row. A lone item fills the row.'));
        box.append(owner._toggle('Extra heading', cell.title === true, value => edit(item => { item.title = value; })));
        const moduleId = cell.module === 'brightness' ? 'volume' : cell.module;
        const existing = bar.modules.find(item => item.id === (cell.instance || moduleId));
        if (existing) {
            box.append(text('Module settings · shared with the bar'));
            owner._moduleOptions(box, {...existing}, bar, values => {
                owner._write(() => patchModule(owner.settings, owner.barIndex, existing.id, values), false);
            });
        } else {
            owner._featureOptions(box, {id: moduleId, ...cell.options}, values => edit(item => { item.options = {...item.options, ...values}; }));
            const switches = moduleId === 'volume' ? [['showMute', 'Show mute button'], ['popIcon', 'Icon'], ['popValue', 'Percentage'], ['brightIcon', 'Brightness icon'], ['brightValue', 'Brightness percentage']]
                : moduleId === 'network' ? [['popValue', 'Network name'], ['showToggle', 'Show on/off button']]
                : moduleId === 'microphone' ? [['showMute', 'Show mute button'], ['showIcon', 'Icon'], ['showValue', 'Level']]
                : moduleId === 'bluetooth' ? [['showToggle', 'Show on/off button']] : [];
            if (switches.length) box.append(text('In the popout'));
            for (const [key, title] of switches)
                box.append(owner._toggle(title, switchOn({id: moduleId, ...cell.options}, bar, key), value =>
                    edit(item => { item.options = {...item.options, [key]: value}; })));
        }
        box.append(text('Move to row'));
        for (const [index, target] of groupRows(layout).entries()) {
            const titles = target.cells.filter(item => item.id !== cell.id).map(item => GROUP_ITEMS[item.module].title).join(', ') || 'Empty';
            box.append(button(`Row ${index + 1} · ${titles}`, () => { pop.popdown(); save(moveGroupCell(layout, cell.id, target.id)); }));
        }
        box.append(button('Remove item', () => { pop.popdown(); change(next => { for (const row of groupRows(next)) row.cells = row.cells.filter(item => item.id !== cell.id); }); }));
        owner._closeItemPopover();
        const dialog = new Gtk.Popover({autohide: false}); dialog.set_parent(anchor);
        box.prepend(button('Close', () => dialog.popdown()));
        dialog.set_child(new Gtk.ScrolledWindow({child: box, max_content_height: 500, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));
        pop = dialog; owner.itemPopover = dialog;
        dialog.connect('closed', () => { if (owner.itemPopover === dialog) owner.itemPopover = null; if (dialog.get_parent()) dialog.unparent(); });
        const escape = new Gtk.EventControllerKey();
        escape.connect('key-pressed', (_controller, key) => { if (key !== Gdk.KEY_Escape) return false; dialog.popdown(); return true; });
        dialog.add_controller(escape); dialog.popup();
    };
    const drawRow = (record, container, siblings) => {
        const line = column(); line.add_css_class('group');
        const tools = row(); tools.append(text('Row', true));
        for (const [delta, title] of [[-1, '↑'], [1, '↓']]) tools.append(button(title, () => change(next => {
            const list = siblings(next); const i = list.findIndex(item => item.id === record.id); const at = i + delta;
            if (i >= 0 && at >= 0 && at < list.length) [list[i], list[at]] = [list[at], list[i]];
        })));
        tools.append(button('Remove row', () => change(next => { const list = siblings(next); const i = list.findIndex(item => item.id === record.id); if (i >= 0) list.splice(i, 1); })));
        line.append(tools);
        const chips = row();
        for (const cell of record.cells) {
            const chip = button(GROUP_ITEMS[cell.module].title, () => options(chip, cell)); chip.hexpand = true;
            chip.add_css_class('module-chip'); chip.tooltip_text = 'Drag to move; click for options';
            const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
            drag.connect('prepare', () => { const value = new GObject.Value(); value.init(GObject.TYPE_STRING); value.set_string(`group-cell:${cell.id}`); return Gdk.ContentProvider.new_for_value(value); });
            chip.add_controller(drag); drop(chip, record.id, cell.id); chips.append(chip);
        }
        const add = button('+ Item', () => picker(add, record.id)); add.sensitive = record.cells.length < 4; chips.append(add);
        drop(add, record.id); drop(line, record.id); line.append(chips); container.append(line);
    };
    for (const block of layout.blocks) {
        if (block.type === 'row') { drawRow(block, root, next => next.blocks); continue; }
        const section = column(); section.add_css_class('inset');
        const header = row(); header.append(text('Tabbed section', true));
        for (const [delta, title] of [[-1, '↑'], [1, '↓']]) header.append(button(title, () => change(next => {
            const i = next.blocks.findIndex(item => item.id === block.id); const at = i + delta;
            if (at >= 0 && at < next.blocks.length) [next.blocks[i], next.blocks[at]] = [next.blocks[at], next.blocks[i]];
        })));
        header.append(button('Remove section', () => change(next => { next.blocks = next.blocks.filter(item => item.id !== block.id); })));
        section.append(header);
        const notebook = new Gtk.Notebook({scrollable: true, hexpand: true});
        for (const tab of block.tabs) {
            const page = column(); const toolbar = row();
            const title = new Gtk.Entry({text: tab.title, hexpand: true, placeholder_text: 'Tab name'});
            title.connect('activate', () => change(next => { next.blocks.find(item => item.id === block.id).tabs.find(item => item.id === tab.id).title = title.text; }));
            toolbar.append(title);
            for (const [delta, name] of [[-1, '←'], [1, '→']]) toolbar.append(button(name, () => change(next => {
                const tabs = next.blocks.find(item => item.id === block.id).tabs;
                const i = tabs.findIndex(item => item.id === tab.id); const at = i + delta;
                if (at >= 0 && at < tabs.length) [tabs[i], tabs[at]] = [tabs[at], tabs[i]];
            })));
            toolbar.append(button('Remove tab', () => change(next => { const section = next.blocks.find(item => item.id === block.id); section.tabs = section.tabs.filter(item => item.id !== tab.id); })));
            page.append(toolbar);
            const rows = next => next.blocks.find(item => item.id === block.id).tabs.find(item => item.id === tab.id).rows;
            for (const record of tab.rows) drawRow(record, page, rows);
            page.append(button('+ Row', () => change(next => rows(next).push({type: 'row', id: newLayoutId(next, 'row'), cells: []}))));
            const tabLabel = new Gtk.Label({label: tab.title});
            notebook.append_page(page, tabLabel);
        }
        owner.groupEditorTabs ??= new Map();
        const tabKey = `${historyKey}:${block.id}`;
        const selected = block.tabs.findIndex(tab => tab.id === owner.groupEditorTabs.get(tabKey));
        if (selected >= 0) notebook.set_current_page(selected);
        notebook.connect('switch-page', (_book, _page, index) => owner.groupEditorTabs.set(tabKey, block.tabs[index]?.id));
        section.append(notebook);
        section.append(button('+ Tab', () => change(next => {
            const section = next.blocks.find(item => item.id === block.id);
            if (section.tabs.length < 8) section.tabs.push({id: newLayoutId(next, 'tab'), title: `Tab ${section.tabs.length + 1}`, rows: [{type: 'row', id: newLayoutId(next, 'row'), cells: []}]});
        })));
        root.append(section);
    }
    const add = row();
    add.append(button('+ Row', () => change(next => next.blocks.push({type: 'row', id: newLayoutId(next, 'row'), cells: []}))));
    add.append(button('+ Tabs', () => change(next => next.blocks.push({type: 'tabs', id: newLayoutId(next, 'tabs'), tabs: [{id: newLayoutId(next, 'tab'), title: 'Tab 1', rows: [{type: 'row', id: newLayoutId(next, 'row'), cells: []}]}]}))));
    root.append(add);
    root.append(text('On the bar'));
    const groupChange = values => { owner._write(() => patchGroup(owner.settings, owner.barIndex, group.id, values), false); owner._queueCard(); };
    root.append(owner._segments([['modules', 'Individual items'], ['single', 'One group icon']], group.face || 'modules', value => groupChange({face: value}), false));
    if (group.face === 'single') {
        const icon = new Gtk.Entry({text: group.icon || 'view-grid-symbolic', placeholder_text: 'Group icon name'});
        icon.connect('activate', () => groupChange({icon: icon.text})); root.append(icon);
    } else for (const member of members.filter(item => GROUP_ITEMS[moduleType(item.id)] && !['workspaces', 'apps'].includes(moduleType(item.id)))) {
        root.append(text(`${GROUP_ITEMS[moduleType(member.id)].title} click`));
        root.append(owner._segments([['group', 'Open group'], ['tab', 'Matching tab'], ['direct', 'Own action']], group.clicks?.[member.id] || 'group',
            value => groupChange({clicks: {...group.clicks, [member.id]: value}}), false));
    }
    root.append(button('Use automatic group popout', () => {
        requestPreview(false); groupChange({popout: undefined}); owner.groupId = null;
    }));
}
