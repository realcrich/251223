"""
Corner gap post-processor for band_layout.py output.

Reads p*_output.json files, identifies corner gaps in RESIDENTIAL_TYPICAL floors,
extends the smaller adjacent unit to fill the gap, and pushes back the larger unit
by 2ft to create a 5ft corridor. Outputs a PNG visualization.

Usage:
    .venv/bin/python fix_corners.py              # process all projects, write PNGs
    .venv/bin/python fix_corners.py --write-json  # also overwrite the output JSONs
"""

import json, math, sys, copy
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly
import numpy as np

# ── Geometry helpers ──────────────────────────────────────────

def dist(a, b):
    return math.hypot(b[0]-a[0], b[1]-a[1])

def vadd(a, b):
    return (a[0]+b[0], a[1]+b[1])

def vsub(a, b):
    return (a[0]-b[0], a[1]-b[1])

def vscale(v, s):
    return (v[0]*s, v[1]*s)

def vneg(v):
    return (-v[0], -v[1])

def dot(a, b):
    return a[0]*b[0] + a[1]*b[1]

def poly_area(pts):
    n = len(pts)
    return abs(sum(pts[i][0]*pts[(i+1)%n][1] - pts[(i+1)%n][0]*pts[i][1] for i in range(n))) / 2

def centroid(pts):
    n = len(pts)
    return (sum(p[0] for p in pts)/n, sum(p[1] for p in pts)/n)


# ── Layout geometry recovery ─────────────────────────────────

def recover_geometry(meta):
    """Recover edge directions, normals, rect corners from layout_metadata."""
    rangle = math.radians(meta['rangle_deg'])
    ca, sa = math.cos(rangle), math.sin(rangle)
    dir_x, dir_y = (ca, sa), (-sa, ca)
    edge_dirs = [dir_x, dir_y, vneg(dir_x), vneg(dir_y)]
    edge_normals = [dir_y, vneg(dir_x), vneg(dir_y), dir_x]
    edge_lens = [meta['rw'], meta['rh'], meta['rw'], meta['rh']]
    rect = [tuple(c) for c in meta['rect_corners']]
    depth = meta['depth']
    corr_w = meta['corr_w']
    door_w = 4
    cs = depth + door_w  # corner span along each edge
    return rect, edge_dirs, edge_normals, edge_lens, depth, corr_w, cs


# ── Corner identification ────────────────────────────────────

def find_corner_units(units, rect, edge_dirs, cs):
    """
    For each of the 4 rect corners, find the two adjacent dwelling units.

    At corner ci:
      - unit_a: last unit on previous edge, whose outer-end vertex matches rect[ci]
      - unit_b: first unit on current edge, whose outer-start vertex matches
                rect[ci] + cs * edge_dirs[ci]

    Returns list of 4 dicts with corner info.
    """
    TOL = 2.0  # tolerance in feet for vertex matching

    corners = []
    for ci in range(4):
        corner_pt = rect[ci]
        corner_end = vadd(corner_pt, vscale(edge_dirs[ci], cs))

        # Find unit_a: unit whose v1 (outer end) is near corner_pt
        # The prev edge is (ci-1)%4. unit_a's v1 should be near rect[ci].
        best_a = None
        best_a_d = TOL

        # Find unit_b: unit whose v0 (outer start) is near corner_end
        best_b = None
        best_b_d = TOL

        for idx, u in enumerate(units):
            if u['type'] != 'DWELLING_UNIT':
                continue
            verts = u['geometry']['vertices']
            v0 = tuple(verts[0])
            v1 = tuple(verts[1])

            d_a = dist(v1, corner_pt)
            if d_a < best_a_d:
                best_a_d = d_a
                best_a = idx

            d_b = dist(v0, corner_end)
            if d_b < best_b_d:
                best_b_d = d_b
                best_b = idx

        corners.append({
            'ci': ci,
            'corner_pt': corner_pt,
            'corner_end': corner_end,
            'unit_a_idx': best_a,
            'unit_b_idx': best_b,
        })

    return corners


# ── Corner fill algorithm ────────────────────────────────────

