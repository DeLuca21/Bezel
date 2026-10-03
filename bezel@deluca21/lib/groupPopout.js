import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {groupTabStyle} from './quickControls.js';
import {GROUP_ITEMS, groupRows} from './groupLayout.js';

export function buildGroupPopout(bar, group, initialModule = null) {
    const layout = group.popout;
    const width = Math.min(layout.width, bar._monitor.width - bar._side.left - bar._side.right - 32);
    bar._popupWidth = width;
    bar._popout.width = width;
    const inner = Math.max(160, width - 36);
    const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        style: `spacing: ${layout.spacing}px;`});
    const root = column();
    const active = [];
    const network = groupRows(layout).flatMap(row => row.cells).find(cell => cell.module === 'network');
    if (network && (!layout.hideUnavailable || bar._groupItemAvailable('network'))) {
        const start = bar._popupCleanups.length;
        const heading = bar._networkPopoutLine(network.options);
        if (heading) root.add_child(heading);
        active.push(...bar._popupCleanups.splice(start));
    }
    let refit = 0;
    let disposed = false;
    const fit = () => {
        if (disposed) return;
        if (!refit) refit = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            refit = 0;
            if (root.get_stage()) { bar._popupLockedHeight = false; bar._fitPopup(); }
            return GLib.SOURCE_REMOVE;
        });
    };
    const available = cell => !layout.hideUnavailable || bar._groupItemAvailable(cell.module);
    const buildRow = (row, target, cleanups) => {
        const cells = row.cells.filter(available);
        if (!cells.length) return;
        const band = new St.BoxLayout({style: `spacing: ${layout.spacing}px;`, x_expand: true});
        const span = cells.reduce((sum, cell) => sum + cell.span, 0);
        const room = inner - layout.spacing * (cells.length - 1);
        for (const cell of cells) {
            const start = bar._popupCleanups.length;
            const content = bar._groupItem({...cell, groupHeader: true});
            cleanups.push(...bar._popupCleanups.splice(start));
            if (!content) continue;
            const box = column();
            box.width = Math.max(32, Math.floor(room * cell.span / span));
            box.x_expand = false;
            box._groupCellId = cell.id;
            if (cell.title === true && cell.view !== 'action') box.add_child(new St.Label({text: GROUP_ITEMS[cell.module].title,
                style: `color: ${bar._theme.muted}; font-size: 12px;`}));
            box.add_child(content); band.add_child(box);
        }
        target.add_child(band);
    };
    for (const block of layout.blocks) {
        if (block.type === 'row') { buildRow(block, root, active); continue; }
        const tabs = block.tabs.filter(tab => tab.rows.some(row => row.cells.some(available)));
        if (!tabs.length) continue;
        const section = column();
        const strip = new St.BoxLayout({style: 'spacing: 6px;', x_expand: true});
        const scroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER, width: inner});
        scroll.set_child(strip); section.add_child(scroll);
        const body = column(); section.add_child(body); root.add_child(section);
        const buttons = [];
        let cleanups = [];
        const clear = () => { cleanups.splice(0).forEach(fn => fn()); body.destroy_all_children(); };
        active.push(clear);
        const select = index => {
            clear();
            buttons.forEach((button, i) => button.style = groupTabStyle(bar._theme, i === index));
            tabs[index].rows.forEach(row => buildRow(row, body, cleanups));
            bar._groupTabs ??= new Map();
            bar._groupTabs.set(`${group.id}:${block.id}`, tabs[index].id);
            fit();
        };
        tabs.forEach((tab, index) => {
            const button = new St.Button({label: tab.title, can_focus: true, x_expand: true,
                width: Math.floor((inner - 6 * (tabs.length - 1)) / tabs.length)});
            button.connect('clicked', () => select(index)); strip.add_child(button); buttons.push(button);
        });
        const matches = initialModule === 'volume' ? ['volume', 'output'] : ['clock', 'date'].includes(initialModule) ? [initialModule, 'calendar'] : [initialModule];
        const wanted = tabs.findIndex(tab => initialModule && tab.rows.some(row => row.cells.some(cell => matches.includes(cell.instance || cell.module))));
        const saved = tabs.findIndex(tab => tab.id === bar._groupTabs?.get(`${group.id}:${block.id}`));
        select(wanted >= 0 ? wanted : saved >= 0 ? saved : 0);
    }
    if (!root.get_n_children()) root.add_child(new St.Label({text: 'No visible items in this group', style: `color: ${bar._theme.muted};`}));
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (refit) GLib.source_remove(refit);
        refit = 0;
        active.splice(0).forEach(fn => fn());
    };
    root.connect('destroy', dispose);
    bar._popupCleanups.push(dispose);
    root.connect('notify::allocation', fit);
    return root;
}
