"""
band_layout.py — v7: Inner ring / courtyard + BOH/Circ rooms

Grid legend:
  S=studio  1=1BR  2=2BR  3=3BR  K=corner
  B=BOH  C=Circ  O=courtyard(open)
  .=corridor  #=core  ~=parcel_area  (space)=outside
  !=overlap  ?=gap(inside building, unclaimed)

Run: .venv/bin/python band_layout.py
"""
import json, math
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly

# ── Geometry ──────────────────────────────────────────────────
def poly_area(pts):
    n=len(pts); return abs(sum(pts[i][0]*pts[(i+1)%n][1]-pts[(i+1)%n][0]*pts[i][1] for i in range(n)))/2

def centroid(pts):
    return (sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts))

def scale_poly(pts,f):
    cx,cy=centroid(pts); return [(cx+(x-cx)*f,cy+(y-cy)*f) for x,y in pts]

def scale_to_area(pts,target):
    return scale_poly(pts,math.sqrt(target/max(poly_area(pts),1)))

def center_at_origin(pts):
    cx,cy=centroid(pts); return [(x-cx,y-cy) for x,y in pts]

def dist(a,b): return math.hypot(b[0]-a[0],b[1]-a[1])
def vadd(a,b): return (a[0]+b[0],a[1]+b[1])
def vscale(v,s): return (v[0]*s,v[1]*s)
def vneg(v): return (-v[0],-v[1])

def point_in_poly(pt,poly):
    x,y=pt;n=len(poly);inside=False;j=n-1
    for i in range(n):
        xi,yi=poly[i];xj,yj=poly[j]
        if ((yi>y)!=(yj>y)) and (x<(xj-xi)*(y-yi)/(yj-yi)+xi): inside=not inside
        j=i
    return inside

def line_intersect(p1,p2,p3,p4):
    d=(p1[0]-p2[0])*(p3[1]-p4[1])-(p1[1]-p2[1])*(p3[0]-p4[0])
    if abs(d)<1e-10: return None
    t=((p1[0]-p3[0])*(p3[1]-p4[1])-(p1[1]-p3[1])*(p3[0]-p4[0]))/d
    return (p1[0]+t*(p2[0]-p1[0]),p1[1]+t*(p2[1]-p1[1]))

def signed_area(pts):
    n=len(pts); return sum(pts[i][0]*pts[(i+1)%n][1]-pts[(i+1)%n][0]*pts[i][1] for i in range(n))/2

def inset_polygon(poly,d):
    n=len(poly);ccw=signed_area(poly)>0;lines=[]
    for i in range(n):
        j=(i+1)%n;dx,dy=poly[j][0]-poly[i][0],poly[j][1]-poly[i][1];ln=math.hypot(dx,dy)
        if ln<1e-10: continue
        if ccw: nx,ny=-dy/ln,dx/ln
        else: nx,ny=dy/ln,-dx/ln
        lines.append(((poly[i][0]+nx*d,poly[i][1]+ny*d),(poly[j][0]+nx*d,poly[j][1]+ny*d)))
    result=[]
    for i in range(len(lines)):
        j=(i+1)%len(lines);pt=line_intersect(lines[i][0],lines[i][1],lines[j][0],lines[j][1])
        if pt: result.append(pt)
    return result if len(result)>=3 else scale_poly(poly,0.8)

# ── Max inscribed rectangle ──────────────────────────────────
def max_inscribed_rect(poly):
    best_area=0;best=None;angles=set();n=len(poly)
    for i in range(n):
        j=(i+1)%n;a=math.atan2(poly[j][1]-poly[i][1],poly[j][0]-poly[i][0])
        angles.add(a);angles.add(a+math.pi/2)
    for k in range(36): angles.add(math.pi*k/36)
    for angle in angles:
        ca,sa=math.cos(-angle),math.sin(-angle)
        rot=[(x*ca-y*sa,x*sa+y*ca) for x,y in poly]
        all_y=sorted(p[1] for p in rot);min_y,max_y=all_y[0],all_y[-1]
        ns=50;dy=(max_y-min_y)/ns;levels=[]
        for si in range(ns+1):
            y=min_y+dy*si;xs=[]
            for i in range(len(rot)):
                j=(i+1)%len(rot);y1,y2=rot[i][1],rot[j][1]
                if abs(y2-y1)>1e-10 and (y1-y)*(y2-y)<=0:
                    t=(y-y1)/(y2-y1);xs.append(rot[i][0]+t*(rot[j][0]-rot[i][0]))
            if len(xs)>=2: levels.append((y,min(xs),max(xs)))
        for i in range(len(levels)):
            xl,xr=levels[i][1],levels[i][2]
            for j in range(i+1,len(levels)):
                xl=max(xl,levels[j][1]);xr=min(xr,levels[j][2])
                w=xr-xl;h=levels[j][0]-levels[i][0]
                if w>0 and h>0 and w*h>best_area:
                    best_area=w*h;rcx,rcy=(xl+xr)/2,(levels[i][0]+levels[j][0])/2
                    ca2,sa2=math.cos(angle),math.sin(angle)
                    best=(rcx*ca2-rcy*sa2,rcx*sa2+rcy*ca2,w,h,angle)
    return best

def get_rect_corners(cx,cy,w,h,angle):
    ca,sa=math.cos(angle),math.sin(angle);hw,hh=w/2,h/2
    return [(cx+(-hw)*ca-(-hh)*sa,cy+(-hw)*sa+(-hh)*ca),(cx+(hw)*ca-(-hh)*sa,cy+(hw)*sa+(-hh)*ca),
            (cx+(hw)*ca-(hh)*sa,cy+(hw)*sa+(hh)*ca),(cx+(-hw)*ca-(hh)*sa,cy+(-hw)*sa+(hh)*ca)]

