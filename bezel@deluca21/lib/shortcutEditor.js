import {ChipDropPreview} from './chipDropPreview.js';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
const column = () => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, hexpand: true});
const button = (label, run) => { const b = new Gtk.Button({label}); b.connect('clicked', run); return b; };
const text = label => new Gtk.Label({label, xalign: 0, wrap: true});
const clear = box => { while (box.get_first_child()) box.remove(box.get_first_child()); };
export function shortcutEditor(owner, current, write) {
    const root = column();
    const list = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: 2, max_children_per_line: 4, row_spacing: 8, column_spacing: 8});
    root.add_css_class('lane');
    root.append(text('Drag shortcuts to reorder. Click a shortcut for its options.'));
    root.append(list);
    const items = (current.shortcuts || []).map(item => ({...item}));
    let selected = -1, options = null;
    const detail = column();
    const closeOptions = () => { if (options) { const parent = detail.get_parent(); if (parent) parent.remove(detail); options.popdown(); if (options.get_parent()) options.unparent(); options = null; } };
    const openOptions = anchor => {
        closeOptions();
        options = new Gtk.Popover({autohide: false});
        options.set_parent(anchor);
        const content = column(); content.width_request = 300;
        content.margin_top = 12; content.margin_bottom = 12; content.margin_start = 12; content.margin_end = 12;
        content.append(button('× Close', closeOptions));
        content.append(detail);
        options.set_child(new Gtk.ScrolledWindow({child: content, max_content_height: 420, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));
        options.connect('closed', () => { if (detail.get_parent() === content) content.remove(detail); });
        renderDetail(); options.popup();
    };
    const add = button('+ Add shortcut', () => {
        if (items.length >= 24) return;
        items.push({name: 'Shortcut', type: 'app', target: ''}); selected = items.length - 1;
        render(); openOptions(list.get_child_at_index(selected).get_child());
    });
    root.append(add);
    const dragToken = 'bezel-shortcut';
    let dragged = null;
    const preview = new ChipDropPreview(list, row => row._shortcutId);
    const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
    const mark = (_target, x, y) => {
        if (!dragged) return 0;
        preview.motion(x, y, String(items.indexOf(dragged)));
        return Gdk.DragAction.MOVE;
    };
    drop.connect('enter', mark); drop.connect('motion', mark);
    drop.connect('leave', () => preview.reset());
    drop.connect('drop', (_target, value, x, y) => {
        const token = typeof value === 'string' ? value : value?.get_string?.();
        if (token !== dragToken || !dragged) return false;
        const from = items.indexOf(dragged), selection = items[selected];
        const before = preview.active ? preview.before : preview.motion(x, y, String(from));
        const destination = before ? items[Number(before)] : null;
        preview.reset();
        items.splice(from, 1);
        const to = destination ? items.indexOf(destination) : items.length;
        items.splice(to < 0 ? items.length : to, 0, dragged);
        selected = items.indexOf(selection); dragged = null; save();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { render(); return GLib.SOURCE_REMOVE; });
        return true;
    });
    list.add_controller(drop);
    const save = () => write({shortcuts: items.map(item => ({...item}))});
    const render = () => {
        preview.reset(); closeOptions(); clear(list);
        items.forEach((item, index) => {
            const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 4});
            row._shortcutId = String(index);
            const handle = row;
            const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE, propagation_phase: Gtk.PropagationPhase.CAPTURE});
            drag.connect('prepare', () => {
                dragged = item;
                const value = new GObject.Value(); value.init(GObject.TYPE_STRING); value.set_string(dragToken);
                return Gdk.ContentProvider.new_for_value(value);
            });
            drag.connect('drag-begin', () => { drag.set_icon(new Gtk.WidgetPaintable({widget: row}).get_current_image(), 0, 0); row._dragging = true; closeOptions(); });
            drag.connect('drag-end', () => { dragged = null; preview.reset(); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { row._dragging = false; return GLib.SOURCE_REMOVE; }); });
            handle.add_controller(drag);
            const edit = button(item.name || 'Shortcut', () => { if (row._dragging) return; selected = index; openOptions(edit); });
            edit.add_css_class('module-chip');
            edit.tooltip_text = 'Drag to reorder, or click for options';
            edit.hexpand = true;
            edit.get_child().ellipsize = Pango.EllipsizeMode.END;
            if (index === selected) edit.add_css_class('is-on');
            row.append(edit);
            list.insert(row, -1);
        });
        add.sensitive = items.length < 24;
    };
    const renderDetail = () => {
        clear(detail);
        const item = items[selected];
        if (!item) return;

        const name = new Gtk.Entry({text: item.name, placeholder_text: 'Shortcut name'});
        name.connect('changed', () => { item.name = name.text; }); detail.append(name);
        const types = [['app', 'Application'], ['folder', 'Open folder'], ['file', 'Open file'], ['live-folder', 'Browse folder'], ['command', 'Bash command'], ['action', 'Built-in action']];
        const type = new Gtk.DropDown({model: Gtk.StringList.new(types.map(([, title]) => title)), selected: Math.max(0, types.findIndex(([id]) => id === item.type))});
        type.connect('notify::selected', () => { item.type = types[type.selected][0]; item.target = ''; renderDetail(); }); detail.append(type);
        const target = new Gtk.Entry({text: item.target, placeholder_text: item.type === 'command' ? 'Command to run' : 'Path or application'});
        target.connect('changed', () => { item.target = target.text; });
        if (item.type === 'app') {
            detail.append(text(item.target || 'No application selected'));
            detail.append(button('Choose application…', () => {
                clear(detail);
                detail.append(button('← Back to shortcut', renderDetail));
                const content = column(); const search = new Gtk.SearchEntry({placeholder_text: 'Search applications'}); content.append(search);
                const choices = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
                for (const app of Gio.AppInfo.get_all().filter(app => app.should_show() && app.get_id()).sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))) {
                    const row = new Gtk.ListBoxRow({activatable: true}); row.set_child(text(app.get_display_name()));
                    row._search = `${app.get_display_name()} ${app.get_id()}`.toLowerCase(); row._app = app;
                    choices.append(row);
                }
                choices.set_filter_func(row => row._search.includes(search.text.trim().toLowerCase()));
                search.connect('search-changed', () => choices.invalidate_filter());
                choices.connect('row-activated', (_list, row) => { item.target = row._app.get_id(); if (!item.name || item.name === 'Shortcut') item.name = row._app.get_display_name(); renderDetail(); });
                content.append(new Gtk.ScrolledWindow({child: choices, min_content_height: 180, max_content_height: 300, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER})); detail.append(content);
            }));
        } else if (item.type === 'action') {
            const actions = [['screenshot', 'Screenshot'], ['settings', 'Settings'], ['notifications', 'Notifications'], ['power', 'Power menu']];
            const choice = new Gtk.DropDown({model: Gtk.StringList.new(actions.map(([, title]) => title)), selected: Math.max(0, actions.findIndex(([id]) => id === item.target))});
            item.target = actions[choice.selected][0]; choice.connect('notify::selected', () => { item.target = actions[choice.selected][0]; }); detail.append(choice);
        } else {
            detail.append(target);
            if (item.type === 'command') {
                detail.append(text('Runs when clicked, using your account. Output is shown in the popout when enabled.'));
                detail.append(text('Commands stop after 30 seconds. Output is limited to 64 KB.'));
                const output = new Gtk.CheckButton({label: 'Show command output', active: item.showOutput !== false});
                output.connect('toggled', () => { item.showOutput = output.active; }); detail.append(output);
            } else detail.append(button(item.type === 'file' ? 'Choose file…' : 'Choose folder…', () => {
                const dialog = new Gtk.FileChooserNative({title: item.type === 'file' ? 'Choose file' : 'Choose folder', transient_for: owner.itemPopover instanceof Gtk.Window ? owner.itemPopover : owner.window,
                    action: item.type === 'file' ? Gtk.FileChooserAction.OPEN : Gtk.FileChooserAction.SELECT_FOLDER, accept_label: 'Select', cancel_label: 'Cancel'});
                dialog.connect('response', (_dialog, response) => { if (response === Gtk.ResponseType.ACCEPT) target.text = dialog.get_file()?.get_path() || ''; dialog.destroy(); }); dialog.show();
            }));
        }
        detail.append(button('Save shortcut', () => { save(); render(); }));
        detail.append(button('Remove shortcut', () => { items.splice(selected, 1); selected = Math.min(selected, items.length - 1); render(); save(); }));
    };
    render(); return root;
}
