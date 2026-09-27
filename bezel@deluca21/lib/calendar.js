import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function openCalendarDate(date) {
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
    const executable = GLib.find_program_in_path('gnome-calendar');
    const command = executable ? 'gnome-calendar'
        : app?.app_info?.get_string('X-Flatpak') && GLib.find_program_in_path('flatpak')
            ? 'flatpak run org.gnome.Calendar' : null;
    if (!command) {
        Main.notify('Bezel Calendar', 'Install GNOME Calendar to open a selected date.');
        return false;
    }
    try {
        const launcher = Gio.AppInfo.create_from_commandline(`${command} --date=${date.format('%Y-%m-%d')}`, 'Calendar', Gio.AppInfoCreateFlags.NONE);
        launcher.launch([], global.create_app_launch_context(global.get_current_time(), -1));
        return true;
    } catch (error) {
        Main.notify('Unable to open Calendar', error.message);
        return false;
    }
}

export function monthGrid(theme, activate = openCalendarDate) {
    const today = GLib.DateTime.new_now_local();
    let month = GLib.DateTime.new_local(today.get_year(), today.get_month(), 1, 12, 0, 0);
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 8px;'});
    const header = new St.BoxLayout({style: 'spacing: 8px;'});
    const title = new St.Button({can_focus: true, x_expand: true, style_class: 'bezel-action', accessible_name: 'Go to current month'});
    const previous = new St.Button({can_focus: true, label: '‹', accessible_name: 'Previous month', style_class: 'bezel-action'});
    const next = new St.Button({can_focus: true, label: '›', accessible_name: 'Next month', style_class: 'bezel-action'});
    header.add_child(previous);
    header.add_child(title);
    header.add_child(next);
    box.add_child(header);
    const grid = new St.Widget({layout_manager: new Clutter.GridLayout()});
    box.add_child(grid);
    let cellW = 32;
    let cellH = 30;
    let font = 12;
    const render = () => {
        title.label = month.format('%B %Y');
        title.style = `font-size: ${font}px;`;
        grid.destroy_all_children();
        const layout = grid.layout_manager;
        ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].forEach((day, column) => {
            const heading = new St.Label({text: day, width: cellW, x_align: Clutter.ActorAlign.CENTER, style: `color: ${theme.muted}; font-size: ${font}px;`});
            layout.attach(heading, column, 0, 1, 1);
        });
        const start = month.get_day_of_week() - 1;
        const days = month.add_months(1).add_days(-1).get_day_of_month();
        for (let day = 1; day <= days; day++) {
            const date = month.add_days(day - 1);
            const current = date.format('%F') === today.format('%F');
            const button = new St.Button({width: cellW, height: cellH, can_focus: true, label: String(day),
                accessible_name: date.format('%A, %e %B %Y'), style_class: 'bezel-calendar-day',
                style: `color: ${current ? theme.bg : theme.fg}; font-size: ${font}px; ${current ? `background-color: ${theme.accent};` : ''} border-radius: 8px;`});
            button._bezelDate = date.format('%F');
            button.connect('clicked', () => activate(date));
            const index = start + day - 1;
            layout.attach(button, index % 7, Math.floor(index / 7) + 1, 1, 1);
        }
    };
    previous.connect('clicked', () => { month = month.add_months(-1); render(); previous.grab_key_focus(); });
    next.connect('clicked', () => { month = month.add_months(1); render(); next.grab_key_focus(); });
    title.connect('clicked', () => { month = GLib.DateTime.new_local(today.get_year(), today.get_month(), 1, 12, 0, 0); render(); });
    box._dashLayout = ({width, height}) => {
        if (!height) {
            cellW = 32;
            cellH = 30;
            font = 12;
        } else {
            cellH = Math.max(18, Math.min(64, Math.round((height - 36) / 7)));
            cellW = Math.max(18, Math.min(64, Math.round(Math.min(cellH * 1.08, Math.max(18, (width - 8) / 7)))));
            font = Math.max(10, Math.min(18, Math.round(cellH * 0.42)));
        }
        render();
    };
    render();
    return box;
}
