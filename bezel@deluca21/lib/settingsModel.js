import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {DATE_FORMATS, barGroups, EDGES, clamp, isSpacer, nextSpacerId, readBars, saveBars} from './config.js';

export const MODULES = [
    ['notifications', 'Notifications'],
    ['logo', 'Logo'],
    ['workspaces', 'Workspaces'],
    ['window', 'Focused app'],
    ['apps', 'Apps'],
    ['clock', 'Clock'],
    ['date', 'Date'],
    ['weather', 'Weather'],
    ['dashboard', 'Dashboard'],
    ['volume', 'Volume'],
    ['network', 'Wi-Fi'],
    ['output', 'Sound output'],
    ['bluetooth', 'Bluetooth'],
    ['brightness', 'Brightness'],
    ['battery', 'Battery'],
    ['power', 'Power'],
    ['screenshot', 'Screenshot'],
    ['dnd', 'Do Not Disturb'],
    ['nightlight', 'Night Light'],
    ['dark', 'Dark style'],
    ['performance', 'Performance'],
    ['vpn', 'VPN'],
    ['settings', 'Settings'],
    ['media', 'Now playing'],
    ['microphone', 'Microphone'],
    ['clipboard', 'Clipboard'],
    ['keyboard', 'Keyboard'],
    ['awake', 'Keep awake'],
    ['indicators', 'Extensions'],
];

export const DRAWER_SPOTS = [
    ['top-left', 'top-center', 'top-right'],
    ['left', 'icon', 'right'],
    ['bottom-left', 'bottom-center', 'bottom-right'],
];

export function patchBar(settings, index, values) {
    const bars = readBars(settings);
    if (!bars[index])
        return;
    bars[index] = {...bars[index], ...values};
    saveBars(settings, bars);
}

export function setKind(settings, index, kind) {
    patchBar(settings, index, {kind: kind === 'dock' ? 'dock' : 'panel'});
}

export function setFloating(settings, index, floating) {
    const bar = readBars(settings)[index];
    if (!bar)
        return;
    patchBar(settings, index, {margin: floating ? (bar.margin > 0 ? bar.margin : 12) : 0});
}

export function setBarNumber(settings, index, key, value, min, max) {
    patchBar(settings, index, {[key]: clamp(Math.round(Number(value)), min, max)});
}

export function setShowLogo(settings, index, shown) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar)
        return;
    const modules = bar.modules.filter(item => item.id !== 'logo');
    if (shown) {
        const at = modules.findIndex(item => !isSpacer(item.id));
        modules.splice(at < 0 ? modules.length : at, 0, {id: 'logo', place: 'start', group: ''});
    }
    bar.modules = modules;
    saveBars(settings, bars);
}

export function addModule(settings, index, id, place) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar)
        return false;
    const spot = ['start', 'center', 'end'].includes(place) ? place : 'center';
    if (id === 'spacer') {
        const spacer = nextSpacerId(bar.modules);
        if (!spacer)
            return false;
        bar.modules.push({id: spacer, place: spot, group: '', size: 24});
    } else if (!MODULES.some(([key]) => key === id)) {
        return false;
    } else {
        const previous = bar.modules.find(item => item.id === id);
        bar.modules = bar.modules.filter(item => item.id !== id);
        bar.modules.push({...(previous ?? {}), id, place: spot, group: previous?.group ?? ''});
    }
    saveBars(settings, bars);
    return true;
}

export function removeModule(settings, index, id) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar)
        return;
    bar.modules = bar.modules.filter(item => item.id !== id);
    saveBars(settings, bars);
}

export function createGroup(settings, index, name = 'New group', members = [], place = '') {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar || !String(name).trim()) return null;
    const groups = barGroups(bar);
    let n = 1;
    while (groups.some(group => group.id === `group-${n}`) || bar.modules.some(item => item.id === `group-${n}`)) n++;
    const id = `group-${n}`;
    const spot = ['start', 'center', 'end'].includes(place) ? place
        : bar.modules.find(item => members.includes(item.id))?.place ?? 'center';
    bar.groups = [...groups, {id, name: name === 'New group' ? `Group ${n}` : String(name).trim().slice(0, 60), place: spot}];
    bar.modules = bar.modules.map(item => members.includes(item.id) ? {...item, group: id, place: spot} : item);
    saveBars(settings, bars);
    return id;
}

export function deleteGroup(settings, index, id) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar) return;
    bar.groups = barGroups(bar).filter(group => group.id !== id);
    bar.modules = bar.modules.map(item => item.group === id ? {...item, group: ''} : item);
    saveBars(settings, bars);
}

