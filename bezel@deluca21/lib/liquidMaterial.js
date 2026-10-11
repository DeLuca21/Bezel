import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {openingPath, paintPillBackdrop} from './drawing.js';
import {LiquidPath, MAX_PATH_PARTS} from './liquidPath.js';

// Glass uses the actual openingPath, recorded as circular arcs and lines.
// Blur samples a padded local crop so adjacent frame tiles frost identically.
// No Cairo colour layer sits above glass, and empty mask pixels are transparent.
const declarations = `
uniform vec4 liquid_boxes[3];
uniform vec3 liquid_corners;
uniform float liquid_shapes;
uniform vec2 liquid_size;
uniform vec2 liquid_texture_origin;
uniform vec4 liquid_path[${MAX_PATH_PARTS}];
uniform vec2 liquid_path_type[${MAX_PATH_PARTS}];
uniform float liquid_path_count;
uniform vec4 liquid_rect;
uniform vec4 liquid_base;
uniform float liquid_drawer_only;
uniform vec4 liquid_join;
uniform vec4 liquid_drop;
uniform vec4 liquid_stem;
uniform vec4 liquid_stream;
uniform vec4 liquid_tint;
uniform vec2 liquid_offset;
uniform float liquid_radius;
uniform float liquid_frame;
uniform float liquid_simple_frame;
uniform float liquid_solid;
uniform float liquid_shadow;
uniform float liquid_highlight;
uniform float liquid_brightness;
uniform float liquid_contrast;
float boxDistance(vec2 p, vec4 b, float r) {
    r = min(r, min(b.z, b.w) * 0.5);
    vec2 q = abs(p - b.xy - b.zw * 0.5) - b.zw * 0.5 + r;
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
float arcPosition(float theta, float start, float sweep) {
    return mod(sign(sweep) * (theta - start) + 12.5663706144, 6.2831853072);
}
float openingDistance(vec2 p) {
    float distanceToPath = 1e6;
    float crossings = 0.0;
    float rayY = p.y + 0.000137;
    for (int i = 0; i < ${MAX_PATH_PARTS}; i++) {
        if (float(i) >= liquid_path_count) break;
        vec4 g = liquid_path[i];
        vec2 type = liquid_path_type[i];
        if (type.x < 0.5) {
            vec2 delta = g.zw - g.xy;
            float t = clamp(dot(p - g.xy, delta) / max(dot(delta, delta), 0.000001), 0.0, 1.0);
            distanceToPath = min(distanceToPath, length(p - g.xy - t * delta));
            if ((g.y > rayY) != (g.w > rayY)) {
                float crossX = g.x + (rayY - g.y) * delta.x / delta.y;
                if (crossX > p.x) crossings += 1.0;
            }
        } else {
            vec2 v = p - g.xy;
            float theta = atan(v.y, v.x);
            float along = arcPosition(theta, g.w, type.y);
            vec2 first = g.xy + g.z * vec2(cos(g.w), sin(g.w));
            vec2 last = g.xy + g.z * vec2(cos(g.w + type.y), sin(g.w + type.y));
            float arcDistance = along <= abs(type.y) ? abs(length(v) - g.z)
                : min(length(p - first), length(p - last));
            distanceToPath = min(distanceToPath, arcDistance);
            float dy = rayY - g.y;
            if (abs(dy) < g.z) {
                float a = asin(dy / g.z);
                float b = 3.1415926536 - a;
                if (arcPosition(a, g.w, type.y) < abs(type.y) && g.x + g.z * cos(a) > p.x) crossings += 1.0;
                if (arcPosition(b, g.w, type.y) < abs(type.y) && g.x + g.z * cos(b) > p.x) crossings += 1.0;
            }
        }
    }
    return mod(crossings, 2.0) > 0.5 ? distanceToPath : -distanceToPath;
}
float bridgeDistance(vec2 p, vec4 ends, float radius) {
    vec2 ab = ends.zw - ends.xy;
    float h = clamp(dot(p - ends.xy, ab) / max(dot(ab, ab), 0.001), 0.0, 1.0);
    return length(p - ends.xy - ab * h) - radius;
}
float blendDistance(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / max(k, 0.001);
    return min(a, b) - h * h * k * 0.25;
}
`;
const fragment = `
vec2 p = liquid_texture_origin + cogl_tex_coord_in[0].xy * liquid_size;
float d = boxDistance(p, liquid_rect, liquid_radius);
if (liquid_frame > 0.5) {
    d = liquid_simple_frame > 0.5 ? -boxDistance(p + liquid_offset, liquid_base, liquid_radius) : openingDistance(p + liquid_offset);
    if (liquid_drawer_only > 0.5)
        d = max(d, boxDistance(p + liquid_offset, liquid_base, liquid_radius));
} else {
    if (liquid_drop.z > 0.0) {
        vec2 v = (p - liquid_drop.xy) / liquid_drop.zw;
        float dropD = (length(v) - 1.0) * min(liquid_drop.z, liquid_drop.w);
        d = blendDistance(d, dropD, 12.0);
    }
    if (liquid_stem.z > 0.0) d = blendDistance(d, boxDistance(p, liquid_stem, liquid_stem.z * 0.5), 10.0);
    if (liquid_join.w > 0.0) d = blendDistance(d, bridgeDistance(p, liquid_stream, liquid_join.w), 12.0);
}
if (liquid_shapes > 0.5) {
    d = 1e6;
    for (int i = 0; i < 3; i++) {
        vec4 b = liquid_boxes[i];
        if (b.z > 0.25 && b.w > 0.25)
            d = blendDistance(d, boxDistance(p, vec4(b.xy - b.zw, b.zw * 2.0), liquid_corners[i]), 12.0);
    }
    if (liquid_join.w > 0.25) d = blendDistance(d, bridgeDistance(p, liquid_stream, liquid_join.w), 12.0);
}
float coverage = 1.0 - smoothstep(-0.6, 0.6, d);
vec4 material = cogl_color_out;
vec3 straight = material.rgb / max(material.a, 0.00001);
material.rgb = clamp(((straight - vec3(0.5)) * liquid_contrast + vec3(0.5)) * liquid_brightness, 0.0, 1.0) * material.a;
if (liquid_solid > 0.5) material = vec4(liquid_tint.rgb, 1.0);
else material = vec4(mix(material.rgb, liquid_tint.rgb * material.a, liquid_tint.a), material.a);
float rim = liquid_highlight * (1.0 - smoothstep(0.0, 1.4, abs(d))) * step(d, 0.0);
material.rgb = mix(material.rgb, vec3(material.a), rim * 0.18);
float shadowAlpha = liquid_shadow > 0.0 ? 0.25 * exp(-3.0 * pow(max(d, 0.0) / liquid_shadow, 2.0))
    * (1.0 - smoothstep(liquid_shadow, liquid_shadow * 2.0, d)) * (1.0 - coverage) : 0.0;
cogl_color_out = material * coverage + vec4(0.0, 0.0, 0.0, shadowAlpha);
`;
const MaterialMask = GObject.registerClass(class LiquidMaterialMask extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, fragment, false);
    }
    vfunc_paint_target(node, context) {
        const actor = this.get_actor();
        const [ok] = this.get_target_size();
        if (ok && actor) {

            // Atelier's syncTextureFrame: Clutter adds three device pixels
            // to the offscreen box, including padding before the actor.
            const scale = Math.ceil(actor.get_resource_scale());
            const frame = length => {
                const pixels = length * scale;
                const rounded = Math.round(pixels);
                return [(Math.ceil(pixels + 0.75) - rounded - 3) / scale, (rounded + 3) / scale];
            };
            const [x, w] = frame(actor.width), [y, h] = frame(actor.height);
            this.set('size', [w, h], false);
            this.set('texture_origin', [x, y], false);
        }
        super.vfunc_paint_target(node, context);
    }
    set(name, values, repaint = true) {
        this._values ??= new Map();
        const previous = this._values.get(name);
        if (previous?.length === values.length && previous.every((v, i) => v === values[i])) return;
        this._values.set(name, [...values]);
        const arity = name.startsWith('path_type[') ? 2 : name.startsWith('path[') || name.startsWith('boxes[') ? 4 : values.length;
        this.set_uniform_float(this.get_uniform_location(`liquid_${name}`), arity, values);
        if (repaint) this.queue_repaint();
    }
});