# ── Parcels ───────────────────────────────────────────────────
def geo2ft(coords):
    ring=coords[:-1] if (len(coords)>1 and coords[-1]==coords[0]) else coords
    clng=sum(c[0] for c in ring)/len(ring);clat=sum(c[1] for c in ring)/len(ring)
    return [((lng-clng)*288200,(lat-clat)*364000) for lng,lat in ring]

PARCELS = {
    'p1': geo2ft([[-118.37490349962798,34.165693990658085],[-118.37467334233435,34.165789208630216],[-118.37469682777262,34.1659368934356],[-118.37484948312057,34.166181738727914],[-118.37480486078779,34.16620700050339],[-118.37496925885486,34.166504311600875],[-118.3753004035324,34.16637023025507]]),
    'p4': geo2ft([[-118.47128304946774,34.026451245666564],[-118.47099221555277,34.0262102081888],[-118.47056275986552,34.0265706378093],[-118.47063886593685,34.02664497622831],[-118.47054101527391,34.0267508520451],[-118.47073671659979,34.02690403384527]]),
    'p7': geo2ft([[-118.59721278909241,34.1881917698952],[-118.59721614524025,34.18744774676111],[-118.59636368366544,34.18745052297892],[-118.5963603275176,34.18819732228182]]),
    'p9': geo2ft([[-118.25022093172518,34.0502674231122],[-118.24971135075477,34.049947450481866],[-118.24956967353441,34.05010270362472],[-118.24968164424081,34.050168970123906],[-118.24962908656231,34.050214409978864],[-118.2496610781927,34.0502352365705],[-118.24943942189637,34.05047379535168],[-118.24981875122825,34.05071424677597]]),
}

UNIT_CHAR = {'studio':'S','1br':'1','2br':'2','3br':'3','corner':'K'}
COLORS = {'studio':'#c8e6c9','1br':'#bbdefb','2br':'#ffe0b2','3br':'#f8bbd0',
          'corner':'#e0e0e0','boh':'#ffccbc','circ':'#d1c4e9'}
LABELS = {'studio':'ST','1br':'1B','2br':'2B','3br':'3B','corner':'CR'}


