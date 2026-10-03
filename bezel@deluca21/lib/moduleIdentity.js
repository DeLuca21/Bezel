// The first instance keeps its historical ID for saved-layout compatibility.
export const moduleType = id => typeof id === 'string' ? id.replace(/@\d+$/, '') : '';
export function nextModuleId(modules, type) {
    const used = new Set(modules.map(item => item.id));
    if (!used.has(type)) return type;
    let n = 2; while (used.has(`${type}@${n}`)) n++;
    return `${type}@${n}`;
}
// A view shares the bar's actors/lifecycle but resolves settings for one instance.
export function moduleView(bar, instance) {
    if (!instance || instance === bar._moduleInstance) return bar;
    const owner = bar._moduleOwner || bar;
    return new Proxy(owner, {
        get(target, key, receiver) {
            if (key === '_moduleInstance') return instance;
            if (key === '_moduleOwner') return owner;
            if (key === '_place') return owner._place.bind(owner);
            if (key === '_state') {
                const state = target._state;
                const selected = state.modules.find(item => item.id === instance);
                if (!selected) return state;
                const type = moduleType(instance);
                return {...state, modules: [{...selected, id: type}, ...state.modules.filter(item => moduleType(item.id) !== type)]};
            }
            return Reflect.get(target, key, receiver);
        },
        set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
}