export function liquidEnabled(settings, key) {
    const setting = `liquid-${key}`;
    if (!settings?.settings_schema.has_key(setting)) return false;
    if (key.startsWith('glass-') && settings.settings_schema.has_key('liquid-glass-enabled')
        && !settings.get_boolean('liquid-glass-enabled')) return false;
    // Surface materials are independent of motion; only drawer transfers
    // require the Liquid animation style.
    if (key === 'shift' || key === 'pour')
        return liquidEnabled(settings, 'motion') && settings.get_boolean(setting);
    return settings.get_boolean(setting);
}

// Atelier shell/core/glass.js uses a one-to-one window-group clone. Its
// allocation override avoids scaling GNOME's zero-sized window group and
// lets Clutter handle stacking, visibility and damage once for the scene.
const WindowsClone = GObject.registerClass(class BezelLiquidWindowsClone extends Clutter.Clone {
    vfunc_allocate(box) { this.set_allocation(box); }
});
class WindowScene {
    constructor(container, resolution = 1, source = global.window_group) {
        this.resolution = resolution;
        this.ownsActor = source === global.window_group;
        this.actor = this.ownsActor ? new WindowsClone({source, reactive: false}) : source;
        this.actor.set_scale(resolution, resolution);
        this.actor.set_size(global.stage.width, global.stage.height);
        container.add_child(this.actor);
        this.actor.show();
    }
    position(x, y) {
        this.actor.set_position(-x * this.resolution, -y * this.resolution);
        this.actor.set_size(global.stage.width, global.stage.height);
        if (!this.ownsActor) this.actor.allocate(new Clutter.ActorBox({x1: -x * this.resolution, y1: -y * this.resolution,
            x2: -x * this.resolution + global.stage.width, y2: -y * this.resolution + global.stage.height}));
    }
    destroy() {
        if (this.ownsActor) this.actor.destroy();
        else this.actor.get_parent()?.remove_child(this.actor);
    }
}