# ── Layout engine ─────────────────────────────────────────────
def compute_layout(data):
    pid = data['project_id']
    fp_area = data['building']['floor_plate_sf']
    corr_w = data['circulation']['corridor_width_ft']
    d_floors = data['building']['story_distribution']['dwelling']
    avg_depth = sum(u['depth_ft'] for u in data['dwelling_units']) / len(data['dwelling_units'])

    parcel = PARCELS.get(pid)
    boundary = center_at_origin(scale_to_area(parcel, fp_area)) if parcel else \
               (lambda h:[(-h,-h),(h,-h),(h,h),(-h,h)])(math.sqrt(fp_area)/2)

    mir = max_inscribed_rect(boundary)
    if not mir:
        h=math.sqrt(fp_area)/2*0.9; mir=(0,0,h*2,h*2,0)
    rcx,rcy,rw,rh,rangle = mir
    rect = get_rect_corners(rcx,rcy,rw,rh,rangle)

    depth = avg_depth
    min_dim = min(rw,rh)

    # Pre-check: simulate layout mode with standard depth formula to decide
    # whether to use single-corridor or double-corridor cross-section.
    test_max_depth = (min_dim - corr_w - 8) / 2
    test_depth = min(avg_depth, max(12, test_max_depth))
    test_inner_w = rw - 2*test_depth
    test_inner_h = rh - 2*test_depth
    test_core_w = test_inner_w - 2*corr_w
    test_core_h = test_inner_h - 2*corr_w
    test_min_core = min(test_core_w, test_core_h) if (test_core_w > 0 and test_core_h > 0) else 0
    test_inner_depth = min(test_depth, (test_min_core - 2*corr_w - 8) / 2) if test_min_core > 0 else 0

    # Standard depth (used for cs calculation in all modes)
    std_max_depth = (min_dim - corr_w - 8) / 2
    std_depth = min(avg_depth, max(12, std_max_depth))

    if test_inner_depth >= 12:
        # Courtyard-capable — standard formula preserves core space
        if depth > std_max_depth: depth = max(12, std_max_depth)
    elif test_core_w > 4 and test_core_h > 4:
        # Core usable for core_rooms/notch — keep standard formula
        if depth > std_max_depth: depth = max(12, std_max_depth)
    else:
        # True basic mode — single corridor between opposing unit bands.
        # Force depth so units fill to exactly one corridor width apart.
        depth = (min_dim - corr_w) / 2

    door_w = 4
    cs = std_depth + door_w

    ca,sa = math.cos(rangle),math.sin(rangle)
    dir_x,dir_y = (ca,sa),(-sa,ca)
    edge_dirs = [dir_x,dir_y,vneg(dir_x),vneg(dir_y)]
    edge_normals = [dir_y,vneg(dir_x),vneg(dir_y),dir_x]
    edge_lens = [rw,rh,rw,rh]

    # ── Outer corner units ──
    corners = []
    for ci in range(4):
        v = rect[ci]
        o0 = v
        o1 = vadd(v, vscale(edge_dirs[ci], cs))
        i0 = vadd(o0, vscale(edge_normals[ci], depth))
        i1 = vadd(o1, vscale(edge_normals[ci], depth))
        corners.append(([o0, o1, i1, i0], 'corner'))

    # Unit queue — interleaved types
    queue=[]
    type_counts=[(u['type'],u['width_ft'],max(1,round(u['count']/d_floors))) for u in data['dwelling_units']]
    max_c=max(c for _,_,c in type_counts)
    for r in range(max_c):
        for utype,w,c in type_counts:
            if r<c: queue.append((utype,w))

    # ── Outer regular units ──
    units=[];qi=0;units_by_edge={}
    for ei in range(4):
        edge_start=len(units)
        avail=edge_lens[ei]-cs
        if avail<10:
            units_by_edge[ei]=[]
            continue
        origin=vadd(rect[ei],vscale(edge_dirs[ei],cs))
        uw=queue[qi%len(queue)][1] if queue else 20
        num=max(1,round(avail/uw))
        actual_w=avail/num
        while actual_w<14 and num>1: num-=1; actual_w=avail/num
        for k in range(num):
            o0=vadd(origin,vscale(edge_dirs[ei],k*actual_w))
            o1=vadd(origin,vscale(edge_dirs[ei],(k+1)*actual_w))
            i0=vadd(o0,vscale(edge_normals[ei],depth))
            i1=vadd(o1,vscale(edge_normals[ei],depth))
            utype=queue[qi%len(queue)][0];qi+=1
            units.append(([o0,o1,i1,i0],utype))
        units_by_edge[ei]=list(range(edge_start,len(units)))

    # ── Core geometry ──
    inner_w,inner_h=rw-2*depth,rh-2*depth
    corr_rect=get_rect_corners(rcx,rcy,inner_w,inner_h,rangle) if inner_w>0 and inner_h>0 else None
    core_w,core_h=inner_w-2*corr_w,inner_h-2*corr_w

    raw_core = get_rect_corners(rcx,rcy,core_w,core_h,rangle) if core_w>0 and core_h>0 else None

    # Chamfered core for rendering
    if core_w>0 and core_h>0:
        core_chamfer=min(corr_w*1.5,core_w/4,core_h/4)
        core_rect=[]
        for ci2 in range(4):
            v=raw_core[ci2]
            nxt=raw_core[(ci2+1)%4]; prv=raw_core[(ci2-1)%4]
            dn=dist(v,nxt); dp=dist(v,prv)
            dn_dir=((nxt[0]-v[0])/dn,(nxt[1]-v[1])/dn)
            dp_dir=((prv[0]-v[0])/dp,(prv[1]-v[1])/dp)
            core_rect.append(vadd(v,vscale(dp_dir,core_chamfer)))
            core_rect.append(vadd(v,vscale(dn_dir,core_chamfer)))
    else:
        core_rect=None

    # ── Inner layout mode ──
    inner_units = []
    inner_corners = []
    courtyard_rect = None
    boh_room = None
    circ_room = None
    layout_mode = 'basic'
    inner_depth = 0

    min_core = min(core_w, core_h) if (core_w > 0 and core_h > 0) else 0
    if min_core > 0:
        # Inner depth may be smaller than outer to fit courtyard
        inner_depth = min(depth, (min_core - 2*corr_w - 8) / 2)

    if inner_depth >= 12 and core_w > 0 and core_h > 0:
        # ── Case 1: Courtyard — inner ring of units ──
        layout_mode = 'courtyard'
        inner_cs = min(inner_depth + door_w, min(core_w, core_h) / 2)

        for ci in range(4):
            v = raw_core[ci]
            o0 = v
            o1 = vadd(v, vscale(edge_dirs[ci], inner_cs))
            i0 = vadd(o0, vscale(edge_normals[ci], inner_depth))
            i1 = vadd(o1, vscale(edge_normals[ci], inner_depth))
            inner_corners.append(([o0, o1, i1, i0], 'corner'))

        inner_edge_lens = [core_w, core_h, core_w, core_h]
        inner_units_by_edge = {}
        for ei in range(4):
            edge_start = len(inner_units)
            avail = inner_edge_lens[ei] - inner_cs
            if avail < 10:
                inner_units_by_edge[ei] = []
                continue
            origin = vadd(raw_core[ei], vscale(edge_dirs[ei], inner_cs))
            uw = queue[qi % len(queue)][1] if queue else 20
            num = max(1, round(avail / uw))
            actual_w = avail / num
            while actual_w < 14 and num > 1: num -= 1; actual_w = avail / num
            for k in range(num):
                o0 = vadd(origin, vscale(edge_dirs[ei], k * actual_w))
                o1 = vadd(origin, vscale(edge_dirs[ei], (k + 1) * actual_w))
                i0 = vadd(o0, vscale(edge_normals[ei], inner_depth))
                i1 = vadd(o1, vscale(edge_normals[ei], inner_depth))
                utype = queue[qi % len(queue)][0]; qi += 1
                inner_units.append(([o0, o1, i1, i0], utype))
            inner_units_by_edge[ei] = list(range(edge_start, len(inner_units)))

        cy_w = core_w - 2*inner_depth - 2*corr_w
        cy_h = core_h - 2*inner_depth - 2*corr_w
        courtyard_rect = get_rect_corners(rcx, rcy, cy_w, cy_h, rangle) if cy_w > 0 and cy_h > 0 else None

    elif core_w > 10 and core_h > 8:
        # ── Case 2: BOH + Circ rooms in core ──
        layout_mode = 'core_rooms'
        boh_w, boh_h = 4, 4
        circ_w, circ_h = 6, 4
        total_w = boh_w + circ_w  # 10
        if core_w >= core_h:
            boh_dx = -total_w/2 + boh_w/2
            circ_dx = total_w/2 - circ_w/2
            boh_room = get_rect_corners(rcx + boh_dx*ca, rcy + boh_dx*sa, boh_w, boh_h, rangle)
            circ_room = get_rect_corners(rcx + circ_dx*ca, rcy + circ_dx*sa, circ_w, circ_h, rangle)
        else:
            boh_dy = -total_w/2 + boh_w/2
            circ_dy = total_w/2 - circ_w/2
            boh_room = get_rect_corners(rcx - boh_dy*sa, rcy + boh_dy*ca, boh_h, boh_w, rangle)
            circ_room = get_rect_corners(rcx - circ_dy*sa, rcy + circ_dy*ca, circ_h, circ_w, rangle)

    elif core_w > 4 and core_h > 4:
        # ── Case 3: Notch — small rooms in core ──
        layout_mode = 'notch'
        boh_w, boh_h = 4, 4
        circ_w, circ_h = 6, 4
        total_w = boh_w + circ_w
        if core_w >= 10:
            boh_dx = -total_w/2 + boh_w/2
            circ_dx = total_w/2 - circ_w/2
            boh_room = get_rect_corners(rcx + boh_dx*ca, rcy + boh_dx*sa,
                                        boh_w, min(boh_h, core_h*0.9), rangle)
            circ_room = get_rect_corners(rcx + circ_dx*ca, rcy + circ_dx*sa,
                                         circ_w, min(circ_h, core_h*0.9), rangle)
        elif core_h >= 10:
            boh_dy = -total_w/2 + boh_w/2
            circ_dy = total_w/2 - circ_w/2
            boh_room = get_rect_corners(rcx - boh_dy*sa, rcy + boh_dy*ca,
                                        min(boh_h, core_w*0.9), boh_w, rangle)
            circ_room = get_rect_corners(rcx - circ_dy*sa, rcy + circ_dy*ca,
                                         min(circ_h, core_w*0.9), circ_w, rangle)
        else:
            boh_room = get_rect_corners(rcx, rcy, min(4, core_w*0.9), min(4, core_h*0.9), rangle)

    # ── Always place BOH + Circ ──
    # For core_rooms they're in the core already.
    # For courtyard: on outer edge of inner ring units (corridor-facing), split on long edges.
    # For basic: on inner edge of outer ring units (corridor-facing), split on long edges.
    if boh_room is None:
        boh_w, boh_h = 4, 4
        circ_w, circ_h = 6, 4

        def _room_on_unit(unit_verts, rw, rh, on_outer):
            """Place room rect on the outer or inner edge of a unit, centered."""
            o0, o1, i1, i0 = unit_verts
            if on_outer:
                p0, p1, into = o0, o1, i0
            else:
                p0, p1, into = i0, i1, o0
            e_len = dist(p0, p1)
            e_dir = ((p1[0]-p0[0])/e_len, (p1[1]-p0[1])/e_len)
            d_len = dist(p0, into)
            d_dir = ((into[0]-p0[0])/d_len, (into[1]-p0[1])/d_len)
            off = max(0, (e_len - rw) / 2)
            s = vadd(p0, vscale(e_dir, off))
            return [s, vadd(s, vscale(e_dir, rw)),
                    vadd(vadd(s, vscale(e_dir, rw)), vscale(d_dir, rh)),
                    vadd(s, vscale(d_dir, rh))]

        if layout_mode == 'courtyard' and inner_units:
            # Outer edge of inner ring units, split on the two longest edges
            elens = [core_w, core_h, core_w, core_h]
            ranked = sorted(range(4), key=lambda e: len(inner_units_by_edge.get(e,[])), reverse=True)
            long_edges = [e for e in ranked if inner_units_by_edge.get(e)][:2]
            for idx, (rw2, rh2) in enumerate([(boh_w, boh_h), (circ_w, circ_h)]):
                ei = long_edges[idx % len(long_edges)]
                ulist = inner_units_by_edge[ei]
                ui = ulist[len(ulist) // 2]
                room = _room_on_unit(inner_units[ui][0], rw2, rh2, on_outer=True)
                if idx == 0: boh_room = room
                else: circ_room = room
        elif units:
            # Inner edge of outer ring units, split on the two longest edges
            ranked = sorted(range(4), key=lambda e: len(units_by_edge.get(e,[])), reverse=True)
            long_edges = [e for e in ranked if units_by_edge.get(e)][:2]
            for idx, (rw2, rh2) in enumerate([(boh_w, boh_h), (circ_w, circ_h)]):
                ei = long_edges[idx % len(long_edges)]
                ulist = units_by_edge[ei]
                ui = ulist[len(ulist) // 2]
                room = _room_on_unit(units[ui][0], rw2, rh2, on_outer=False)
                if idx == 0: boh_room = room
                else: circ_room = room

    return {
        'boundary':boundary,'rect':rect,'corr_rect':corr_rect,'core_rect':core_rect,
        'units':units,'corners':corners,'depth':depth,'corr_w':corr_w,'cs':cs,
        'fp_area':fp_area,'pid':pid,'rw':rw,'rh':rh,'avg_depth':avg_depth,
        'layout_mode':layout_mode,
        'inner_units':inner_units,'inner_corners':inner_corners,
        'courtyard_rect':courtyard_rect,
        'boh_room':boh_room,'circ_room':circ_room,
        'core_w':core_w,'core_h':core_h,'inner_depth':inner_depth,
        'rcx':rcx,'rcy':rcy,'rangle':rangle,
    }


# ── Text grid rasterizer ─────────────────────────────────────
def rasterize(layout, cell_size=3):
    """Rasterize layout to text grid. Returns (grid_lines, diagnostics)."""
    bd = layout['boundary']
    allx=[p[0] for p in bd]; ally=[p[1] for p in bd]
    x0,x1 = min(allx)-5, max(allx)+5
    y0,y1 = min(ally)-5, max(ally)+5
    cols = int((x1-x0)/cell_size)+1
    rows = int((y1-y0)/cell_size)+1

    layout_mode = layout.get('layout_mode', 'basic')
    courtyard = layout.get('courtyard_rect')
    boh = layout.get('boh_room')
    circ = layout.get('circ_room')

    # Build spaces: corners first (priority), then regular, then inner
    spaces = []
    for verts,ctype in layout['corners']:
        spaces.append((verts, 'K', 'corner'))
    for verts,ctype in layout.get('inner_corners', []):
        spaces.append((verts, 'K', 'corner'))
    for verts,utype in layout['units']:
        spaces.append((verts, UNIT_CHAR.get(utype,'?'), utype))
    for verts,utype in layout.get('inner_units', []):
        spaces.append((verts, UNIT_CHAR.get(utype,'?'), utype))

    rect = layout['rect']
    corr = layout['corr_rect']
    core = layout['core_rect']

    grid = []
    unit_cells = {}
    corridor_cells = 0
    core_cells = 0
    courtyard_cells = 0
    gap_cells = 0
    overlap_cells = 0
    outside_cells = 0

    unit_corridor_adj = {}

    for r in range(rows):
        row = []
        y = y1 - r * cell_size
        for c in range(cols):
            x = x0 + c * cell_size

            in_rect = point_in_poly((x,y), rect)
            in_boundary = point_in_poly((x,y), bd)

            if not in_rect and not in_boundary:
                row.append(' ')
                outside_cells += 1
                continue

            if not in_rect and in_boundary:
                row.append('~')
                continue

            in_core = core and point_in_poly((x,y), core)
            in_corr = corr and point_in_poly((x,y), corr) and not in_core

            # BOH/Circ checked first — they overlay units
            if boh and point_in_poly((x,y), boh):
                row.append('B')
                continue
            if circ and point_in_poly((x,y), circ):
                row.append('C')
                continue

            claims = []
            for si,(verts,ch,label) in enumerate(spaces):
                if point_in_poly((x,y), verts):
                    claims.append((si, ch))

            if len(claims) > 1:
                corner_claims = [c for c in claims if c[1]=='K']
                if corner_claims:
                    si,ch = corner_claims[0]
                    row.append(ch)
                    unit_cells[ch] = unit_cells.get(ch,0)+1
                    if si not in unit_corridor_adj: unit_corridor_adj[si]=False
                    for dx2,dy2 in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1)]:
                        nx2,ny2=x+dx2*cell_size,y+dy2*cell_size
                        if corr and point_in_poly((nx2,ny2),corr) and not (core and point_in_poly((nx2,ny2),core)):
                            unit_corridor_adj[si]=True
                        if layout_mode=='courtyard' and core and point_in_poly((nx2,ny2),core):
                            if not (courtyard and point_in_poly((nx2,ny2),courtyard)):
                                unit_corridor_adj[si]=True
                else:
                    row.append('!')
                    overlap_cells += 1
            elif len(claims) == 1:
                si, ch = claims[0]
                row.append(ch)
                unit_cells[ch] = unit_cells.get(ch,0)+1
                if si not in unit_corridor_adj:
                    unit_corridor_adj[si] = False
                for dx2,dy2 in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1)]:
                    nx2,ny2 = x+dx2*cell_size, y+dy2*cell_size
                    if corr and point_in_poly((nx2,ny2),corr) and not (core and point_in_poly((nx2,ny2),core)):
                        unit_corridor_adj[si] = True
                    if layout_mode=='courtyard' and core and point_in_poly((nx2,ny2),core):
                        if not (courtyard and point_in_poly((nx2,ny2),courtyard)):
                            unit_corridor_adj[si] = True
            elif courtyard and point_in_poly((x,y), courtyard):
                row.append('O')
                courtyard_cells += 1
            elif boh and point_in_poly((x,y), boh):
                row.append('B')
            elif circ and point_in_poly((x,y), circ):
                row.append('C')
            elif in_core:
                if layout_mode == 'courtyard':
                    row.append('.')  # inner corridor
                    corridor_cells += 1
                else:
                    row.append('#')
                    core_cells += 1
            elif in_corr:
                row.append('.')
                corridor_cells += 1
            else:
                row.append('?')
                gap_cells += 1

        grid.append(''.join(row))

    # Diagnostics
    diag = []
    diag.append(f"Grid: {cols}x{rows} @ {cell_size}ft/cell | Mode: {layout_mode}")
    diag.append(f"Unit cells: {unit_cells}")
    diag.append(f"Corridor cells: {corridor_cells}, Core cells: {core_cells}")
    if courtyard_cells: diag.append(f"Courtyard cells: {courtyard_cells}")
    diag.append(f"Gaps: {gap_cells}, Overlaps: {overlap_cells}")

    no_access = []
    for si,(verts,ch,label) in enumerate(spaces):
        if si in unit_corridor_adj and not unit_corridor_adj[si]:
            no_access.append(f"  {label} unit #{si} ({ch}) — NO corridor access!")
    if no_access:
        diag.append("ACCESS ISSUES:")
        diag.extend(no_access)
    else:
        diag.append("All units have corridor access ✓")

    return grid, diag