def fix_corner(spaces, corner_info, edge_dirs, edge_normals, depth, corr_w, cs):
    """
    Fill a single corner gap by extending the smaller unit and pushing back the larger.

    Modifies spaces in-place.
    Returns a dict describing the changes for visualization.
    """
    ci = corner_info['ci']
    idx_a = corner_info['unit_a_idx']
    idx_b = corner_info['unit_b_idx']

    if idx_a is None or idx_b is None:
        return None

    unit_a = spaces[idx_a]
    unit_b = spaces[idx_b]

    verts_a = [tuple(v) for v in unit_a['geometry']['vertices']]
    verts_b = [tuple(v) for v in unit_b['geometry']['vertices']]

    # Unit widths (along their respective edges)
    width_a = dist(verts_a[0], verts_a[1])
    width_b = dist(verts_b[0], verts_b[1])

    # The prev edge direction (edge that unit_a is on)
    prev_ei = (ci - 1) % 4
    curr_ei = ci

    # Corridor clearance: we want 5ft clear corridor at the corner
    corridor_target = 5.0
    push_back = 2.0  # push the larger unit back by 2ft

    changes = {
        'ci': ci,
        'width_a': width_a,
        'width_b': width_b,
        'smaller': 'a' if width_a <= width_b else 'b',
        'old_verts_a': list(verts_a),
        'old_verts_b': list(verts_b),
    }

    if width_a <= width_b:
        # unit_a is smaller → extend unit_a into the corner along edge_dirs[curr_ei]
        # unit_a's facing edge is v1-v2 (v1=outer end near corner, v2=inner end)
        # Extension should stop at unit_b's corridor-facing wall (v3).

        v1_a = verts_a[1]  # outer end of unit_a (near rect corner)
        v2_a = verts_a[2]  # inner end of unit_a

        ext_dir = edge_dirs[curr_ei]

        # Account for push_back: unit_b will be pushed forward, so use its
        # pushed position as the extension/clamping target.
        pushed_b0 = vadd(verts_b[0], vscale(ext_dir, push_back))
        pushed_b3 = vadd(verts_b[3], vscale(ext_dir, push_back))

        # Extension along adjacent edge: stop at unit_b's pushed inner wall
        delta_to_b_inner = vsub(pushed_b3, v2_a)
        ext_amount = dot(delta_to_b_inner, ext_dir)
        if ext_amount < 3:
            ext_amount = 3

        ext_v1 = vadd(v1_a, vscale(ext_dir, ext_amount))  # outer extension corner
        ext_v2 = vadd(v2_a, vscale(ext_dir, ext_amount))  # inner extension corner

        # Also extend v4,v5 (the original inner vertices) perpendicular toward
        # unit_b's pushed outer wall (v0 side).
        perp_dir = edge_normals[prev_ei]  # inward normal of unit_a's edge
        delta_to_b_outer = vsub(pushed_b0, v1_a)
        perp_amount = dot(delta_to_b_outer, perp_dir)

        # Move v2 (corner-adjacent inner vertex) fully to unit_b's outer wall.
        moved_v2 = vadd(verts_a[2], vscale(perp_dir, perp_amount))

        # Move v3 (far-from-corner inner vertex) perpendicular too, but clamp
        # so it doesn't extend past unit_b's pushed inner-start boundary.
        delta_v3_to_b_inner = vsub(pushed_b3, verts_a[3])
        max_perp_v3 = dot(delta_v3_to_b_inner, perp_dir)
        clamped_perp_v3 = min(perp_amount, max(0, max_perp_v3))
        moved_v3 = vadd(verts_a[3], vscale(perp_dir, clamped_perp_v3))

        # When clamping occurred, add a step vertex at v2's position (but at
        # the clamped depth) to avoid a diagonal edge cutting through neighbors.
        if clamped_perp_v3 < perp_amount - 0.1:
            step_v = vadd(verts_a[2], vscale(perp_dir, clamped_perp_v3))
            new_verts_a = [verts_a[0], verts_a[1], ext_v1, ext_v2, moved_v2, step_v, moved_v3]
        else:
            new_verts_a = [verts_a[0], verts_a[1], ext_v1, ext_v2, moved_v2, moved_v3]

        # Push back unit_b: move v0 and v3 by push_back along edge_dirs[curr_ei]
        new_verts_b = list(verts_b)
        new_verts_b[0] = vadd(verts_b[0], vscale(ext_dir, push_back))
        new_verts_b[3] = vadd(verts_b[3], vscale(ext_dir, push_back))

    else:
        # unit_b is smaller → extend unit_b backward into the corner
        # unit_b's facing edge is v0-v3 (v0=outer start near corner_end, v3=inner start)
        # Extension should stop at unit_a's corridor-facing wall (v2).

        v0_b = verts_b[0]  # outer start of unit_b
        v3_b = verts_b[3]  # inner start of unit_b

        ext_dir = vneg(edge_dirs[curr_ei])  # back toward the corner

        # Account for push_back: unit_a will be pushed back, so use its
        # pushed position as the extension/clamping target.
        push_dir = vneg(edge_dirs[prev_ei])
        pushed_a1 = vadd(verts_a[1], vscale(push_dir, push_back))
        pushed_a2 = vadd(verts_a[2], vscale(push_dir, push_back))

        # Extension along adjacent edge: stop at unit_a's pushed inner wall
        delta_to_a_inner = vsub(pushed_a2, v3_b)
        ext_amount = dot(delta_to_a_inner, ext_dir)
        if ext_amount < 3:
            ext_amount = 3

        ext_v0 = vadd(v0_b, vscale(ext_dir, ext_amount))  # outer extension corner
        ext_v3 = vadd(v3_b, vscale(ext_dir, ext_amount))  # inner extension corner

        # Also extend v4,v5 (the original inner vertices) perpendicular toward
        # unit_a's pushed outer wall (v1 side).
        perp_dir = edge_normals[curr_ei]  # inward normal of unit_b's edge
        delta_to_a_outer = vsub(pushed_a1, v0_b)
        perp_amount = dot(delta_to_a_outer, perp_dir)

        # Move v3 (corner-adjacent inner vertex) fully to unit_a's outer wall.
        moved_v3_orig = vadd(verts_b[3], vscale(perp_dir, perp_amount))

        # Move v2 (far-from-corner inner vertex) perpendicular too, but clamp
        # so it doesn't extend past unit_a's pushed inner-end boundary.
        delta_v2_to_a_inner = vsub(pushed_a2, verts_b[2])
        max_perp_v2 = dot(delta_v2_to_a_inner, perp_dir)
        clamped_perp_v2 = min(perp_amount, max(0, max_perp_v2))
        moved_v2 = vadd(verts_b[2], vscale(perp_dir, clamped_perp_v2))

        # When clamping occurred, add a step vertex at v3's position (but at
        # the clamped depth) to avoid a diagonal edge cutting through neighbors.
        if clamped_perp_v2 < perp_amount - 0.1:
            step_v = vadd(verts_b[3], vscale(perp_dir, clamped_perp_v2))
            new_verts_b = [ext_v0, verts_b[0], verts_b[1], moved_v2, step_v, moved_v3_orig, ext_v3]
        else:
            new_verts_b = [ext_v0, verts_b[0], verts_b[1], moved_v2, moved_v3_orig, ext_v3]

        # Push back unit_a: move v1 and v2 backward along edge_dirs[prev_ei]
        push_dir = vneg(edge_dirs[prev_ei])
        new_verts_a = list(verts_a)
        new_verts_a[1] = vadd(verts_a[1], vscale(push_dir, push_back))
        new_verts_a[2] = vadd(verts_a[2], vscale(push_dir, push_back))

    # Update geometries
    unit_a['geometry']['vertices'] = [[round(v[0], 2), round(v[1], 2)] for v in new_verts_a]
    unit_b['geometry']['vertices'] = [[round(v[0], 2), round(v[1], 2)] for v in new_verts_b]

    # Recalculate areas
    area_a = poly_area(new_verts_a)
    area_b = poly_area(new_verts_b)
    unit_a['actual_area_sf'] = round(area_a, 1)
    unit_b['actual_area_sf'] = round(area_b, 1)

    # Update area deviations
    for u in [unit_a, unit_b]:
        target = u['target_area_sf']
        actual = u['actual_area_sf']
        if target > 0:
            dev = (actual - target) / target * 100
            u['area_deviation'] = f"{'+' if dev >= 0 else ''}{dev:.1f}%"

    changes['new_verts_a'] = [[round(v[0], 2), round(v[1], 2)] for v in new_verts_a]
    changes['new_verts_b'] = [[round(v[0], 2), round(v[1], 2)] for v in new_verts_b]
    changes['ext_amount'] = ext_amount
    changes['name_a'] = unit_a['name']
    changes['name_b'] = unit_b['name']

    return changes


