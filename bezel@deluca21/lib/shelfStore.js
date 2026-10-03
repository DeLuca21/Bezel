import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const shelfStoragePath = () => `${GLib.get_user_cache_dir()}/bezel/shelf.json`;
const fileViewsPath = () => `${GLib.get_user_cache_dir()}/bezel/file-views.json`;

export function loadFileView(key) {
    try {
        const data = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(fileViewsPath())[1]));
        return data?.[key] === 'list' ? 'list' : 'grid';
    } catch { return 'grid'; }
}

export function saveFileView(key, mode) {
    let data = {};
    try { data = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(fileViewsPath())[1])); } catch {}
    if (!data || typeof data !== 'object') data = {};
    data[key] = mode === 'list' ? 'list' : 'grid';
    const directory = Gio.File.new_for_path(fileViewsPath()).get_parent().get_path();
    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(fileViewsPath(), JSON.stringify(data));
}

export function parseFileUris(text) {
    return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(uri => uri.startsWith('file:'));
}

export function loadShelfFiles(path = shelfStoragePath(), remember = true) {
    if (remember === false) return [];
    try {
        return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]))
            .filter(uri => typeof uri === 'string' && uri.startsWith('file:')).slice(0, 200);
    } catch { return []; }
}

export function saveShelfFiles(files, path = shelfStoragePath()) {
    const directory = Gio.File.new_for_path(path).get_parent().get_path();
    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(path, JSON.stringify([...files].slice(0, 200)));
}

export function mergeShelfFiles(current, incoming) {
    return [...new Set([...current, ...incoming.filter(uri => typeof uri === 'string' && uri.startsWith('file:'))])].slice(0, 200);
}