# ── PNG renderer ──────────────────────────────────────────────
def render_png(layout, ax):
    bd=layout['boundary'];rect=layout['rect']
    corr=layout['corr_rect'];core=layout['core_rect']
    courtyard=layout.get('courtyard_rect')
    boh=layout.get('boh_room')
    circ=layout.get('circ_room')
    layout_mode=layout.get('layout_mode','basic')

    ax.add_patch(MplPoly(bd,closed=True,fc='#fafafa',ec='#ccc',lw=0.8,zorder=-1))
    if corr: ax.add_patch(MplPoly(corr,closed=True,fc='#f0f0f0',ec='none',zorder=0))
    if core:
        if layout_mode == 'courtyard':
            ax.add_patch(MplPoly(core,closed=True,fc='#f0f0f0',ec='#999',lw=0.5,zorder=1))
        else:
            ax.add_patch(MplPoly(core,closed=True,fc='#d5d5d5',ec='#999',lw=0.5,zorder=1))
            cx,cy=centroid(core)
            ax.text(cx,cy,'CORE',ha='center',va='center',fontsize=7,fontweight='bold',color='#555',zorder=6)

    if courtyard:
        ax.add_patch(MplPoly(courtyard,closed=True,fc='#e8f5e9',ec='#4caf50',lw=1,zorder=2))
        cx,cy=centroid(courtyard)
        ax.text(cx,cy,'YARD',ha='center',va='center',fontsize=6,fontweight='bold',color='#2e7d32',zorder=6)

    if boh:
        ax.add_patch(MplPoly(boh,closed=True,fc='#ffccbc',ec='#333',lw=0.8,zorder=8))
        cx,cy=centroid(boh)
        ax.text(cx,cy,'BOH',ha='center',va='center',fontsize=5,fontweight='bold',color='#bf360c',zorder=9)
    if circ:
        ax.add_patch(MplPoly(circ,closed=True,fc='#d1c4e9',ec='#333',lw=0.8,zorder=8))
        cx,cy=centroid(circ)
        ax.text(cx,cy,'CIR',ha='center',va='center',fontsize=5,fontweight='bold',color='#4527a0',zorder=9)

    # Outer units
    for verts,ctype in layout['corners']:
        ax.add_patch(MplPoly(verts,closed=True,fc=COLORS['corner'],ec='#333',lw=0.5,zorder=2))
        ux=sum(v[0] for v in verts)/len(verts);uy=sum(v[1] for v in verts)/len(verts)
        ax.text(ux,uy,'CR',ha='center',va='center',fontsize=4,color='#888',zorder=3)
    for verts,utype in layout['units']:
        ax.add_patch(MplPoly(verts,closed=True,fc=COLORS.get(utype,'#eee'),ec='#333',lw=0.5,zorder=2))
        ux=sum(v[0] for v in verts)/len(verts);uy=sum(v[1] for v in verts)/len(verts)
        ax.text(ux,uy,LABELS.get(utype,'?'),ha='center',va='center',fontsize=5,color='#555',zorder=3)

    # Inner units (courtyard mode)
    for verts,ctype in layout.get('inner_corners', []):
        ax.add_patch(MplPoly(verts,closed=True,fc=COLORS['corner'],ec='#333',lw=0.5,zorder=4))
        ux=sum(v[0] for v in verts)/len(verts);uy=sum(v[1] for v in verts)/len(verts)
        ax.text(ux,uy,'CR',ha='center',va='center',fontsize=4,color='#888',zorder=5)
    for verts,utype in layout.get('inner_units', []):
        ax.add_patch(MplPoly(verts,closed=True,fc=COLORS.get(utype,'#eee'),ec='#333',lw=0.5,zorder=4))
        ux=sum(v[0] for v in verts)/len(verts);uy=sum(v[1] for v in verts)/len(verts)
        ax.text(ux,uy,LABELS.get(utype,'?'),ha='center',va='center',fontsize=5,color='#555',zorder=5)

    rx=[p[0] for p in rect]+[rect[0][0]];ry=[p[1] for p in rect]+[rect[0][1]]
    ax.plot(rx,ry,'k-',lw=2,zorder=5)
    if corr:
        cx2=[p[0] for p in corr]+[corr[0][0]];cy2=[p[1] for p in corr]+[corr[0][1]]
        ax.plot(cx2,cy2,color='#aaa',ls='--',lw=0.4,zorder=4)
    ax.set_aspect('equal');ax.axis('off')
    allx=[p[0] for p in bd];ally=[p[1] for p in bd];pad=20
    ax.set_xlim(min(allx)-pad,max(allx)+pad);ax.set_ylim(min(ally)-pad,max(ally)+pad)
    nu=len(layout['units'])+len(layout.get('inner_units',[]))
    nc=len(layout['corners'])+len(layout.get('inner_corners',[]))
    mode=layout.get('layout_mode','basic')
    ax.set_title(f"{layout['pid'].upper()} — {mode}\n{nu}+{nc}cr | {layout['rw']:.0f}x{layout['rh']:.0f} | d={layout['depth']:.0f}",fontsize=8,fontweight='bold')