# ── Visualization ─────────────────────────────────────────────

COLORS = {
    'DWELLING_UNIT': '#bbdefb',
    'CORE': '#e0e0e0',
    'SUPPORT': '#ffccbc',
    'CIRCULATION': '#d1c4e9',
    'AMENITY': '#e8f5e9',
    'corner_fill': '#fff9c4',  # yellow for the extension area
}

def draw_floor(ax, floor, boundary, rect, edge_dirs, edge_normals, depth, cs,
               corner_changes=None, show_vertex_labels=False, title_extra=''):
    """Draw a single floor plan with detailed labels."""
    # Boundary
    bd = [tuple(p) for p in boundary]
    bx = [p[0] for p in bd] + [bd[0][0]]
    by = [p[1] for p in bd] + [bd[0][1]]
    ax.fill(bx, by, fc='#f5f5f5', ec='#333', lw=1.5, zorder=1)

    # Inscribed rectangle
    rx = [p[0] for p in rect] + [rect[0][0]]
    ry = [p[1] for p in rect] + [rect[0][1]]
    ax.plot(rx, ry, 'k-', lw=1.5, zorder=5)

    # Draw corner gap quads (dashed red outlines showing the full gap area)
    for ci in range(4):
        prev_ei = (ci - 1) % 4
        corner_pt = rect[ci]
        corner_end = vadd(corner_pt, vscale(edge_dirs[ci], cs))
        inner_pt = vadd(corner_pt, vscale(edge_normals[prev_ei], depth))
        inner_end = vadd(corner_end, vscale(edge_normals[ci], depth))
        # The gap quad: from corner vertex, along curr edge to corner_end,
        # then inward by depth, back, and inward by depth
        # Actually the corner is bounded by two perpendicular edges
        gap_quad = [corner_pt, corner_end, inner_end, inner_pt]
        ax.add_patch(MplPoly(gap_quad, closed=True, fc='none', ec='red',
                             ls='--', lw=1.0, zorder=6, alpha=0.7))

    # Spaces
    for space in floor['spaces']:
        geom = space['geometry']
        stype = space['type']

        if 'vertices' in geom:
            verts = [tuple(v) for v in geom['vertices']]
        else:
            continue

        fc = COLORS.get(stype, '#eee')
        ec = '#333'
        lw = 0.5

        n_verts = len(verts)
        if n_verts > 4 and stype == 'DWELLING_UNIT':
            fc = COLORS['corner_fill']
            lw = 1.5
            ec = '#f57f17'

        ax.add_patch(MplPoly(verts, closed=True, fc=fc, ec=ec, lw=lw, zorder=2))

        # Full name label (e.g., "Studio 1", "1BR 2")
        cx, cy = centroid(verts)
        name = space.get('name', space['id'])
        fs = 5 if stype == 'DWELLING_UNIT' else 4
        ax.text(cx, cy, name, ha='center', va='center', fontsize=fs,
                color='#333', fontweight='bold', zorder=3)

        # Vertex labels on extended units
        if show_vertex_labels and n_verts > 4 and stype == 'DWELLING_UNIT':
            for vi, v in enumerate(verts):
                ax.plot(v[0], v[1], 'ko', markersize=2, zorder=8)
                ax.text(v[0]+1, v[1]+1, f'v{vi}', fontsize=4, color='#333', zorder=8)

    # Corner vertex markers with detailed annotations
    for ci in range(4):
        pt = rect[ci]
        ax.plot(pt[0], pt[1], 'ro', markersize=5, zorder=10)
        ax.text(pt[0]+3, pt[1]+3, f'C{ci}', fontsize=7, color='red',
                fontweight='bold', zorder=10,
                bbox=dict(boxstyle='round,pad=0.2', fc='white', ec='red', alpha=0.8))

    # Corner change annotations
    if corner_changes:
        for ch in corner_changes:
            if ch is None:
                continue
            ci = ch['ci']
            pt = rect[ci]
            name_a = ch.get('name_a', '?')
            name_b = ch.get('name_b', '?')
            wa = ch['width_a']
            wb = ch['width_b']
            smaller = 'A' if ch['smaller'] == 'a' else 'B'
            ext = ch.get('ext_amount', 0)

            annotation = (f"C{ci}\n"
                          f"A: {name_a} ({wa:.0f}ft)\n"
                          f"B: {name_b} ({wb:.0f}ft)\n"
                          f"Extended: {smaller} (+{ext:.0f}ft)")

            # Place annotation outside the building
            offset_x = 30 if pt[0] < 0 else -80
            offset_y = 30 if pt[1] < 0 else -30

            ax.annotate(annotation,
                        xy=pt, xytext=(pt[0]+offset_x, pt[1]+offset_y),
                        fontsize=5, fontfamily='monospace',
                        bbox=dict(boxstyle='round,pad=0.3', fc='lightyellow', ec='orange', alpha=0.9),
                        arrowprops=dict(arrowstyle='->', color='orange', lw=0.8),
                        zorder=15)

    ax.set_aspect('equal')
    ax.axis('off')
    allx = [p[0] for p in bd]
    ally = [p[1] for p in bd]
    pad = 40  # more padding for annotations
    ax.set_xlim(min(allx)-pad, max(allx)+pad)
    ax.set_ylim(min(ally)-pad, max(ally)+pad)
    ax.set_title(title_extra, fontsize=9, fontweight='bold')