// All live materials on a monitor clone this single blurred scene. Blur
// damage is cached at the source instead of replaying every window per tile.
const liveScenes = new Map();
function acquireLiveScene(monitor, radius, live = true, windowSource = null) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    if (windowSource) windowSource._bezelSceneId ??= GLib.uuid_string_random();
    const key = `${monitor.index}:${monitor.x}:${monitor.y}:${monitor.width}:${monitor.height}:${radius}:${scale}:${live}:${windowSource?._bezelSceneId ?? 'desktop'}`;
    let scene = liveScenes.get(key);
    if (!scene) {
        // Frost removes fine detail anyway. Render live desktop damage at half
        // resolution, then sample it at desktop scale with the same blur span.
        const resolution = live && radius >= 8 ? 0.5 : 1;
        const width = monitor.width * resolution, height = monitor.height * resolution;
        const actor = new Clutter.Actor({x: monitor.x, y: monitor.y, width, height,
            reactive: false, clip_to_allocation: true, layout_manager: new Clutter.FixedLayout()});
        const managers = [];
        const wallpapers = [];
        for (const output of monitor.virtual ? Main.layoutManager.monitors : [monitor]) {
            const wallpaper = new Clutter.Actor({x: (output.x - monitor.x) * resolution,
                y: (output.y - monitor.y) * resolution, width: output.width, height: output.height});
            wallpaper.set_scale(resolution, resolution);
            actor.add_child(wallpaper);
            const manager = new Background.BackgroundManager({container: wallpaper, monitorIndex: output.index,
                controlPosition: false, useContentSize: false});
            managers.push(manager);
            wallpapers.push({wallpaper, manager, output});
        }
        const windows = live ? new WindowScene(actor, resolution, windowSource ?? global.window_group) : null;
        windows?.position(monitor.x, monitor.y);
        const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: radius * scale * resolution, brightness: 1});
        actor.add_effect_with_name('liquid-shared-blur', blur);
        Main.uiGroup.add_child(actor);
        actor.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        // A hidden source is not allocated by its parent. Allocate it once
        // before its clones paint the cached offscreen blur.
        actor.allocate(new Clutter.ActorBox({x1: monitor.x, y1: monitor.y,
            x2: monitor.x + width, y2: monitor.y + height}));
        for (const {wallpaper, manager, output} of wallpapers) {
            const allocateWallpaper = () => {
                wallpaper.allocate(new Clutter.ActorBox({x1: (output.x - monitor.x) * resolution, y1: (output.y - monitor.y) * resolution,
                    x2: (output.x - monitor.x) * resolution + output.width, y2: (output.y - monitor.y) * resolution + output.height}));
                manager.backgroundActor.set_position(0, 0);
                manager.backgroundActor.set_size(output.width, output.height);
                manager.backgroundActor.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: output.width, y2: output.height}));
                actor.queue_redraw();
            };
            manager.connect('changed', allocateWallpaper);
            allocateWallpaper();
        }
        actor.hide();
        scene = {actor, managers, windows, blur, resolution, references: 0, key};
        liveScenes.set(key, scene);
    }
    scene.references++;
    return scene;
}
function releaseLiveScene(scene) {
    if (--scene.references > 0) return;
    liveScenes.delete(scene.key);
    scene.windows?.destroy();
    for (const manager of scene.managers) manager.destroy();
    scene.actor.destroy();
}

