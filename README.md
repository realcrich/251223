# GLOQ Massing Solver

An automated building floor-plan generator for multifamily residential projects. Given a parcel shape and a building program (unit types, counts, parking, etc.), it produces floor-by-floor space layouts -- parking, ground floor amenities, and stacked residential levels -- viewable in an interactive web tool.

**Live demo:** https://gloq-floorplan-viewer.web.app

---

## How it works (the 30-second version)

```
p*_building.json          band_layout.py             p*_output.json
 (building program)  ──►  (Python geometry engine)  ──►  (placed floor plans)
                                                              │
                                                              ▼
                                                        web-viewer/
                                                     (React app renders
                                                      interactive SVG)
```

1. **Building JSON** describes the project: lot area, floor plate SF, number of stories, dwelling unit types/counts, parking requirements, addresses.
2. **`band_layout.py`** reads those specs, computes a parcel polygon (from hardcoded GeoJSON coordinates), insets for setbacks, and runs a layout algorithm that places units around the perimeter with a central core.
3. **Output JSON** contains every floor with every space (position, size, type). The web viewer loads this and renders interactive floor plans.

---

## Repository structure

```
gloq_massing_solver/
├── band_layout.py              # Python layout engine (the solver)
├── web-viewer/                 # React/TypeScript interactive viewer
│   ├── src/
│   │   ├── App.tsx             # Main app - wires everything together
│   │   ├── components/
│   │   │   ├── floorplan/      # SVG floor plan renderer + editor
│   │   │   ├── map/            # Leaflet map overlay
│   │   │   ├── panels/         # Side panels, metrics, legend
│   │   │   ├── toolbar/        # Edit mode toolbar
│   │   │   └── verification/   # Constraint checking
│   │   ├── hooks/              # React hooks (data loading, editing, navigation)
│   │   ├── utils/
│   │   │   ├── generateFromExtracted.ts  # TypeScript layout (legacy path)
│   │   │   └── geometry.ts     # Coordinate transforms
│   │   └── types/
│   │       └── solverOutput.ts # TypeScript interfaces for the JSON schema
│   ├── scripts/
│   │   ├── regenerate-outputs.ts   # Orchestrates: band_layout.py → validate → deploy
│   │   └── architect-agent.ts      # Overlap detection & floor analysis
│   ├── public/data/            # Input & output JSON files
│   │   ├── p1_building.json    # Building specs for project P1
│   │   ├── p1_output.json      # Generated floor plans for P1
│   │   └── ...                 # P4, P7, P9
│   └── package.json
├── data/sample_pdfs/           # Original PDF sources
└── .venv/                      # Python virtualenv (numpy, matplotlib)
```

---

## The layout algorithm

### Core idea

Every residential floor follows the same pattern: units pack around the **perimeter** of the floor plate (so every unit gets exterior wall = windows), with vertical circulation (elevators + stairs) and support rooms in a **central core**. A corridor ring separates units from core.

### Floor types

| Floor type | What goes on it |
|---|---|
| **Parking (B-levels)** | Drive aisle down the center, parking stalls on both sides, support rooms (MPOE, trash, fire pump, domestic water, fan room, storage) along one edge |
| **Ground** | Lobby, leasing office, mail room, fitness center, lounge, restrooms, bike storage, optional ground-floor units |
| **Residential (typical)** | Dwelling units packed around all 4 perimeter sides, central core with stairs/elevators/support, corridor ring connecting them |

### Parcel geometry

Real parcel shapes are used (from GeoJSON coordinates for each project). The algorithm:
1. Converts lat/lng to feet
2. Scales the polygon to match the building's floor plate area
3. Applies a 3-foot inset for setbacks
4. For irregular parcels (>4 sides): uses a **radial slice** algorithm -- rays from boundary to core create trapezoidal units
5. For rectangular parcels (4 sides): uses **perimeter packing** -- rectangular units placed N → E → S → W

### Unit sizing

Units are intentionally narrow to maximize count:

| Type | Frontage width |
|---|---|
| Studio | 12-16 ft |
| 1 BR | 14-20 ft |
| 2 BR | 18-28 ft |
| 3 BR | 22-34 ft |

Depth is computed dynamically: `depth = boundary_edge → corridor_ring`

### Collision detection

All spaces are placed through a collision detection system:
- Each placed space registers a bounding box
- New spaces check against all existing boxes before placement
- If overlap is detected, the algorithm tries 8 offset positions
- Spaces that can't be placed without overlap are skipped

### Core sizing