# ── SolverResult JSON output ─────────────────────────────────
TYPE_NAMES = {'studio':'Studio','1br':'1BR','2br':'2BR','3br':'3BR','corner':'Corner'}

def _make_space(sid, stype, name, floor_idx, verts, is_vert=False):
    area = poly_area(verts)
    return {
        'id':sid,'type':stype,'name':name,'floor_index':floor_idx,
        'geometry':{'vertices':[[round(v[0],2),round(v[1],2)] for v in verts]},
        'target_area_sf':round(area,1),'actual_area_sf':round(area,1),
        'membership':1,'area_deviation':'+0.0%','is_vertical':is_vert,
    }

def _make_rect_space(sid, stype, name, floor_idx, cx, cy, w, h, rot_deg=0, is_vert=False):
    area = w*h
    return {
        'id':sid,'type':stype,'name':name,'floor_index':floor_idx,
        'geometry':{'x':round(cx,2),'y':round(cy,2),'width':round(w,2),'height':round(h,2),'rotation':round(rot_deg,2)},
        'target_area_sf':round(area,1),'actual_area_sf':round(area,1),
        'membership':1,'area_deviation':'+0.0%','is_vertical':is_vert,
    }

def _local_to_global(rcx, rcy, ca, sa, lx, ly):
    return (rcx + lx*ca - ly*sa, rcy + lx*sa + ly*ca)