def visualize(pid, data_before, data_after, corner_changes_list, output_path):
    """Create a before/after PNG for one project."""
    meta = data_after.get('layout_metadata', {})
    rect = [tuple(c) for c in meta.get('rect_corners', [])]
    rect_geom = recover_geometry(meta)
    _, edge_dirs, edge_normals, _, depth, _, cs = rect_geom

    # Find first residential floor with dwelling units in BOTH before and after
    floor_before = None
    floor_after = None
    boundary = None

    for fb in data_before['building']['floors']:
        if fb['floor_type'] != 'RESIDENTIAL_TYPICAL':
            continue
        has_units = any(s['type'] == 'DWELLING_UNIT' for s in fb['spaces'])
        if has_units:
            floor_before = fb
            boundary = fb['boundary']
            break

    if floor_before is None:
        print(f"  {pid}: no residential floor with units found in before data")
        return

    # Find matching floor in after data
    target_fi = floor_before['floor_index']
    for fa in data_after['building']['floors']:
        if fa['floor_index'] == target_fi:
            floor_after = fa
            break

    if floor_after is None:
        print(f"  {pid}: no matching after floor found")
        return

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(20, 10))

    draw_floor(ax1, floor_before, boundary, rect, edge_dirs, edge_normals, depth, cs,
               corner_changes=None, show_vertex_labels=False,
               title_extra=f'{pid.upper()} — BEFORE (floor {target_fi})')

    draw_floor(ax2, floor_after, boundary, rect, edge_dirs, edge_normals, depth, cs,
               corner_changes=corner_changes_list, show_vertex_labels=True,
               title_extra=f'{pid.upper()} — AFTER (corners fixed, floor {target_fi})')

    fig.suptitle(f'{pid.upper()} Corner Fix — depth={depth:.0f}ft, cs={cs:.0f}ft, corr_w={meta["corr_w"]}ft',
                 fontsize=11, fontweight='bold')
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f"  PNG → {output_path}")


