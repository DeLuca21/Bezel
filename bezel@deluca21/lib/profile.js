import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

export function profileAvatar(theme, size = 88) {
    const user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
    const wrap = new St.Widget({
        width: size, height: size, clip_to_allocation: true,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        layout_manager: new Clutter.BinLayout(),
        style: circleStyle(theme, size),
    });
    const avatar = new St.Icon({
        icon_size: size, width: size, height: size,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        style: `color: ${theme.accent};`,
    });
    wrap.add_child(avatar);
    const update = () => {
        const path = [user.get_icon_file(), `${GLib.get_home_dir()}/.face`]
            .find(candidate => candidate && GLib.file_test(candidate, GLib.FileTest.IS_REGULAR));
        if (path) {
            wrap.style = `${circleStyle(theme, size)} background-image: url("${Gio.File.new_for_path(path).get_uri()}"); background-size: cover;`;
            avatar.hide();
        } else {
            wrap.style = circleStyle(theme, size);
            avatar.gicon = new Gio.ThemedIcon({name: 'avatar-default-symbolic'});
            avatar.show();
        }
    };
    user.connectObject('changed', update, 'notify::is-loaded', update, wrap);
    update();
    return wrap;
}

function circleStyle(theme, size) {
    return `border-radius: ${Math.round(size / 2)}px; background-color: ${theme.surface};`;
}