def _parking_spaces(data, layout, floor_idx):
    """Parking bays + support rooms."""
    spaces=[]
    rcx,rcy,rangle=layout['rcx'],layout['rcy'],layout['rangle']
    ca,sa=math.cos(rangle),math.sin(rangle)
    rot=math.degrees(rangle)
    hw,hh=layout['rw']/2,layout['rh']/2

    # Parking bays: 5 stalls wide (45ft) × 2 deep (36ft)
    park=data.get('parking',{})
    total_stalls=park.get('underground_stalls',45)
    BAY_W,BAY_H,STALLS_PER=45,36,10
    n_bays=max(1,math.ceil(total_stalls/STALLS_PER))
    aisle_w=min(2*hh-30,80)

    placed=0;bc=0
    for row_sign in [1,-1]:
        row_y=row_sign*(aisle_w/2+BAY_H/2)
        x=-hw+10+BAY_W/2
        while x<hw-10 and placed<total_stalls:
            bc+=1
            stalls_here=min(STALLS_PER,total_stalls-placed)
            gx,gy=_local_to_global(rcx,rcy,ca,sa,x,row_y)
            spaces.append(_make_rect_space(f'parking_bay_{bc}_f{floor_idx}','PARKING',
                          f'P{placed+1}-{placed+stalls_here}',floor_idx,gx,gy,BAY_W,BAY_H,rot))
            placed+=stalls_here; x+=BAY_W+2
        if placed>=total_stalls: break

    # Support rooms — fit within the rect, wrapping rows if needed
    support=[('storage','SUPPORT','Storage',15,12),
             ('trash_recycle','SUPPORT','Trash/Recycle',12,10),
             ('fan_room','SUPPORT','Fan Room',12,10),
             ('fire_pump','SUPPORT','Fire Pump',10,10),
             ('mpoe','SUPPORT','MPOE',10,8)]
    margin=5
    sx=-hw+margin+support[0][3]/2
    sy=-hh+margin+support[0][4]/2
    for sid,stype,name,sw,sh in support:
        if sx+sw/2>hw-margin:  # wrap to next row
            sx=-hw+margin+sw/2
            sy+=max(s[4] for s in support)+2
        gx,gy=_local_to_global(rcx,rcy,ca,sa,sx,sy)
        spaces.append(_make_rect_space(f'{sid}_f{floor_idx}',stype,name,floor_idx,gx,gy,sw,sh,rot))
        sx+=sw+2
    return spaces