# ── Main ──────────────────────────────────────────────────────

def process_project(pid, input_path, write_json=False):
    """Process a single project."""
    print(f"\n{'='*60}")
    print(f"  {pid.upper()}: Corner fix")
    print(f"{'='*60}")

    with open(input_path) as f:
        data = json.load(f)

    meta = data.get('layout_metadata')
    if not meta:
        print(f"  No layout_metadata found — run band_layout.py --json first")
        return None

    # Keep a deep copy for before/after comparison
    data_before = copy.deepcopy(data)

    rect, edge_dirs, edge_normals, edge_lens, depth, corr_w, cs = recover_geometry(meta)

    print(f"  Rect: {meta['rw']:.0f}x{meta['rh']:.0f}, depth={depth:.0f}, corr_w={corr_w}, cs={cs:.0f}")
    print(f"  Layout mode: {meta['layout_mode']}")

    all_corner_changes = []

    for floor in data['building']['floors']:
        if floor['floor_type'] != 'RESIDENTIAL_TYPICAL':
            continue

        # Skip floors with no dwelling units
        has_units = any(s['type'] == 'DWELLING_UNIT' for s in floor['spaces'])
        if not has_units:
            continue

        fi = floor['floor_index']
        corners = find_corner_units(floor['spaces'], rect, edge_dirs, cs)

        changes_made = 0
        floor_changes = []
        for corner in corners:
            ci = corner['ci']
            idx_a = corner['unit_a_idx']
            idx_b = corner['unit_b_idx']

            if idx_a is None or idx_b is None:
                print(f"  Floor {fi}, Corner {ci}: no adjacent unit found (a={idx_a}, b={idx_b})")
                floor_changes.append(None)
                continue

            name_a = floor['spaces'][idx_a]['name']
            name_b = floor['spaces'][idx_b]['name']

            result = fix_corner(floor['spaces'], corner, edge_dirs, edge_normals, depth, corr_w, cs)

            if result:
                smaller = name_a if result['smaller'] == 'a' else name_b
                print(f"  Floor {fi}, Corner {ci}: extended {smaller} "
                      f"(a={name_a} w={result['width_a']:.0f}, b={name_b} w={result['width_b']:.0f})"
                      f" ext={result['ext_amount']:.0f}ft")
                changes_made += 1
                floor_changes.append(result)
            else:
                floor_changes.append(None)

        if changes_made > 0:
            print(f"  Floor {fi}: {changes_made} corners fixed")
            all_corner_changes = floor_changes

        # Only fix the first residential floor with units — all others are identical
        if changes_made > 0:
            template_spaces = floor['spaces']
            for other_floor in data['building']['floors']:
                if other_floor['floor_type'] == 'RESIDENTIAL_TYPICAL' and other_floor['floor_index'] != fi:
                    new_spaces = copy.deepcopy(template_spaces)
                    ofi = other_floor['floor_index']
                    for sp in new_spaces:
                        sp['floor_index'] = ofi
                        sp['id'] = sp['id'].rsplit('_f', 1)[0] + f'_f{ofi}'
                    other_floor['spaces'] = new_spaces
            break

    # Write JSON if requested
    if write_json:
        with open(input_path, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"  JSON → {input_path}")

    return data_before, data, all_corner_changes


if __name__ == '__main__':
    write_json = '--write-json' in sys.argv

    ROOT = Path(__file__).parent
    DATA_DIR = ROOT / 'web-viewer' / 'public' / 'data'
    OUT_DIR = ROOT / 'web-viewer' / 'output'
    OUT_DIR.mkdir(exist_ok=True)

    projects = ['p1', 'p4', 'p7', 'p9']

    for pid in projects:
        input_path = DATA_DIR / f'{pid}_output.json'
        if not input_path.exists():
            print(f"  {pid}: output not found at {input_path}")
            continue

        result = process_project(pid, input_path, write_json=write_json)
        if result:
            data_before, data_after, corner_changes = result
            png_path = OUT_DIR / f'{pid}_corner_fix.png'
            visualize(pid, data_before, data_after, corner_changes, png_path)

    print(f"\nDone! Check PNGs in {OUT_DIR}/")