export function reorderModule(settings, index, id, delta) {
    const bars = readBars(settings);
    const bar = bars[index];
    const modules = bar?.modules;
    const item = modules?.find(module => module.id === id);
    if (!item)
        return false;
    if (item.group) {
        const place = modules.find(module => module.group === item.group)?.place || item.place;
        for (const module of modules)
            if (module.group === item.group)
                module.place = place;
        bar.groups = barGroups(bar).map(group => group.id === item.group ? {...group, place} : group);
    }
    const same = module => item.group
        ? module.group === item.group
        : !module.group && module.place === item.place;
    const slots = [];
    modules.forEach((module, slot) => {
        if (same(module))
            slots.push(slot);
    });
    const pos = slots.findIndex(slot => modules[slot].id === id);
    const swap = pos + delta;
    if (pos < 0 || swap < 0 || swap >= slots.length)
        return false;
    const from = slots[pos];
    const to = slots[swap];
    [modules[from], modules[to]] = [modules[to], modules[from]];
    saveBars(settings, bars);
    return true;
}

export function nudgeUnit(settings, index, id, delta) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar)
        return false;
    const isGroup = bar.modules.some(module => module.group === id);
    if (!isGroup)
        return reorderModule(settings, index, id, delta);
    const place = bar.modules.find(module => module.group === id)?.place
        || barGroups(bar).find(group => group.id === id)?.place
        || 'center';
    for (const module of bar.modules)
        if (module.group === id)
            module.place = place;
    bar.groups = barGroups(bar).map(group => group.id === id ? {...group, place} : group);
    const units = [];
    const seen = new Set();
    for (const module of bar.modules) {
        if (module.place !== place)
            continue;
        const unit = module.group || module.id;
        if (seen.has(unit))
            continue;
        seen.add(unit);
        units.push(unit);
    }
    const at = units.indexOf(id);
    const next = at + delta;
    if (at < 0 || next < 0 || next >= units.length)
        return false;
    [units[at], units[next]] = [units[next], units[at]];
    const grouped = new Map();
    for (const module of bar.modules) {
        if (module.place !== place)
            continue;
        const unit = module.group || module.id;
        if (!grouped.has(unit))
            grouped.set(unit, []);
        grouped.get(unit).push(module);
    }
    const rebuilt = [];
    let inserted = false;
    for (const module of bar.modules) {
        if (module.place !== place) {
            rebuilt.push(module);
            continue;
        }
        if (inserted)
            continue;
        inserted = true;
        for (const unit of units)
            rebuilt.push(...(grouped.get(unit) ?? []));
    }
    bar.modules = rebuilt;
    saveBars(settings, bars);
    return true;
}

export function moveModule(settings, index, id, {place = 'center', group = '', beforeId = ''} = {}) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar)
        return false;
    const from = bar.modules.findIndex(module => module.id === id);
    if (from < 0)
        return false;
    const [item] = bar.modules.splice(from, 1);
    let spot = ['start', 'center', 'end'].includes(place) ? place : (item.place || 'center');
    let nextGroup = '';
    if (group) {
        const groups = barGroups(bar);
        if (!groups.some(entry => entry.id === group)) {
            bar.modules.splice(from, 0, item);
            return false;
        }
        spot = bar.modules.find(module => module.group === group)?.place
            || groups.find(entry => entry.id === group)?.place
            || spot;
        nextGroup = group;
        bar.groups = groups.map(entry => entry.id === group ? {...entry, place: spot} : entry);
    }
    const next = {...item, place: spot, group: nextGroup};
    let insertAt = bar.modules.length;
    if (typeof beforeId === 'string' && beforeId.startsWith('group:')) {
        const at = bar.modules.findIndex(module => module.group === beforeId.slice(6));
        if (at >= 0)
            insertAt = at;
    } else if (beforeId) {
        const at = bar.modules.findIndex(module => module.id === beforeId);
        if (at >= 0)
            insertAt = at;
    } else if (nextGroup) {
        let last = -1;
        bar.modules.forEach((module, slot) => {
            if (module.group === nextGroup)
                last = slot;
        });
        if (last >= 0)
            insertAt = last + 1;
    }
    bar.modules.splice(insertAt, 0, next);
    saveBars(settings, bars);
    return true;
}

export function assignGroup(settings, index, moduleId, groupId) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar || (groupId && !barGroups(bar).some(group => group.id === groupId))) return;
    // Preserve the old group even when its last member leaves.
    bar.groups = barGroups(bar);
    const place = bar.modules.find(item => item.group === groupId)?.place
        ?? bar.groups.find(group => group.id === groupId)?.place;
    bar.modules = bar.modules.map(item => item.id === moduleId
        ? {...item, group: groupId, place: groupId && place ? place : item.place} : item);
    saveBars(settings, bars);
}

export function patchModule(settings, index, id, values) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar?.modules.some(item => item.id === id))
        return;
    bar.modules = bar.modules.map(item => item.id === id ? {...item, ...values} : item);
    saveBars(settings, bars);
}

export function patchGroup(settings, index, id, values) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar || !barGroups(bar).some(group => group.id === id))
        return;
    bar.groups = barGroups(bar).map(group => group.id === id ? {...group, ...values} : group);
    saveBars(settings, bars);
}

export function resizeSpacer(settings, index, id, size) {
    const bars = readBars(settings);
    const bar = bars[index];
    if (!bar || !isSpacer(id) || !Number.isFinite(Number(size))) return;
    bar.modules = bar.modules.map(item => item.id === id ? {...item, size: clamp(Math.round(Number(size)), 8, 400)} : item);
    saveBars(settings, bars);
}

