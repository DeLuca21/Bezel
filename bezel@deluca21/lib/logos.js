import Gio from 'gi://Gio';

export const LOGOS = [
    ['archlinux', 'Arch Linux'], ['debian', 'Debian'], ['ubuntu', 'Ubuntu'],
    ['fedora', 'Fedora'], ['linuxmint', 'Linux Mint'], ['nixos', 'NixOS'],
    ['opensuse', 'openSUSE'], ['popos', 'Pop!_OS'], ['gentoo', 'Gentoo'],
    ['manjaro', 'Manjaro'], ['endeavouros', 'EndeavourOS'], ['linux', 'Linux (Tux)'],
];
export function logoFile(value) {
    if (value.startsWith('distro:') && LOGOS.some(([id]) => value === `distro:${id}`))
        return Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
            .get_child('icons').get_child(`${value.slice(7)}-symbolic.svg`);
    if (value.startsWith('/')) return Gio.File.new_for_path(value);
    return null;
}