def _ground_spaces(data, layout, floor_idx):
    """Ground floor: lobby, leasing, amenities, support."""
    spaces=[]
    rcx,rcy,rangle=layout['rcx'],layout['rcy'],layout['rangle']
    ca,sa=math.cos(rangle),math.sin(rangle)
    rot=math.degrees(rangle)
    hw,hh=layout['rw']/2,layout['rh']/2
    s=min(1,min(hw,hh)/80)  # scale for small buildings

    rooms=[
        ('lobby','CIRCULATION','Lobby',       30*s,20*s,  0,       hh*0.4),
        ('leasing','SUPPORT','Leasing',       18*s,15*s,  hw*0.4,  hh*0.3),
        ('mail','SUPPORT','Mail/Package',     15*s,12*s, -hw*0.4,  hh*0.3),
        ('lounge','AMENITY','Lounge',         30*s,25*s, -hw*0.35, 0),
        ('fitness','AMENITY','Fitness',       25*s,20*s, -hw*0.25,-hh*0.35),
        ('restroom_m','SUPPORT','Restroom M', 12*s,10*s,  hw*0.4, -hh*0.2),
        ('restroom_f','SUPPORT','Restroom F', 12*s,10*s,  hw*0.4, -hh*0.35),
        ('trash','SUPPORT','Trash',           10*s,8*s,   hw*0.35, 0),
        ('bike','SUPPORT','Bike Storage',     20*s,18*s,  hw*0.25,-hh*0.45),
    ]
    for sid,stype,name,rw2,rh2,lx,ly in rooms:
        gx,gy=_local_to_global(rcx,rcy,ca,sa,lx,ly)
        spaces.append(_make_rect_space(f'{sid}_f{floor_idx}',stype,name,floor_idx,gx,gy,rw2,rh2,rot))
    return spaces