The central core (stairs + elevators + support rooms) scales dynamically with floor plate size:
- Large plates (150'+ wide): 45 ft core
- Medium (100-150'): ~35 ft core
- Small (<100'): 25 ft core (minimum for 2 stairs + 3 elevators)

---

## The coordinate system

Everything uses **center-origin** coordinates:
- `(0, 0)` is the center of the floor plate
- Boundary runs from `(-halfSide, -halfSide)` to `(halfSide, halfSide)` for rectangular plates
- Y is up (mathematical convention), but SVG rendering flips it
- All dimensions are in **feet**

The viewer transforms world coordinates → SVG pixels via `createSvgTransform()`.

---

## Data schema (the JSON format)

### Building input (`p*_building.json`)

```jsonc
{
  "building": {
    "stories_above_grade": 7,
    "stories_below_grade": 1,
    "floor_plate_sf": 19310,
    "address": "5240 North Lankershim Boulevard, North Hollywood, CA 91601"
  },
  "dwelling_units": [
    { "type": "studio", "name": "Studio + 1 Bath", "count": 50, "area_sf": 455, "width_ft": 16, "depth_ft": 28 },
    { "type": "1br",    "name": "1 Bed + 1 Bath",  "count": 40, "area_sf": 560, "width_ft": 20, "depth_ft": 28 }
    // ...
  ],
  "circulation": { "elevators": { "passenger": { "count": 2 } }, "stairs": { "count": 2 } },
  "parking": { "underground_stalls": 45 }
}
```

### Solver output (`p*_output.json`)

```jsonc
{
  "success": true,
  "building": {
    "floors": [
      {
        "floor_index": 1,        // -1=B1, 0=ground, 1+=residential
        "floor_type": "RESIDENTIAL_TYPICAL",
        "boundary": [[-69, -69], [69, -69], [69, 69], [-69, 69]],
        "area_sf": 19310,
        "spaces": [
          {
            "id": "unit_studio_0_f1",
            "type": "DWELLING_UNIT",      // or CIRCULATION, SUPPORT, PARKING, AMENITY, RETAIL
            "name": "Studio + 1 Bath",
            "geometry": { "x": -60, "y": -50, "width": 12, "height": 25, "rotation": 0 },
            // or polygon: { "vertices": [[x1,y1], [x2,y2], ...] }
            "target_area_sf": 455,
            "actual_area_sf": 300,
            "membership": 0.85
          }
          // ... more spaces
        ]
      }
      // ... more floors
    ],
    "stalks": [ /* vertical elements spanning floors */ ]
  }
}
```

Space geometry is either **rectangular** (`x, y, width, height`) or **polygonal** (`vertices` array). The viewer handles both via type guards (`isRectGeometry` / `isPolygonGeometry`).

---

## Running locally

### Prerequisites
- Node.js 18+
- Python 3.10+ (with a virtualenv at `.venv/`)

### Quick start

```bash
# 1. Install web viewer dependencies
cd web-viewer
npm install

# 2. Start dev server
npm run dev
# Opens at http://localhost:5173

# 3. (Optional) Regenerate floor plans from building specs
npx tsx scripts/regenerate-outputs.ts
# This runs band_layout.py → writes p*_output.json → validates overlaps

# 4. Build for production
npm run build

# 5. Deploy to Firebase
firebase deploy --only hosting
```

**Order matters for deployment:** regenerate → build → deploy. The Vite build copies `public/` into `dist/` at build time, so regenerated outputs must exist before building.

### Running just the Python solver

```bash
.venv/bin/python band_layout.py          # ASCII grid + matplotlib PNG
.venv/bin/python band_layout.py --json   # Write output JSONs to web-viewer/public/data/
```

---

## The web viewer

### What you see

- **Floor plan canvas**: SVG rendering of spaces with color-coded types, labels, zoom/pan
- **Floor navigation**: Click through B-levels, ground, and residential floors
- **Edit modes**: Select spaces, drag vertices, move entire polygons
- **Map view**: Leaflet overlay showing parcel + spaces in geographic context

### Key React hooks

| Hook | What it does |
|---|---|
| `useSolverData` | Fetches + parses the output JSON, manages project selection |
| `useFloorNavigation` | Tracks current floor index, next/prev navigation |
| `usePolygonEditor` | Vertex editing with undo/redo history |
| `useSpaceSelection` | Which space is currently selected |
| `useFloorMetrics` | Computes efficiency, area totals, violations for current floor |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `V` | Select mode |
| `M` | Move space mode |
| `E` | Edit vertices mode |
| `Arrow Up/Down` | Navigate floors |
| `Escape` | Deselect |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |

---

## Projects

Four real LA-area multifamily projects are included:

| ID | Address | Floor plate | Stories | Units |
|---|---|---|---|---|
| P1 | 5240 N Lankershim Blvd, North Hollywood | 139' x 139' | 8 | 116 |
| P4 | 1723 Cloverfield Blvd, Santa Monica | 155' x 155' | 10 | 348 |
| P7 | 6464 Canoga Ave, Woodland Hills | 172' x 172' | 10 | 429 |
| P9 | 350 S Hill St, Los Angeles | 99' x 99' | 34 | 427 |

---

## Architecture notes for developers

### Two layout engines

There are currently two layout engines:

1. **`band_layout.py`** (Python) -- the primary engine. Handles irregular parcel shapes, radial slicing, courtyard/inner-ring layouts. Called by `regenerate-outputs.ts`.
2. **`generateFromExtracted.ts`** (TypeScript) -- legacy engine for rectangular floor plates. Uses perimeter packing with collision detection. Still used as a fallback when building data is loaded directly in the browser.

### Space type taxonomy

| Type | Description | Where |
|---|---|---|
| `DWELLING_UNIT` | Apartments (studio, 1BR, 2BR, 3BR) | Residential floors |
| `CIRCULATION` | Corridors, lobby, drive aisles, elevators, stairs | All floors |
| `SUPPORT` | BOH rooms: trash, mech, elec, MPOE, fire pump, storage | All floors |
| `PARKING` | Individual parking stalls | B-levels |
| `AMENITY` | Fitness, lounge | Ground floor |
| `RETAIL` | Ground floor retail | Ground floor |

### Important conventions

- **Space IDs**: `{type}_{subtype}_{index}_f{floor}` (e.g., `unit_studio_5_f3`)
- **Rotations**: 0, 90, 180, 270 only (90-degree snapping)
- **Membership score**: 0.0-1.0, how well actual area matches target (fuzzy logic)
- This is a **massing study**, not construction documents. Area deviations are expected.

---

## Tech stack

| Layer | Technology |
|---|---|
| Layout engine | Python 3 (numpy, matplotlib) |
| Web viewer | React 19, TypeScript, Vite |
| Maps | Leaflet + react-leaflet |
| Hosting | Firebase |
| Styling | CSS variables, dark theme |

---

Built for GLOQ | Layout engine + viewer by Claude Code (Anthropic)
