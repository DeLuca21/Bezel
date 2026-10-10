import Gsk from 'gi://Gsk';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk';

// Keep the existing cells and column count during a drag. An internal move
// uses the source cell as the gap instead of adding an extra wrapping chip.
export class ChipDropPreview {
    constructor(container, idOf) { this.container = container; this.idOf = idOf; this.active = false; }
    reset() {
        if (!this.cells) return;
        if (this.tick) this.container.remove_tick_callback(this.tick);
        this.container.overflow = this.overflow;
        for (const cell of this.cells) cell.child.opacity = cell.opacity;
        this.container.queue_allocate();
        this.cells = null; this.order = null; this.tick = 0; this.active = false; this.before = '';
    }
    motion(x, y, dragged, size = {}) {
        if (!this.cells) {
            this.overflow = this.container.overflow;
            this.container.overflow = Gtk.Overflow.HIDDEN;
            this.cells = [];
            for (let child = this.container.get_first_child(); child; child = child.get_next_sibling()) {
                const rect = child.get_allocation();
                this.cells.push({child, id: this.idOf(child.get_child()), x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: child.opacity});
            }
            this.source = this.cells.find(c => c.id === dragged);
            if (this.source) this.source.child.opacity = 0;
            this.tick = this.container.add_tick_callback(() => { this._allocatePreview(); return true; });
        }
        // Hit-test the original slots, never the chips displaced by the preview.
        // A row has one shared band even when it contains a tall group chip.
        const candidates = this.cells.filter(c => c.id && c.id !== dragged);
        const rows = [];
        for (const cell of this.cells) {
            let row = rows.find(r => Math.abs(r.y - cell.y) < 4);
            if (!row) { row = {y: cell.y, bottom: cell.y + cell.height, cells: []}; rows.push(row); }
            row.bottom = Math.max(row.bottom, cell.y + cell.height);
            if (candidates.includes(cell)) row.cells.push(cell);
        }
        rows.sort((a, b) => a.y - b.y);
        const band = rows.find((r, i) => i === rows.length - 1 || y < (r.bottom + rows[i + 1].y) / 2);
        const row = band?.cells || [];
        const before = row.find(c => x < c.x + c.width / 2)?.id
            || candidates.find(c => c.y > (band?.y ?? Infinity) + 4)?.id || '';
        if (this.active && before === this.before) return before;
        this.before = before; this.active = true;
        const moving = this.source || {width: Math.max(48, size.width || 96), height: Math.max(28, size.height || 36)};
        this.order = this.cells.filter(c => c !== this.source);
        const index = before ? this.order.findIndex(c => c.id === before) : this.order.length;
        this.order.splice(index < 0 ? this.order.length : index, 0, moving);
        this._allocatePreview();
        return before;
    }
    _allocatePreview() {
        if (!this.order) return;
        // Move only allocations. Changing FlowBox minimum sizes or column counts
        // propagates into the settings window's preferred size during the drag.
        let x = 0, y = 0, height = 0;
        const gap = this.container.column_spacing, rowGap = this.container.row_spacing;
        const width = this.container.get_width();
        for (const cell of this.order) {
            if (x && x + cell.width > width + 1) { x = 0; y += height + rowGap; height = 0; }
            if (cell.child) {
                const transform = new Gsk.Transform().translate(new Graphene.Point({x, y}));
                cell.child.allocate(cell.width, cell.height, -1, transform);
            }
            x += cell.width + gap; height = Math.max(height, cell.height);
        }
    }
}