def _residential_spaces(data, layout, floor_idx):
    spaces=[];uid=0
    def add(verts,utype,pfx):
        nonlocal uid; uid+=1
        spaces.append(_make_space(f'{pfx}_{utype}_{uid}_f{floor_idx}','DWELLING_UNIT',
                                  f'{TYPE_NAMES.get(utype,utype)} {uid}',floor_idx,verts))
    # Skip corners — only regular units
    for v,t in layout['units']: add(v,t,'unit')
    for v,t in layout.get('inner_units',[]): add(v,t,'iunit')

    if layout['core_rect'] and layout.get('layout_mode')!='courtyard':
        spaces.append(_make_space(f'core_f{floor_idx}','CORE','Core',floor_idx,layout['core_rect']))
    if layout['boh_room']:
        spaces.append(_make_space(f'boh_f{floor_idx}','SUPPORT','BOH',floor_idx,layout['boh_room']))
    if layout['circ_room']:
        spaces.append(_make_space(f'circ_f{floor_idx}','CIRCULATION','Circ',floor_idx,layout['circ_room']))
    if layout.get('courtyard_rect'):
        spaces.append(_make_space(f'courtyard_f{floor_idx}','AMENITY','Courtyard',floor_idx,layout['courtyard_rect']))
    return spaces

def write_solver_json(data, layout, output_path):
    pid=data['project_id']
    fp_area=data['building']['floor_plate_sf']
    sd=data['building']['story_distribution']
    n_dwell=max(1,round(sd.get('dwelling',1)))
    n_mixed=max(1,round(sd.get('mixed_use',0)))
    n_park=max(0,round(sd.get('parking',0)))

    boundary=[[round(p[0],2),round(p[1],2)] for p in layout['boundary']]
    floors=[]

    for i in range(n_park):
        fi=-(n_park-i)
        floors.append({'floor_index':fi,'floor_type':'PARKING','boundary':boundary,
                       'area_sf':fp_area,'spaces':_parking_spaces(data,layout,fi)})
    for i in range(n_mixed):
        ft='GROUND' if i==0 else 'RESIDENTIAL_TYPICAL'
        floors.append({'floor_index':i,'floor_type':ft,'boundary':boundary,
                       'area_sf':fp_area,'spaces':_ground_spaces(data,layout,i)})
    for i in range(n_dwell):
        fi=n_mixed+i
        floors.append({'floor_index':fi,'floor_type':'RESIDENTIAL_TYPICAL','boundary':boundary,
                       'area_sf':fp_area,'spaces':_residential_spaces(data,layout,fi)})

    total=sum(len(f['spaces']) for f in floors)
    result={
        'success':True,'obstruction':0,'iterations':1,
        'message':f'Band layout v7 — {pid}','violations':[],
        'metrics':{'placement_rate':'100%','avg_membership':'1.0',
                   'total_spaces':total,'placed_spaces':total},
        'building':{'floors':floors,'stalks':[],
                    'metrics':{'total_floors':len(floors),'total_spaces':total,'cohomology_obstruction':0}},
        'layout_metadata':{
            'rect_corners':[[round(p[0],2),round(p[1],2)] for p in layout['rect']],
            'rangle_deg':round(math.degrees(layout['rangle']),4),
            'rw':round(layout['rw'],2),'rh':round(layout['rh'],2),
            'depth':round(layout['depth'],2),'corr_w':layout['corr_w'],'cs':round(layout['cs'],2),
            'layout_mode':layout.get('layout_mode','basic'),
        },
    }
    with open(output_path,'w') as f: json.dump(result,f,indent=2)
    print(f"  JSON → {output_path}")


# ── Main ──────────────────────────────────────────────────────
if __name__ == '__main__':
    import sys
    data_dir = Path(__file__).parent / 'web-viewer' / 'public' / 'data'
    out_dir = Path(__file__).parent / 'web-viewer' / 'output'
    out_dir.mkdir(exist_ok=True)
    do_json = '--json' in sys.argv

    fig,axes = plt.subplots(2,2,figsize=(14,14))

    for idx, pid in enumerate(['p1','p4','p7','p9']):
        with open(data_dir/f'{pid}_building.json') as f:
            data = json.load(f)

        print(f"\n{'='*60}")
        print(f"  {pid.upper()}: {data['project_name']}")
        print(f"{'='*60}")

        layout = compute_layout(data)
        print(f"  Rect: {layout['rw']:.0f}x{layout['rh']:.0f} ({layout['rw']*layout['rh']/layout['fp_area']*100:.0f}%)")
        print(f"  Depth: {layout['depth']:.0f}ft (avg from data: {layout['avg_depth']:.0f}ft)")
        print(f"  Core: {layout['core_w']:.0f}x{layout['core_h']:.0f} | Mode: {layout['layout_mode']}")
        print(f"  Outer: {len(layout['units'])} units + {len(layout['corners'])} corners")
        if layout['layout_mode'] == 'courtyard':
            print(f"  Inner: {len(layout['inner_units'])} units + {len(layout['inner_corners'])} corners (depth={layout['inner_depth']:.0f}ft)")

        if do_json:
            write_solver_json(data, layout, data_dir/f'{pid}_output.json')

        grid, diag = rasterize(layout, cell_size=3)
        if not do_json:
            print()
            for line in grid:
                print(f"  {line}")
        print()
        for d in diag:
            print(f"  {d}")

        render_png(layout, axes.flat[idx])

    fig.tight_layout(pad=2)
    out = out_dir/'band_layout_all.png'
    fig.savefig(out,dpi=100,bbox_inches='tight',facecolor='white')
    plt.close(fig)
    print(f"\nPNG: {out}")
