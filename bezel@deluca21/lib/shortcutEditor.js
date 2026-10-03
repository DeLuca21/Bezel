import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
const column = () => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, hexpand: true});
const button = (label, run) => { const b = new Gtk.Button({label}); b.connect('clicked', run); return b; };
const text = label => new Gtk.Label({label, xalign: 0, wrap: true});
const clear = box => { while (box.get_first_child()) box.remove(box.get_first_child()); };
export function shortcutEditor(owner, current, write) {
    const root = column(); const list = column(); const detail = column();
    const items = (current.shortcuts || []).map(item => ({...item}));
    let selected = -1;
    const intro = text('Select a shortcut to edit it. Each shortcut can also have its own module on the bar.'); root.append(intro);
    const listScroll = new Gtk.ScrolledWindow({child: list, min_content_height: 100, max_content_height: 180, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER}); root.append(listScroll);
    const add = button('Add shortcut', () => { if (items.length >= 24) return; items.push({name: 'Shortcut', type: 'app', target: ''}); selected = items.length - 1; render(); }); root.append(add);
    root.append(detail);
    const save = () => write({shortcuts: items.map(item => ({...item}))});
    const render = () => {
        clear(list); clear(detail);
        items.forEach((item, index) => { const row = button(item.name || 'Shortcut', () => { selected = index; render(); }); if (index === selected) row.add_css_class('is-on'); list.append(row); });
        const item = items[selected];
        listScroll.visible = !item; intro.visible = !item; add.visible = !item;
        if (!item) return;
        detail.append(button('← All shortcuts', () => { selected = -1; render(); }));
        const name = new Gtk.Entry({text: item.name, placeholder_text: 'Shortcut name'});
        name.connect('changed', () => { item.name = name.text; }); detail.append(name);
        const types = [['app', 'Application'], ['folder', 'Open folder'], ['file', 'Open file'], ['live-folder', 'Browse folder'], ['command', 'Bash command'], ['action', 'Built-in action']];
        const type = new Gtk.DropDown({model: Gtk.StringList.new(types.map(([, title]) => title)), selected: Math.max(0, types.findIndex(([id]) => id === item.type))});
        type.connect('notify::selected', () => { item.type = types[type.selected][0]; item.target = ''; render(); }); detail.append(type);
        const target = new Gtk.Entry({text: item.target, placeholder_text: item.type === 'command' ? 'Command to run' : 'Path or application'});
        target.connect('changed', () => { item.target = target.text; });
        if (item.type === 'app') {
            detail.append(text(item.target || 'No application selected'));
            detail.append(button('Choose application…', () => {
                const dialog = new Gtk.Window({title: 'Choose application', transient_for: owner.itemPopover instanceof Gtk.Window ? owner.itemPopover : owner.window, modal: false, destroy_with_parent: true, default_width: 420, default_height: 500});
                dialog.add_css_class('bezel-settings'); dialog.set_titlebar(new Gtk.HeaderBar());
                const content = column(); const search = new Gtk.SearchEntry({placeholder_text: 'Search applications'}); content.append(search);
                const choices = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
                for (const app of Gio.AppInfo.get_all().filter(app => app.should_show() && app.get_id()).sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))) {
                    const row = new Gtk.ListBoxRow({activatable: true}); row.set_child(text(app.get_display_name()));
                    row._search = `${app.get_display_name()} ${app.get_id()}`.toLowerCase(); row._app = app;
                    choices.append(row);
                }
                choices.set_filter_func(row => row._search.includes(search.text.trim().toLowerCase()));
                search.connect('search-changed', () => choices.invalidate_filter());
                choices.connect('row-activated', (_list, row) => { item.target = row._app.get_id(); if (!item.name || item.name === 'Shortcut') item.name = row._app.get_display_name(); dialog.close(); render(); });
                content.append(new Gtk.ScrolledWindow({child: choices, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER})); dialog.set_child(content); dialog.present();
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
        detail.append(button('Save shortcut', () => { render(); save(); }));
        detail.append(button('Remove shortcut', () => { items.splice(selected, 1); selected = Math.min(selected, items.length - 1); render(); save(); }));
    };
    render(); return root;
}