export function addBar(settings, edge) {
    const bars = readBars(settings);
    if (bars.length >= 4)
        return false;
    const used = new Set(bars.map(bar => bar.edge));
    const nextEdge = edge && !used.has(edge) ? edge : EDGES.find(item => !used.has(item));
    if (!nextEdge)
        return false;
    bars.push({
        edge: nextEdge,
        thickness: 48,
        reserveSpace: false,
        reserveOffset: bars[0]?.reserveOffset ?? 0,
        iconSize: 22,
        modules: [{id: 'clock', place: 'center', group: 'clock'}],
        pinned: [],
    });
    saveBars(settings, bars);
    return true;
}

export function removeBar(settings, index) {
    const bars = readBars(settings);
    if (bars.length < 2 || !bars[index])
        return false;
    const target = settings.get_int('indicator-bar');
    if (target === index + 1)
        settings.set_int('indicator-bar', 0);
    else if (target > index + 1)
        settings.set_int('indicator-bar', target - 1);
    bars.splice(index, 1);
    saveBars(settings, bars);
    return true;
}

export function undoPreset(settings) {
    try {
        const previous = JSON.parse(settings.get_string('previous-layout'));
        if (typeof previous.config !== 'string' || typeof previous.frame !== 'boolean')
            return false;
        settings.set_string('config', previous.config);
        settings.set_boolean('show-frame', previous.frame);
        if (Number.isInteger(previous.indicatorBar))
            settings.set_int('indicator-bar', Math.max(0, Math.min(4, previous.indicatorBar)));
        settings.set_string('previous-layout', '');
        return true;
    } catch {
        return false;
    }
}

export function setCustomColor(settings, key, hex) {
    const text = String(hex ?? '').trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text))
        return false;
    const full = text.length === 4
        ? `#${[...text.slice(1)].map(channel => channel + channel).join('')}`
        : text.toLowerCase();
    settings.set_string(`custom-${key}`, full);
    return true;
}

export function useRecommendedShortcuts(settings) {
    settings.set_boolean('super-launcher', false);
    settings.set_strv('overview-shortcut', []);
    settings.set_strv('launcher-shortcut', ['<Super>space']);
}

export function shortcutLabel(accelerator) {
    if (!accelerator)
        return 'Set shortcut';
    const [valid, keyval, mods] = Gtk.accelerator_parse(accelerator);
    return valid ? Gtk.accelerator_get_label(keyval, mods) : accelerator;
}

export function acceleratorFromEvent(keyval, state) {
    const mods = state & Gtk.accelerator_get_default_mod_mask();
    const named = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK;
    if (!Gtk.accelerator_valid(keyval, mods) || !(mods & named))
        return null;
    return Gtk.accelerator_name(keyval, mods);
}

export function assignShortcut(settings, key, accelerator) {
    const other = key === 'launcher-shortcut' ? 'overview-shortcut' : 'launcher-shortcut';
    if (settings.get_strv(other).includes(accelerator))
        return 'That shortcut already opens the other Bezel action.';
    const conflict = shortcutConflict(accelerator);
    if (conflict)
        return `Already assigned to ${conflict}.`;
    settings.set_strv(key, [accelerator]);
    return null;
}

export function indicatorNames(settings) {
    return [...new Set([...settings.get_strv('indicator-order'), ...settings.get_strv('known-indicators')])];
}

export function moveIndicator(settings, name, delta) {
    const names = indicatorNames(settings);
    const index = names.indexOf(name);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= names.length)
        return;
    const order = [...names];
    const [item] = order.splice(index, 1);
    order.splice(next, 0, item);
    settings.set_strv('indicator-order', order);
}

export function setIndicatorShown(settings, name, shown) {
    const hidden = settings.get_strv('hidden-indicators').filter(role => role !== name);
    if (!shown)
        hidden.push(name);
    settings.set_strv('hidden-indicators', hidden);
}

function shortcutConflict(accelerator) {
    const [, keyval, mods] = Gtk.accelerator_parse(accelerator);
    for (const schema of ['org.gnome.desktop.wm.keybindings', 'org.gnome.shell.keybindings', 'org.gnome.mutter.keybindings', 'org.gnome.mutter.wayland.keybindings']) {
        if (!Gio.SettingsSchemaSource.get_default().lookup(schema, true))
            continue;
        const settings = new Gio.Settings({schema_id: schema});
        for (const key of settings.settings_schema.list_keys()) {
            if (['switch-input-source', 'switch-input-source-backward'].includes(key))
                continue;
            const value = settings.get_value(key);
            if (value.get_type_string() !== 'as')
                continue;
            if (value.deepUnpack().some(binding => {
                const [valid, candidate, modifiers] = Gtk.accelerator_parse(binding);
                return valid && candidate === keyval && modifiers === mods;
            }))
                return key.replaceAll('-', ' ');
        }
    }
    return null;
}

export {DATE_FORMATS};