// A backing surface contributes no preferred size. Sampling padding must
// never enlarge an intrinsically sized group or feed back into its allocation.
export const MaterialActor = GObject.registerClass(class BezelLiquidMaterialActor extends Clutter.Actor {
    vfunc_get_paint_volume(volume) {
        volume.set_origin(new Graphene.Point3D({x: 0, y: 0, z: 0}));
        volume.set_width(this.width);
        volume.set_height(this.height);
        volume.set_depth(0);
        return true;
    }
    vfunc_get_preferred_width() { return [0, 0]; }
    vfunc_get_preferred_height() { return [0, 0]; }
});

export class LiquidMaterial {
    constructor(monitor, settings, color, glass = true, options = {}) {
        this.monitor = monitor;
        const live = options.live ?? liquidEnabled(settings, 'live-blur');
        const blurRadius = options.radius ?? settings.get_int('liquid-blur-radius');
        this.margin = glass ? Math.ceil(blurRadius * 2) : 0;
        this.actor = new MaterialActor({reactive: false, clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true,
            background_color: new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 1})});
        this.actor.queue_repaint = () => this.syncBackground();
        this.actor._bezelSyncPlate = this.actor.queue_repaint;
        this.mask = new MaterialMask();
        this.mask.set('shapes', [0]);
        this.mask.set('boxes[0]', Array(12).fill(0));
        this.mask.set('corners', [0, 0, 0]);
        this.mask.set('size', [1, 1]);
        this.mask.set('rect', [0, 0, 1, 1]);
        this.mask.set('drop', [0, 0, 0, 0]);
        this.mask.set('stem', [0, 0, 0, 0]);
        this.mask.set('path_count', [0]);
        this.mask.set('texture_origin', [0, 0]);
        this.mask.set('join', [0, 0, 0, 0]);
        this.mask.set('stream', [0, 0, 0, 0]);
        this.mask.set('simple_frame', [0]);
        this.mask.set('frame', [0]);
        this.mask.set('drawer_only', [0]);
        this.mask.set('radius', [0]);
        this.mask.set('solid', [glass ? 0 : 1]);
        this.mask.set('shadow', [0]);
        this.mask.set('highlight', [glass && (options.highlight ?? settings.get_boolean('liquid-edge-highlight')) ? 1 : 0]);
        this.tint = [...[1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255), (options.tint ?? settings.get_int('liquid-tint')) / 100];
        this.mask.set('tint', this.tint);
        this.mask.set('brightness', [(options.brightness ?? settings.get_int('liquid-brightness')) / 100]);
        this.mask.set('contrast', [(options.contrast ?? settings.get_int('liquid-contrast')) / 100]);
        if (glass) {
            const crop = new Clutter.Actor({width: 1, height: 1, reactive: false, clip_to_allocation: true,
                layout_manager: new Clutter.FixedLayout(),
                // Opaque sampling padding prevents unblurred wallpaper bleeding
                // through alpha at the physical monitor edge. Wallpaper covers
                // this neutral backing everywhere inside the monitor.
                background_color: new Cogl.Color({red: 127, green: 127, blue: 127, alpha: 255})});
            this.crop = crop;
            this.actor.add_child(crop);
            this.liveScene = acquireLiveScene(monitor, blurRadius, live, options.windowSource);
            this.liveClone = new WindowsClone({source: this.liveScene.actor, reactive: false});
            this.liveClone.set_scale(1 / this.liveScene.resolution, 1 / this.liveScene.resolution);
            crop.add_child(this.liveClone);
            this.windows = this.liveScene.windows;
            this.blur = this.liveScene.blur;
        }
        this.actor.add_effect_with_name('liquid-mask', this.mask);
        this.actor.connect('notify::allocation', () => this.syncBackground());
        this.actor.connect('notify::mapped', () => this.syncBackground());
        const stageSignal = global.stage.connect('before-paint', () => { if (this.actor.mapped) { this.syncShape?.(); this.syncBackground(); } });
        this.actor.connect('destroy', () => { global.stage.disconnect(stageSignal); this.liveClone?.destroy(); this.liveClone = null; if (this.liveScene) releaseLiveScene(this.liveScene); this.liveScene = null; this.windows = null; this.manager?.destroy(); this.manager = null; });
    }
    // Atelier's seeThrough.js: remove the tint first, then fade the frost.
    setSurfaceOpacity(opacity) {
        const value = Math.max(0, Math.min(1, opacity));
        this.actor.opacity = Math.round(255 * Math.min(1, value / 0.4));
        this.mask.set('tint', [...this.tint.slice(0, 3), this.tint[3] * Math.max(0, (value - 0.4) / 0.6)]);
    }
    shadow(depth, radius) {
        if (!(depth > 0)) return;
        const holder = new MaterialActor({reactive: false, layout_manager: new Clutter.FixedLayout(),
            x_expand: true, y_expand: true, clip_to_allocation: false});
        const paint = new St.DrawingArea({reactive: false});
        holder.add_child(paint);
        let attachIdle = 0;
        const sync = () => {
            const parent = this.actor.get_parent();
            if (!parent || !this.actor.get_stage()) return;
            if (!holder.get_parent()) {
                if (!attachIdle) attachIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    attachIdle = 0;
                    const host = this.actor.get_parent();
                    if (host) { host.insert_child_below(holder, this.actor); sync(); }
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            if (![this.actor.width, this.actor.height, this.actor.x, this.actor.y].every(Number.isFinite)) return;
            holder.opacity = this.actor.opacity;
            holder.visible = this.actor.visible;
            holder.allocate(new Clutter.ActorBox({x1: this.actor.x, y1: this.actor.y,
                x2: this.actor.x + this.actor.width, y2: this.actor.y + this.actor.height}));
            paint.set_position(-depth, -depth);
            paint.set_size(Math.max(1, this.actor.width + depth * 2), Math.max(1, this.actor.height + depth * 2));
            paint.queue_repaint();
        };
        paint.connect('repaint', () => {
            const cr = paint.get_context();
            try {
                const shape = this._shape ?? [0, 0, this.actor.width, this.actor.height];
                paintPillBackdrop(cr, {x: depth + shape[0], y: depth + shape[1], w: shape[2], h: shape[3]}, this._shapeRadius ?? radius, null, 1, depth);
            }
            finally { cr.$dispose(); }
        });
        this.actor.connect('notify::allocation', sync);
        this.actor.connect('notify::mapped', sync);
        this.actor.connect('notify::opacity', sync);
        this.actor.connect('notify::visible', sync);
        this.syncShadow = sync;
        let shadowAlive = true;
        holder.connect('destroy', () => { shadowAlive = false; });
        this.actor.connect('destroy', () => { if (attachIdle) GLib.source_remove(attachIdle); attachIdle = 0; if (shadowAlive) holder.destroy(); });
        this.shadowActor = holder;
    }
    syncBackground() {
        const a = this.actor;
        const box = a.get_allocation_box();
        const allocatedWidth = box.get_width(), allocatedHeight = box.get_height();
        if (!(allocatedWidth > 0 && allocatedHeight > 0)) return;
        // Allocation callbacks can run before the parent is on stage. Asking
        // for its transformed position there produces NaN on Shell 50+.
        let x = 0, y = 0;
        for (let node = a; node && node !== global.stage; node = node.get_parent()) {
            x += Number.isFinite(node.x) ? node.x : 0;
            y += Number.isFinite(node.y) ? node.y : 0;
            x += node.translation_x || 0;
            y += node.translation_y || 0;
        }
        const physical = this.monitor.virtual ? this.monitor : Main.layoutManager.monitors[this.monitor.index] ?? this.monitor;
        if (a.mapped) {
            const position = a.get_transformed_position();
            if (position.every(Number.isFinite)) [x, y] = position;
        }
        const pad = this.margin;
        // Atelier keeps sampling bounds in 64px steps, so moving masks do
        // not continuously recreate and resize their blur textures.
        const sampleX = Math.floor((x - pad) / 64) * 64;
        const sampleY = Math.floor((y - pad) / 64) * 64;
        const sampleW = Math.max(1, Math.ceil((x + allocatedWidth + pad) / 64) * 64 - sampleX);
        const sampleH = Math.max(1, Math.ceil((y + allocatedHeight + pad) / 64) * 64 - sampleY);
        const bounds = [x, y, allocatedWidth, allocatedHeight, physical.x, physical.y, physical.width, physical.height];
        if (!bounds.every(Number.isFinite) || !(physical.width > 0 && physical.height > 0)) return;
        if (this._bounds?.every((v, i) => v === bounds[i])) {
            return;
        }
        this._bounds = bounds;
        this.crop?.set_position(sampleX - x, sampleY - y);
        this.crop?.set_size(sampleW, sampleH);
        this.wallpaper?.set_size(sampleW, sampleH);
        const bg = this.manager?.backgroundActor;
        if (bg) {
            bg.set_position(physical.x - sampleX, physical.y - sampleY);
            bg.set_size(physical.width, physical.height);
        }
        if (this.liveClone) {
            this.liveClone.set_position(physical.x - sampleX, physical.y - sampleY);
            this.liveClone.set_size(physical.width * this.liveScene.resolution, physical.height * this.liveScene.resolution);
        }

    }
    rectangle(width, height, radius, rect = [0, 0, width, height]) {
        const changed = this._shapeRadius !== radius || !this._shape?.every((v, i) => v === rect[i]);
        this._shape = rect;
        this._shapeRadius = radius;
        this.mask.set('frame', [0]);
        this.mask.set('rect', rect);
        this.mask.set('radius', [radius]);
        if (changed) this.syncShadow?.();
        this.syncBackground();
    }
    frame(rect, width, height, sides, radius, popup, notification, drawerOnly = false) {
        this.mask.set('frame', [1]);
        this.mask.set('offset', rect.slice(0, 2));
        this.mask.set('drawer_only', [drawerOnly ? 1 : 0]);
        this.mask.set('base', [sides.left, sides.top, width - sides.left - sides.right, height - sides.top - sides.bottom]);
        this.mask.set('radius', [radius]);
        this.mask.set('simple_frame', [!popup && !notification ? 1 : 0]);
        if (!popup && !notification) { this.syncBackground(); return; }
        const path = new LiquidPath();
        openingPath(path, width, height, sides, radius, popup, notification);
        const data = path.uniforms();
        this.framePath = path;
        this.mask.set('path[0]', data.geometry);
        this.mask.set('path_type[0]', data.types);
        this.mask.set('path_count', [data.count]);
        this.syncBackground();
    }
}
