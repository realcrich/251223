/**
 * Generate solver-like result from extracted PDF data
 * Uses actual unit dimensions (width_ft, depth_ft) for accurate floor plans
 *
 * IMPORTANT: Uses CENTER-ORIGIN coordinate system like the default sample data
 * Boundary runs from (-halfSide, -halfSide) to (halfSide, halfSide)
 * Origin (0,0) is at the center of the floor plate
 */

import { SolverResult, FloorData, SpaceData, PolygonGeometry } from '../types/solverOutput';
import { ExtractedBuildingData } from '../components/data/PdfUploader';
import {
  generateFloorBoundary,
  lineLineIntersection,
  type Polygon,
  type Point,
} from './parcelGeometry';
import {
  pointInPolygon,
  getBoundingBox,
  calculatePolygonArea,
  computePerimeter,
  rayBoundaryIntersection,
  interiorAngle,
} from './polygon';

// ============================================
// COLLISION DETECTION HELPERS
// ============================================

interface BoundingBox {
  x: number;      // center x
  y: number;      // center y
  width: number;
  height: number;
}

/**
 * Check if two bounding boxes overlap
 */
function spacesOverlap(a: BoundingBox, b: BoundingBox, buffer: number = 0.5): boolean {
  const aLeft = a.x - a.width / 2 - buffer;
  const aRight = a.x + a.width / 2 + buffer;
  const aTop = a.y - a.height / 2 - buffer;
  const aBottom = a.y + a.height / 2 + buffer;

  const bLeft = b.x - b.width / 2;
  const bRight = b.x + b.width / 2;
  const bTop = b.y - b.height / 2;
  const bBottom = b.y + b.height / 2;

  return !(aRight < bLeft || aLeft > bRight || aBottom < bTop || aTop > bBottom);
}

/**
 * Check if a space overlaps with any existing space
 */
function hasOverlap(newSpace: BoundingBox, existingSpaces: BoundingBox[], buffer: number = 0.5): boolean {
  return existingSpaces.some(existing => spacesOverlap(newSpace, existing, buffer));
}

/**
 * Check if all 4 corners of a rectangle lie inside a polygon boundary.
 */
function rectInsidePolygon(rect: BoundingBox, polygon: Polygon): boolean {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const corners: Point[] = [
    [rect.x - hw, rect.y - hh],
    [rect.x + hw, rect.y - hh],
    [rect.x + hw, rect.y + hh],
    [rect.x - hw, rect.y + hh],
  ];
  return corners.every(c => pointInPolygon(c, polygon));
}

/**
 * Find a non-overlapping position by trying offsets.
 * When a boundaryPolygon is provided, does a grid scan across the polygon BB
 * to find a position where the entire rect fits inside the polygon.
 */
function findNonOverlappingPosition(
  space: BoundingBox,
  existingSpaces: BoundingBox[],
  boundary: { minX: number; maxX: number; minY: number; maxY: number },
  boundaryPolygon?: Polygon
): BoundingBox | null {
  const fitsInBounds = (c: BoundingBox): boolean => {
    if (boundaryPolygon) return rectInsidePolygon(c, boundaryPolygon);
    return c.x - c.width / 2 >= boundary.minX &&
           c.x + c.width / 2 <= boundary.maxX &&
           c.y - c.height / 2 >= boundary.minY &&
           c.y + c.height / 2 <= boundary.maxY;
  };

  // Try original position first
  if (!hasOverlap(space, existingSpaces) && fitsInBounds(space)) return space;

  // For polygon boundaries, do a grid scan across the polygon BB
  if (boundaryPolygon) {
    const bb = getBoundingBox(boundaryPolygon);
    const stepX = Math.max(space.width / 2, 4);
    const stepY = Math.max(space.height / 2, 4);
    let bestCandidate: BoundingBox | null = null;
    let bestDist = Infinity;

    for (let gx = bb.minX + space.width / 2; gx <= bb.maxX - space.width / 2; gx += stepX) {
      for (let gy = bb.minY + space.height / 2; gy <= bb.maxY - space.height / 2; gy += stepY) {
        const candidate = { ...space, x: gx, y: gy };
        if (fitsInBounds(candidate) && !hasOverlap(candidate, existingSpaces)) {
          // Prefer candidate closest to the original requested position
          const dist = Math.hypot(gx - space.x, gy - space.y);
          if (dist < bestDist) {
            bestDist = dist;
            bestCandidate = candidate;
          }
        }
      }
    }
    return bestCandidate;
  }

  // For square boundaries, try offset positions
  const offsets = [
    { dx: space.width + 2, dy: 0 },
    { dx: -space.width - 2, dy: 0 },
    { dx: 0, dy: space.height + 2 },
    { dx: 0, dy: -space.height - 2 },
    { dx: space.width + 2, dy: space.height + 2 },
    { dx: -space.width - 2, dy: -space.height - 2 },
    { dx: space.width + 2, dy: -space.height - 2 },
    { dx: -space.width - 2, dy: space.height + 2 },
  ];

  for (const offset of offsets) {
    const candidate = { ...space, x: space.x + offset.dx, y: space.y + offset.dy };
    if (!hasOverlap(candidate, existingSpaces) && fitsInBounds(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Safely place a space, checking for collisions
 */
function safelyPlaceSpace(
  spaces: SpaceData[],
  placedBounds: BoundingBox[],
  id: string,
  type: string,
  name: string,
  floorIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
  isVertical: boolean,
  boundary: { minX: number; maxX: number; minY: number; maxY: number },
  boundaryPolygon?: Polygon
): void {
  const newBounds: BoundingBox = { x, y, width, height };
  const safeBounds = findNonOverlappingPosition(newBounds, placedBounds, boundary, boundaryPolygon);

  if (safeBounds) {
    placedBounds.push(safeBounds);
    spaces.push(createSpace(id, type, name, floorIndex, safeBounds.x, safeBounds.y, safeBounds.width, safeBounds.height, isVertical));
  }
}

interface LegacyExtractedData {
  properties?: {
    area_sf?: number;
    apn?: string;
    total_units_proposed?: number;
    floor_area_ratio?: number;
    [key: string]: string | number | boolean | undefined;
  };
  constraints?: {
    zoning?: string;
    maximum_height_feet?: number;
    setbacks?: { front_feet?: number; rear_feet?: number; side_feet?: number };
    parking_requirement_per_unit?: number;
    [key: string]: string | number | boolean | { front_feet?: number; rear_feet?: number; side_feet?: number } | undefined;
  };
  units?: Array<{ type: string; count: number; area_sf: number }>;
  metadata?: Record<string, unknown>;
  building_data?: ExtractedBuildingData;
}

export function generateSolverResultFromExtracted(extracted: LegacyExtractedData): SolverResult {
  // If we have the new structured building data, use it for accurate floor plans
  if (extracted.building_data) {
    return generateFromBuildingData(extracted.building_data);
  }

  // Fallback to legacy generation
  return generateFromLegacyData(extracted);
}

/**
 * Generate floor plans using actual unit dimensions from extraction
 * Uses CENTER-ORIGIN coordinate system for proper rendering
 * Supports irregular parcel shapes via fill-and-cut algorithm
 */
function generateFromBuildingData(data: ExtractedBuildingData): SolverResult {
  const building = data.building;
  const units = data.dwelling_units || [];
  const circulation = data.circulation;
  const parking = data.parking;

  const floorPlateArea = building.floor_plate_sf || 19000;

  // Generate boundary from real parcel shape (or fall back to square)
  const { polygon: boundaryPolygon, isIrregular } = generateFloorBoundary(
    data.project_id,
    floorPlateArea,
    3 // 3' inset for setback
  );

  // Derive halfSide for parking/ground floor placement.
  // For irregular polygons, use the short dimension of the bounding box
  // to prevent rooms from overflowing outside the polygon.
  const bb = getBoundingBox(boundaryPolygon);
  const halfSide = isIrregular
    ? Math.min(bb.width, bb.height) / 2
    : Math.max(bb.width, bb.height) / 2;

  const numFloorsAbove = building.stories_above_grade || 7;
  const numFloorsBelow = building.stories_below_grade || 1;
  const totalFloors = building.stories_total || numFloorsAbove + numFloorsBelow;

  // Calculate units per floor for residential floors
  const totalUnits = units.reduce((sum, u) => sum + u.count, 0);
  const residentialFloors = numFloorsAbove - 1; // Excluding ground floor
  const unitsPerFloor = Math.ceil(totalUnits / Math.max(residentialFloors, 1));

  // Circulation dimensions - use FIXED realistic sizes, not PDF values
  const corridorWidth = circulation?.corridor_width_ft || 6;
  const numElevators = Math.min(circulation?.elevators?.passenger?.count || 2, 3);
  const stairCount = Math.min(circulation?.stairs?.count || 2, 2);

  // Standard dimensions for circulation elements (industry standard)
  const ELEVATOR_WIDTH = 8;
  const ELEVATOR_DEPTH = 8;
  const STAIR_WIDTH = 10;
  const STAIR_DEPTH = 12;

  const floors: FloorData[] = [];

  for (let floorIdx = -numFloorsBelow; floorIdx < numFloorsAbove; floorIdx++) {
    const spaces: SpaceData[] = [];
    let floorType: string;

    if (floorIdx < 0) {
      floorType = 'PARKING_UNDERGROUND';
    } else if (floorIdx === 0) {
      floorType = 'GROUND';
    } else {
      floorType = 'RESIDENTIAL_TYPICAL';
    }

    // Add vertical circulation (elevators and stairs) to every floor
    // 2-COLUMN COMPACT CORE LAYOUT
    const COL_GAP = 1;
    const ROW_GAP = 1;
    const COL_WIDTH = Math.max(STAIR_WIDTH, ELEVATOR_WIDTH);
    const coreWidth = 2 * COL_WIDTH + COL_GAP;

    const elevatorsLeft = Math.ceil(numElevators / 2);
    const elevatorsRight = numElevators - elevatorsLeft;
    const coreHeight = STAIR_DEPTH + ROW_GAP + Math.max(elevatorsLeft, elevatorsRight) * (ELEVATOR_DEPTH + ROW_GAP);

    const colLeftX = -(COL_GAP / 2 + COL_WIDTH / 2);
    const colRightX = (COL_GAP / 2 + COL_WIDTH / 2);

    const stairY = -coreHeight / 2 + STAIR_DEPTH / 2;
    spaces.push(createSpace(
      `stair_1_f${floorIdx}`, 'CIRCULATION', 'Stair 1', floorIdx,
      colLeftX, stairY, STAIR_WIDTH, STAIR_DEPTH, true
    ));

    if (stairCount >= 2) {
      spaces.push(createSpace(
        `stair_2_f${floorIdx}`, 'CIRCULATION', 'Stair 2', floorIdx,
        colRightX, stairY, STAIR_WIDTH, STAIR_DEPTH, true
      ));
    }

    let elevPlaced = 0;
    for (let row = 0; row < Math.ceil(numElevators / 2); row++) {
      const elevY = stairY + STAIR_DEPTH / 2 + ROW_GAP + row * (ELEVATOR_DEPTH + ROW_GAP) + ELEVATOR_DEPTH / 2;

      if (elevPlaced < numElevators) {
        spaces.push(createSpace(
          `elevator_${elevPlaced + 1}_f${floorIdx}`, 'CIRCULATION', `Elevator ${elevPlaced + 1}`, floorIdx,
          colLeftX, elevY, ELEVATOR_WIDTH, ELEVATOR_DEPTH, true
        ));
        elevPlaced++;
      }

      if (elevPlaced < numElevators) {
        spaces.push(createSpace(
          `elevator_${elevPlaced + 1}_f${floorIdx}`, 'CIRCULATION', `Elevator ${elevPlaced + 1}`, floorIdx,
          colRightX, elevY, ELEVATOR_WIDTH, ELEVATOR_DEPTH, true
        ));
        elevPlaced++;
      }
    }

    if (stairCount >= 3) {
      const stair3Y = stairY + STAIR_DEPTH / 2 + ROW_GAP + Math.ceil(numElevators / 2) * (ELEVATOR_DEPTH + ROW_GAP) + STAIR_DEPTH / 2;
      spaces.push(createSpace(
        `stair_3_f${floorIdx}`, 'CIRCULATION', 'Stair 3', floorIdx,
        colLeftX, stair3Y, STAIR_WIDTH, STAIR_DEPTH, true
      ));
    }

    if (floorIdx < 0) {
      generateParkingFloor(spaces, floorIdx, halfSide, parking, coreWidth, coreHeight,
        isIrregular ? boundaryPolygon : undefined);
    } else if (floorIdx === 0) {
      generateGroundFloor(spaces, floorIdx, halfSide, data, coreWidth, coreHeight,
        isIrregular ? boundaryPolygon : undefined);
    } else if (isIrregular) {
      // Use radial slice for irregular parcel shapes — trapezoidal units from boundary to core
      generateResidentialFloorRadialSlice(
        spaces, floorIdx, boundaryPolygon, units,
        residentialFloors, coreWidth, coreHeight
      );
    } else {
      // Fallback to square perimeter packing
      generateResidentialFloor(
        spaces, floorIdx, halfSide, units,
        corridorWidth, unitsPerFloor, residentialFloors,
        coreWidth, coreHeight
      );
    }

    // Use actual polygon boundary for all floors when irregular
    const floorBoundary: number[][] = isIrregular
      ? boundaryPolygon.map(p => [p[0], p[1]])
      : [[-halfSide, -halfSide], [halfSide, -halfSide], [halfSide, halfSide], [-halfSide, halfSide]];

    floors.push({
      floor_index: floorIdx,
      floor_type: floorType,
      boundary: floorBoundary,
      area_sf: floorPlateArea,
      spaces,
    });
  }

  const totalSpaces = floors.reduce((sum, f) => sum + f.spaces.length, 0);

  return {
    success: true,
    obstruction: 0,
    iterations: 1,
    message: 'Generated from PDF extraction with actual unit dimensions',
    violations: [],
    metrics: {
      placement_rate: '100.0%',
      avg_membership: '1.00',
      total_spaces: totalSpaces,
      placed_spaces: totalSpaces,
    },
    building: {
      floors,
      stalks: [
        {
          id: 'elevator_stalk',
          type: 'elevator',
          floor_range: Array.from({ length: totalFloors }, (_, i) => i - numFloorsBelow),
          position: { x: -4, y: 0 },
        },
        {
          id: 'stair_stalk',
          type: 'stair',
          floor_range: Array.from({ length: totalFloors }, (_, i) => i - numFloorsBelow),
          position: { x: 9, y: 0 },
        },
      ],
      metrics: {
        total_floors: totalFloors,
        total_spaces: totalSpaces,
        cohomology_obstruction: 0,
      },
    },
  };
}

/**
 * Generate parking floor with proper stall layout and support rooms
 * Based on reference screenshot - perpendicular stalls with central aisle
 * Uses CENTER-ORIGIN coordinates
 */
function generateParkingFloor(
  spaces: SpaceData[],
  floorIdx: number,
  halfSide: number,
  parking: ExtractedBuildingData['parking'],
  coreWidth: number,
  coreHeight: number,
  boundaryPolygon?: Polygon
): void {
  const totalStalls = parking?.underground_stalls ?? 45;
  const h = halfSide;
  const MARGIN = 5;

  // For irregular polygons, scale room sizes down based on available area
  const roomScale = boundaryPolygon ? Math.min(1, h / 80) : 1;

  // Standard dimensions (scaled for polygon)
  const STALL_WIDTH = 9;
  const STALL_DEPTH = Math.round(18 * roomScale);
  const AISLE_WIDTH = Math.round(24 * roomScale);

  const boundary = { minX: -h + MARGIN, maxX: h - MARGIN, minY: -h + MARGIN, maxY: h - MARGIN };
  const placedBounds: BoundingBox[] = [
    { x: 0, y: 0, width: coreWidth, height: coreHeight }
  ];

  // Support rooms — scaled for polygon
  const supportRooms: Array<{ id: string; name: string; w: number; h: number }> = [
    { id: 'storage',        name: 'Storage',        w: Math.round(15 * roomScale), h: Math.round(12 * roomScale) },
    { id: 'trash_recycle',  name: 'Trash/Recycle',  w: Math.round(12 * roomScale), h: Math.round(10 * roomScale) },
    { id: 'fan_room',       name: 'Fan Room',       w: Math.round(12 * roomScale), h: Math.round(10 * roomScale) },
    { id: 'fire_pump',      name: 'Fire Pump',      w: Math.round(10 * roomScale), h: Math.round(10 * roomScale) },
    { id: 'domestic_water', name: 'Domestic Water',  w: Math.round(10 * roomScale), h: Math.round(10 * roomScale) },
    { id: 'mpoe',           name: 'MPOE',           w: Math.round(10 * roomScale), h: Math.round(8 * roomScale) },
  ];

  // Place support rooms — let grid scan find valid position inside polygon
  for (const room of supportRooms) {
    safelyPlaceSpace(
      spaces, placedBounds,
      `${room.id}_f${floorIdx}`, 'SUPPORT', room.name, floorIdx,
      h * 0.4, 0, room.w, room.h, false, boundary, boundaryPolygon
    );
  }

  if (totalStalls > 0) {
    // Block-based parking: 5×2 bays (5 stalls wide × 2 deep) with aisles between.
    // Each bay is one rectangle; cleaner layout, more efficient space use.
    //
    //   ┌─────────┐  ┌─────────┐
    //   │ 5×2 bay │  │ 5×2 bay │   ← north bays (2 rows back-to-back)
    //   └─────────┘  └─────────┘
    //   ═══════════════════════════  ← drive aisle (implicit)
    //   ┌─────────┐  ┌─────────┐
    //   │ 5×2 bay │  │ 5×2 bay │   ← south bays
    //   └─────────┘  └─────────┘

    const STALLS_PER_BAY = 10; // 5 wide × 2 deep
    const BAY_W = 5 * STALL_WIDTH;         // 45 ft
    const BAY_H = 2 * STALL_DEPTH;         // 36 ft
    const BAY_GAP = 2;                      // gap between adjacent bays

    const aisleW = Math.min(2 * h - 30, 80) * roomScale;
    // Reserve aisle footprint for collision detection (implicit — not rendered)
    placedBounds.push({ x: 0, y: 0, width: aisleW, height: AISLE_WIDTH });

    const northY = -AISLE_WIDTH / 2 - BAY_H / 2;
    const southY = AISLE_WIDTH / 2 + BAY_H / 2;

    const numBays = Math.ceil(totalStalls / STALLS_PER_BAY);
    let bayCount = 0;
    let stallsPlaced = 0;

    for (const rowY of [northY, southY]) {
      const startX = -h + MARGIN + BAY_W / 2;
      for (let col = 0; bayCount < numBays && stallsPlaced < totalStalls; col++) {
        const x = startX + col * (BAY_W + BAY_GAP);
        const stallsInBay = Math.min(STALLS_PER_BAY, totalStalls - stallsPlaced);
        safelyPlaceSpace(
          spaces, placedBounds,
          `parking_bay_${bayCount + 1}_f${floorIdx}`, 'PARKING',
          `P${stallsPlaced + 1}-${stallsPlaced + stallsInBay}`, floorIdx,
          x, rowY, BAY_W, BAY_H, false, boundary, boundaryPolygon
        );
        stallsPlaced += stallsInBay;
        bayCount++;
      }
    }
  }
}

/**
 * Generate ground floor with lobby, amenities, and support spaces
 * Layout based on reference screenshot - lobby at entrance, amenities around perimeter
 * Uses CENTER-ORIGIN coordinates with COLLISION DETECTION
 */
function generateGroundFloor(
  spaces: SpaceData[],
  floorIdx: number,
  halfSide: number,
  data: ExtractedBuildingData,
  coreWidth: number,
  coreHeight: number,
  boundaryPolygon?: Polygon
): void {
  const h = halfSide;
  const MARGIN = 5;
  const boundary = { minX: -h + MARGIN, maxX: h - MARGIN, minY: -h + MARGIN, maxY: h - MARGIN };
  const s = boundaryPolygon ? Math.min(1, h / 80) : 1; // scale for tight polygons

  const placedBounds: BoundingBox[] = [
    { x: 0, y: 0, width: coreWidth, height: coreHeight }
  ];

  // Corridor reservation — implicit (gap between rooms IS the corridor)
  placedBounds.push({ x: 0, y: 0, width: 6, height: Math.round(h * 1.2) });

  // Rooms scaled for polygon — grid scan will find valid positions
  const rooms: Array<{ id: string; type: string; name: string; w: number; h: number; prefX: number; prefY: number }> = [
    { id: `lobby_f${floorIdx}`,          type: 'CIRCULATION', name: 'Lobby',        w: Math.round(30 * s), h: Math.round(20 * s), prefX: 0, prefY: h * 0.5 },
    { id: `leasing_f${floorIdx}`,        type: 'SUPPORT',     name: 'Leasing',      w: Math.round(18 * s), h: Math.round(15 * s), prefX: h * 0.5, prefY: h * 0.3 },
    { id: `mail_f${floorIdx}`,           type: 'SUPPORT',     name: 'Mail/Package', w: Math.round(15 * s), h: Math.round(12 * s), prefX: -h * 0.5, prefY: h * 0.3 },
    { id: `lounge_f${floorIdx}`,         type: 'AMENITY',     name: 'Lounge',       w: Math.round(30 * s), h: Math.round(25 * s), prefX: -h * 0.4, prefY: 0 },
    { id: `fitness_f${floorIdx}`,        type: 'AMENITY',     name: 'Fitness',      w: Math.round(25 * s), h: Math.round(20 * s), prefX: -h * 0.3, prefY: -h * 0.4 },
    { id: `restroom_m_f${floorIdx}`,     type: 'SUPPORT',     name: 'Restroom M',   w: Math.round(12 * s), h: Math.round(10 * s), prefX: h * 0.5, prefY: -h * 0.2 },
    { id: `restroom_f_f${floorIdx}`,     type: 'SUPPORT',     name: 'Restroom F',   w: Math.round(12 * s), h: Math.round(10 * s), prefX: h * 0.5, prefY: -h * 0.4 },
    { id: `trash_f${floorIdx}`,          type: 'SUPPORT',     name: 'Trash',        w: Math.round(10 * s), h: Math.round(8 * s),  prefX: h * 0.4, prefY: 0 },
    { id: `bike_storage_f${floorIdx}`,   type: 'SUPPORT',     name: 'Bike Storage', w: Math.round(20 * s), h: Math.round(18 * s), prefX: h * 0.3, prefY: -h * 0.5 },
  ];

  for (const room of rooms) {
    safelyPlaceSpace(spaces, placedBounds,
      room.id, room.type, room.name, floorIdx,
      room.prefX, room.prefY, room.w, room.h, false, boundary, boundaryPolygon
    );
  }

  // Optional ground floor units
  const groundUnits = data.dwelling_units?.filter(u => u.count > 0).slice(0, 2) || [];
  for (let i = 0; i < 2; i++) {
    const unit = groundUnits[i % groundUnits.length];
    if (unit) {
      const unitWidth = Math.min(unit.width_ft || 15, Math.round(15 * s));
      const unitDepth = Math.min(unit.depth_ft || 20, Math.round(20 * s));
      safelyPlaceSpace(spaces, placedBounds,
        `unit_ground_${i}_f${floorIdx}`, 'DWELLING_UNIT', `${unit.name || unit.type} A${i + 1}`, floorIdx,
        0, -h * 0.3, unitWidth, unitDepth, false, boundary, boundaryPolygon
      );
    }
  }
}

// ============================================
// RADIAL SLICE ALGORITHM FOR IRREGULAR POLYGONS
// ============================================
// Units shaped by boundary — outer edge IS the building perimeter (windows).
// Radial slices from perimeter to corridor ring around core.
// Non-rectangular (trapezoidal/polygonal) units that conform to the parcel.

/** Frontage widths for radial units (wider than compact — these are the window wall) */
const RADIAL_FRONTAGES: Record<string, number> = {
  'studio': 16, '1br': 20, '2br': 28, '3br': 34,
};

/**
 * Create a SpaceData with PolygonGeometry instead of rect
 */
function createPolygonSpace(
  id: string,
  type: string,
  name: string,
  floorIndex: number,
  vertices: [number, number][],
  targetArea: number
): SpaceData {
  const actualArea = calculatePolygonArea(vertices);
  const deviation = targetArea > 0
    ? ((actualArea - targetArea) / targetArea * 100).toFixed(1)
    : '0.0';
  return {
    id,
    type,
    name,
    floor_index: floorIndex,
    geometry: { vertices } as PolygonGeometry,
    target_area_sf: targetArea,
    actual_area_sf: actualArea,
    membership: 1.0,
    area_deviation: `${Number(deviation) >= 0 ? '+' : ''}${deviation}%`,
    is_vertical: false,
  };
}

/**
 * Walk boundary perimeter, place interpolated cut points spaced by unit frontage widths.
 * Scale all frontages uniformly so they sum to exactly the perimeter length.
 * Returns cut points as [x, y] along the boundary.
 */
function placeCutPoints(
  boundary: Polygon,
  unitQueue: Array<{ type: string; frontage: number }>,
): Point[] {
  const perim = computePerimeter(boundary);
  const rawSum = unitQueue.reduce((s, u) => s + u.frontage, 0);
  const scale = perim / rawSum;

  // Walk along boundary edges, placing cut points at accumulated distances
  const cutPoints: Point[] = [];
  let accumulated = 0;
  let nextCutDist = 0;
  let unitIdx = 0;
  const n = boundary.length;

  // First cut point is always boundary[0]
  cutPoints.push([boundary[0][0], boundary[0][1]]);
  nextCutDist = unitQueue[unitIdx].frontage * scale;
  unitIdx++;

  for (let i = 0; i < n && unitIdx < unitQueue.length; i++) {
    const p1 = boundary[i];
    const p2 = boundary[(i + 1) % n];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const edgeLen = Math.sqrt(dx * dx + dy * dy);
    if (edgeLen < 1e-6) continue;

    const startOfEdge = accumulated;
    const endOfEdge = accumulated + edgeLen;

    while (unitIdx < unitQueue.length && nextCutDist <= endOfEdge + 1e-6) {
      const t = (nextCutDist - startOfEdge) / edgeLen;
      const clampT = Math.max(0, Math.min(1, t));
      let newPoint: Point = [
        p1[0] + dx * clampT,
        p1[1] + dy * clampT,
      ];

      // Snap to nearby boundary vertex to prevent half-vertex inclusion gaps
      const SNAP_DIST = 1.0;
      for (let v = 0; v < boundary.length; v++) {
        const d = Math.hypot(newPoint[0] - boundary[v][0], newPoint[1] - boundary[v][1]);
        if (d < SNAP_DIST) {
          newPoint = [boundary[v][0], boundary[v][1]];
          break;
        }
      }

      cutPoints.push(newPoint);
      nextCutDist += unitQueue[unitIdx].frontage * scale;
      unitIdx++;
    }

    accumulated = endOfEdge;
  }

  return cutPoints;
}

/**
 * Collect boundary vertices between two points along the perimeter.
 * Returns intermediate polygon vertices (not including cutA and cutB themselves).
 */
function collectBoundaryVerticesBetween(
  boundary: Polygon,
  cutA: Point,
  cutB: Point,
): Point[] {
  const n = boundary.length;
  const result: Point[] = [];

  // Find which edge cutA falls on
  let edgeA = -1;
  let edgeB = -1;
  const EPS = 0.5; // tolerance for point-on-edge

  for (let i = 0; i < n; i++) {
    const p1 = boundary[i];
    const p2 = boundary[(i + 1) % n];
    if (isPointOnSegment(cutA, p1, p2, EPS) && edgeA < 0) edgeA = i;
    if (isPointOnSegment(cutB, p1, p2, EPS) && edgeB < 0) edgeB = i;
  }

  if (edgeA < 0 || edgeB < 0) return result;
  if (edgeA === edgeB) return result; // Same edge, no intermediate vertices

  // Walk from edgeA+1 to edgeB, collecting polygon vertices
  let idx = (edgeA + 1) % n;
  const limit = n + 1; // safety
  let count = 0;
  while (idx !== (edgeB + 1) % n && count < limit) {
    result.push([boundary[idx][0], boundary[idx][1]]);
    idx = (idx + 1) % n;
    count++;
  }

  return result;
}

/** Check if point p lies on segment p1→p2 within tolerance */
function isPointOnSegment(p: Point, p1: Point, p2: Point, eps: number): boolean {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) return Math.hypot(p[0] - p1[0], p[1] - p1[1]) < eps;

  const t = ((p[0] - p1[0]) * dx + (p[1] - p1[1]) * dy) / lenSq;
  if (t < -0.01 || t > 1.01) return false;

  const projX = p1[0] + t * dx;
  const projY = p1[1] + t * dy;
  return Math.hypot(p[0] - projX, p[1] - projY) < eps;
}

/**
 * Build the polygon for a unit slice between two cut points.
 * Rays from cut points toward origin, intersected with the corridor ring rectangle.
 * Returns vertices forming the unit polygon, or null if degenerate.
 */
function buildUnitPolygon(
  cutA: Point,
  cutB: Point,
  intermediateVerts: Point[],
  corridorRing: { halfW: number; halfH: number },
): [number, number][] | null {
  // Cast rays from cutA and cutB toward origin (0,0) — but stop at corridor ring
  const dirA: Point = [-cutA[0], -cutA[1]];
  const dirB: Point = [-cutB[0], -cutB[1]];

  // The corridor ring is a rectangle centered at origin
  const ringPoly: Polygon = [
    [-corridorRing.halfW, -corridorRing.halfH],
    [corridorRing.halfW, -corridorRing.halfH],
    [corridorRing.halfW, corridorRing.halfH],
    [-corridorRing.halfW, corridorRing.halfH],
  ];

  const innerA = rayBoundaryIntersection(cutA, dirA, ringPoly);
  const innerB = rayBoundaryIntersection(cutB, dirB, ringPoly);

  if (!innerA || !innerB) return null;

  // Build polygon: outer boundary from cutA → intermediateVerts → cutB,
  // then inner boundary from innerB back to innerA (tracing corridor ring if needed)
  const verts: [number, number][] = [];

  // Outer wall (boundary side)
  verts.push([cutA[0], cutA[1]]);
  for (const v of intermediateVerts) {
    verts.push([v[0], v[1]]);
  }
  verts.push([cutB[0], cutB[1]]);

  // Inner wall (corridor ring side)
  // If innerA and innerB are on different edges of the ring, include corners
  const ringCorners = getCorridorCornersBetween(innerB, innerA, corridorRing);
  verts.push([innerB[0], innerB[1]]);
  for (const c of ringCorners) {
    verts.push(c);
  }
  verts.push([innerA[0], innerA[1]]);

  // Sanity: need at least 3 vertices
  if (verts.length < 3) return null;

  // Check area — skip degenerate units
  const area = calculatePolygonArea(verts);
  if (area < 200) return null;

  return verts;
}

/**
 * Determine which edge of the corridor ring rectangle a point lies on.
 * Returns 0=top, 1=right, 2=bottom, 3=left, or -1.
 */
function getRingEdge(pt: Point, ring: { halfW: number; halfH: number }): number {
  const { halfW, halfH } = ring;
  const EPS = 0.5;
  if (Math.abs(pt[1] - (-halfH)) < EPS) return 0; // top (min y)
  if (Math.abs(pt[0] - halfW) < EPS) return 1;     // right
  if (Math.abs(pt[1] - halfH) < EPS) return 2;     // bottom (max y)
  if (Math.abs(pt[0] - (-halfW)) < EPS) return 3;  // left
  return -1;
}

/**
 * Get corridor ring corner vertices between two points on the ring,
 * taking the SHORTER path (CW or CCW) to avoid wrapping the long way around.
 */
function getCorridorCornersBetween(
  from: Point,
  to: Point,
  ring: { halfW: number; halfH: number },
): [number, number][] {
  const { halfW, halfH } = ring;
  const corners: [number, number][] = [
    [-halfW, -halfH],  // TL (0) — between edge 3 and edge 0
    [halfW, -halfH],   // TR (1) — between edge 0 and edge 1
    [halfW, halfH],    // BR (2) — between edge 1 and edge 2
    [-halfW, halfH],   // BL (3) — between edge 2 and edge 3
  ];

  const edgeFrom = getRingEdge(from, ring);
  const edgeTo = getRingEdge(to, ring);

  if (edgeFrom < 0 || edgeTo < 0 || edgeFrom === edgeTo) return [];

  // CW path: corner after edge e (CW) is corners[(e+1)%4... actually mapped below)
  const cornerAfterEdge = [1, 2, 3, 0]; // edge 0→TR, edge 1→BR, edge 2→BL, edge 3→TL

  // Collect CW corners from edgeFrom to edgeTo
  const cwResult: [number, number][] = [];
  let e = edgeFrom;
  for (let s = 0; s < 4 && e !== edgeTo; s++) {
    cwResult.push(corners[cornerAfterEdge[e]]);
    e = (e + 1) % 4;
  }

  // Collect CCW corners from edgeFrom to edgeTo
  // Going CCW from edge e, the corner you pass is corners[e]
  const ccwResult: [number, number][] = [];
  e = edgeFrom;
  for (let s = 0; s < 4 && e !== edgeTo; s++) {
    ccwResult.push(corners[e]);
    e = (e - 1 + 4) % 4;
  }
  ccwResult.reverse(); // Reverse to get correct from→to order

  // Return shorter path
  return cwResult.length <= ccwResult.length ? cwResult : ccwResult;
}

/**
 * Check that all edges of a polygon are at least minLen apart.
 * Rejects degenerate slivers with very thin dimensions.
 */
function hasMinimumEdgeLength(verts: [number, number][], minLen: number): boolean {
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    const dist = Math.hypot(verts[j][0] - verts[i][0], verts[j][1] - verts[i][1]);
    if (dist < minLen) return false;
  }
  return true;
}

/**
 * RADIAL SLICE residential floor generator
 *
 * Drop-in replacement for generateResidentialFloorFillAndCut.
 * Units are trapezoidal slices from boundary to corridor ring around core.
 * Every unit's outer wall IS the building boundary — guaranteed windows.
 */
function generateResidentialFloorRadialSlice(
  spaces: SpaceData[],
  floorIdx: number,
  boundary: Polygon,
  units: ExtractedBuildingData['dwelling_units'],
  totalResidentialFloors: number,
  coreWidth: number,
  coreHeight: number,
): void {
  const CORRIDOR_W = 9;  // Wide enough for regulation-size access past BOH rooms at corners
  const coreHalfW = coreWidth / 2;
  const coreHalfH = coreHeight / 2;

  // 1. Corridor ring = core expanded by CORRIDOR_W on all sides
  const corridorRing = {
    halfW: coreHalfW + CORRIDOR_W,
    halfH: coreHalfH + CORRIDOR_W,
  };

  // 2. O-ring corridor is implicit — the gap between units and core IS the corridor.
  //    No corridor spaces rendered; corridorRing dimensions still used for ray-casting.

  // 3. Support rooms at corridor ring dead corners (inside the ring, not outside)
  const SUPPORT_W = 5;
  const SUPPORT_H = 5;
  const supportPositions = [
    { id: `trash_f${floorIdx}`, name: 'Trash',  x:  coreHalfW + CORRIDOR_W / 2, y: -coreHalfH - CORRIDOR_W / 2 },  // NE corner
    { id: `mech_f${floorIdx}`,  name: 'Mech',   x:  coreHalfW + CORRIDOR_W / 2, y:  coreHalfH + CORRIDOR_W / 2 },  // SE corner
    { id: `stor_f${floorIdx}`,  name: 'Stor',   x: -coreHalfW - CORRIDOR_W / 2, y: -coreHalfH - CORRIDOR_W / 2 },  // NW corner
    { id: `elec_f${floorIdx}`,  name: 'Elec',   x: -coreHalfW - CORRIDOR_W / 2, y:  coreHalfH + CORRIDOR_W / 2 },  // SW corner
  ];
  for (const s of supportPositions) {
    spaces.push(createSpace(s.id, 'SUPPORT', s.name, floorIdx, s.x, s.y, SUPPORT_W, SUPPORT_H, false));
  }

  // 4. Build unit queue with frontage widths + target areas
  const totalUnits = units.reduce((sum, u) => sum + u.count, 0);
  const targetPerFloor = Math.ceil(totalUnits / Math.max(totalResidentialFloors, 1));

  const unitQueue: Array<{ type: string; name: string; frontage: number; targetArea: number }> = [];
  let typeIdx = 0;
  for (let i = 0; i < targetPerFloor; i++) {
    const unitType = units[typeIdx % units.length];
    if (unitType) {
      unitQueue.push({
        type: unitType.type,
        name: unitType.name || unitType.type,
        frontage: RADIAL_FRONTAGES[unitType.type.toLowerCase()] || 20,
        targetArea: unitType.area_sf || 700,
      });
    }
    typeIdx++;
  }

  if (unitQueue.length === 0) return;

  // 5. Filter out cut points near sharp boundary vertices (< 30 degrees)
  const n = boundary.length;
  const sharpVertices = new Set<number>();
  for (let i = 0; i < n; i++) {
    const prev = boundary[(i - 1 + n) % n];
    const curr = boundary[i];
    const next = boundary[(i + 1) % n];
    const angle = interiorAngle(prev, curr, next);
    if (angle < 30 || angle > 330) {
      sharpVertices.add(i);
    }
  }

  // 6. Place cut points along perimeter
  const cutPoints = placeCutPoints(
    boundary,
    unitQueue.map(u => ({ type: u.type, frontage: u.frontage })),
  );

  // 7. Build unit polygons — two-pass: place, then fill gaps
  //
  // Pass 1: Place units at each cut pair, recording successful placements
  // Pass 2: Extend each unit to meet the next, eliminating wedge gaps

  interface PlacedUnit {
    cutA: Point;
    cutB: Point;
    unit: typeof unitQueue[0];
    unitIdx: number;
    spaceIdx: number; // index into spaces[]
  }
  const placedUnits: PlacedUnit[] = [];
  const spaceBaseIdx = spaces.length; // remember where unit spaces start

  let unitIdx = 0;
  for (let i = 0; i < cutPoints.length - 1 && unitIdx < unitQueue.length; i++) {
    const cutA = cutPoints[i];
    const cutB = cutPoints[i + 1];

    // Skip degenerate cuts (too close together) — do NOT consume a unit
    const cutDist = Math.hypot(cutB[0] - cutA[0], cutB[1] - cutA[1]);
    if (cutDist < 3) { continue; }

    const intermediateVerts = collectBoundaryVerticesBetween(boundary, cutA, cutB);
    const unit = unitQueue[unitIdx];

    const rawVerts = buildUnitPolygon(cutA, cutB, intermediateVerts, corridorRing);
    if (rawVerts && calculatePolygonArea(rawVerts) >= 200 && hasMinimumEdgeLength(rawVerts, 2)) {
      const spaceIdx = spaces.length;
      spaces.push(createPolygonSpace(
        `unit_${unit.type}_${unitIdx}_f${floorIdx}`,
        'DWELLING_UNIT',
        unit.name,
        floorIdx,
        rawVerts,
        unit.targetArea,
      ));
      placedUnits.push({ cutA, cutB, unit, unitIdx, spaceIdx });
    }

    unitIdx++;
  }

  // Handle wrap-around: last cut point to first cut point (closing the perimeter)
  if (cutPoints.length >= 2 && unitIdx < unitQueue.length) {
    const cutA = cutPoints[cutPoints.length - 1];
    const cutB = cutPoints[0];
    const cutDist = Math.hypot(cutB[0] - cutA[0], cutB[1] - cutA[1]);

    if (cutDist >= 3) {
      const intermediateVerts = collectBoundaryVerticesBetween(boundary, cutA, cutB);
      const unit = unitQueue[unitIdx];

      const rawVerts = buildUnitPolygon(cutA, cutB, intermediateVerts, corridorRing);
      if (rawVerts && calculatePolygonArea(rawVerts) >= 200 && hasMinimumEdgeLength(rawVerts, 2)) {
        const spaceIdx = spaces.length;
        spaces.push(createPolygonSpace(
          `unit_${unit.type}_${unitIdx}_f${floorIdx}`,
          'DWELLING_UNIT',
          unit.name,
          floorIdx,
          rawVerts,
          unit.targetArea,
        ));
        placedUnits.push({ cutA, cutB, unit, unitIdx, spaceIdx });
      }
    }
  }

  // Pass 2: Fill gaps — extend each unit to meet the next placed unit
  // If there's a gap between unit N's cutB and unit N+1's cutA,
  // rebuild unit N from its cutA to unit N+1's cutA.
  if (placedUnits.length >= 2) {
    for (let i = 0; i < placedUnits.length; i++) {
      const curr = placedUnits[i];
      const next = placedUnits[(i + 1) % placedUnits.length];

      const gapDist = Math.hypot(
        curr.cutB[0] - next.cutA[0],
        curr.cutB[1] - next.cutA[1],
      );

      // If gap > 1ft, extend current unit to meet next unit
      if (gapDist > 1) {
        const extendedIntermediateVerts = collectBoundaryVerticesBetween(
          boundary, curr.cutA, next.cutA,
        );
        const extendedVerts = buildUnitPolygon(
          curr.cutA, next.cutA, extendedIntermediateVerts, corridorRing,
        );
        if (extendedVerts && calculatePolygonArea(extendedVerts) >= 200) {
          // Replace the unit's polygon with the extended version
          const space = spaces[curr.spaceIdx];
          (space.geometry as PolygonGeometry).vertices = extendedVerts;
          space.actual_area_sf = calculatePolygonArea(extendedVerts);
          const deviation = curr.unit.targetArea > 0
            ? ((space.actual_area_sf - curr.unit.targetArea) / curr.unit.targetArea * 100).toFixed(1)
            : '0.0';
          space.area_deviation = `${Number(deviation) >= 0 ? '+' : ''}${deviation}%`;
        }
      }
    }
  }
}

/**
 * Generate residential floor using CONTINUOUS PERIMETER PACKING
 *
 * LAYOUT (like Canoga reference):
 *   ┌──────────────────────────────────────────────────┐
 *   │ 2BR │ 1BR │ 1BR │ Studio │ 1BR │ 1BR │ 2BR      │ ← NORTH (6-7 units)
 *   ├─────┼─────────────────────────────────────┼──────┤
 *   │ 1BR │                                     │ 1BR  │
 *   ├─────┤      ┌─────────────────────┐        ├──────┤ ← EAST/WEST (3-4 each)
 *   │ 1BR │      │   TRASH  MECH      │        │ 1BR  │
 *   ├─────┤      │   ELEV ELEV STAIR  │        ├──────┤
 *   │ Stu │      │   STOR   ELEC      │        │ Stu  │
 *   ├─────┤      └─────────────────────┘        ├──────┤
 *   │ 1BR │                                     │ 1BR  │
 *   ├─────┼─────────────────────────────────────┼──────┤
 *   │ 2BR │ 1BR │ 1BR │ Studio │ 1BR │ 1BR │ 2BR      │ ← SOUTH (6-7 units)
 *   └──────────────────────────────────────────────────┘
 *
 * KEY: Every unit MUST touch exterior wall (windows). ~18-20 units per floor.
 */
function generateResidentialFloor(
  spaces: SpaceData[],
  floorIdx: number,
  halfSide: number,
  units: ExtractedBuildingData['dwelling_units'],
  _corridorWidth: number,
  _unitsPerFloor: number,
  totalResidentialFloors: number,
  coreWidth: number,
  coreHeight: number  // Actual core height (rectangular, not square)
): void {
  // Constants
  const MARGIN = 5;           // 5ft setback from property line
  const UNIT_GAP = 0.5;       // Minimal gap between units
  const CORRIDOR_WIDTH = 5;   // Narrow corridor

  const h = halfSide;         // Half of floor plate side

  // ========================================
  // INSIDE-OUT ZONE COMPUTATION
  // Rectangular core → asymmetric unit depths
  // ========================================

  // Zone 1: CORE - rectangular (coreWidth × coreHeight)
  const coreHalfW = coreWidth / 2;
  const coreHalfH = coreHeight / 2;

  // Zone 2: CORRIDOR - wraps around core
  const corridorOuterW = coreHalfW + CORRIDOR_WIDTH;  // For E/W sides
  const corridorOuterH = coreHalfH + CORRIDOR_WIDTH;  // For N/S sides

  // Zone 3: UNITS - asymmetric depths based on rectangular core
  const unitOuter = h - MARGIN;  // Outer edge at property setback
  const UNIT_DEPTH_NS = Math.max(15, unitOuter - corridorOuterH);  // N/S sides (shorter core dim)
  const UNIT_DEPTH_EW = Math.max(15, unitOuter - corridorOuterW);  // E/W sides (wider core dim)

  // SKINNY UNITS for maximum packing
  // Studios: 12', 1BR: 14', 2BR: 18', 3BR: 22'
  const COMPACT_WIDTHS: Record<string, number> = {
    'studio': 12,
    '1br': 14,
    '2br': 18,
    '3br': 22,
  };

  // Calculate how many units fit on each side with skinny widths
  const avgWidth = 15;  // Average of compact widths
  const sideLength = 2 * h - 2 * MARGIN;
  const unitsPerLongSide = Math.floor(sideLength / (avgWidth + UNIT_GAP));
  const shortSideLength = 2 * corridorOuterH;  // E/W sides span corridor height
  const unitsPerShortSide = Math.floor(shortSideLength / (avgWidth + UNIT_GAP));

  // Total perimeter capacity
  const perimeterCapacity = 2 * unitsPerLongSide + 2 * unitsPerShortSide;

  // Calculate target - aim to fill perimeter completely
  const totalUnits = units.reduce((sum, u) => sum + u.count, 0);
  const targetUnitsPerFloor = Math.ceil(totalUnits / totalResidentialFloors);
  const unitsToPlace = Math.max(targetUnitsPerFloor, perimeterCapacity, 24);

  // Create unit queue with skinny units
  const unitQueue: Array<{ type: string; name: string; width: number; depth: number }> = [];
  let typeIdx = 0;
  for (let i = 0; i < unitsToPlace; i++) {
    const unitType = units[typeIdx % units.length];
    if (unitType) {
      const compactWidth = COMPACT_WIDTHS[unitType.type.toLowerCase()] || 14;
      unitQueue.push({
        type: unitType.type,
        name: unitType.name || unitType.type,
        width: compactWidth,
        depth: 0,  // depth set per-side during placement
      });
    }
    typeIdx++;
  }

  // Place support rooms at the ENDS of corridor segments (adjacent to corridor ring)
  // This keeps them out of the unit zone and out of the core elements
  const SUPPORT_W = 5;
  const SUPPORT_H = CORRIDOR_WIDTH;  // Match corridor height for clean look

  // Place at the east/west ends of the N and S corridor segments
  // N corridor: centered at Y = -corridorOuterH + CORRIDOR_WIDTH/2
  // S corridor: centered at Y = +corridorOuterH - CORRIDOR_WIDTH/2
  const nCorridorY = -corridorOuterH + CORRIDOR_WIDTH / 2;
  const sCorridorY =  corridorOuterH - CORRIDOR_WIDTH / 2;
  // East end of corridor = corridorOuterW (where E corridor meets)
  // Place support rooms just beyond the E/W corridor segments
  const supportEastX = corridorOuterW + SUPPORT_W / 2;
  const supportWestX = -corridorOuterW - SUPPORT_W / 2;

  const supportPositions = [
    { id: `trash_f${floorIdx}`, name: 'Trash',  x: supportEastX, y: nCorridorY },
    { id: `mech_f${floorIdx}`,  name: 'Mech',   x: supportEastX, y: sCorridorY },
    { id: `stor_f${floorIdx}`,  name: 'Stor',   x: supportWestX, y: nCorridorY },
    { id: `elec_f${floorIdx}`,  name: 'Elec',   x: supportWestX, y: sCorridorY },
  ];

  // Pre-register support room bounds for collision detection with units
  const supportBounds: BoundingBox[] = supportPositions.map(s => ({
    x: s.x, y: s.y, width: SUPPORT_W, height: SUPPORT_H
  }));

  for (const s of supportPositions) {
    spaces.push(createSpace(s.id, 'SUPPORT', s.name, floorIdx, s.x, s.y, SUPPORT_W, SUPPORT_H, false));
  }

  // ========================================
  // PLACE UNITS CONTINUOUSLY AROUND PERIMETER
  // All units touch exterior wall (windows)
  // WITH COLLISION DETECTION against core + support rooms
  // ========================================

  // Initialize collision detection with core + corridor ring + support rooms
  const placedBounds: BoundingBox[] = [
    { x: 0, y: 0, width: coreWidth, height: coreHeight },
    ...supportBounds
  ];

  let unitIndex = 0;

  // ========================================
  // NORTH SIDE - units facing north (windows on north edge)
  // Uses UNIT_DEPTH_NS (depth from north corridor to north wall)
  // ========================================
  const northY = -h + MARGIN + UNIT_DEPTH_NS / 2;
  let northX = -h + MARGIN;

  while (unitIndex < unitQueue.length && northX + unitQueue[unitIndex].width <= h - MARGIN) {
    const unit = unitQueue[unitIndex];
    const unitBounds: BoundingBox = {
      x: northX + unit.width / 2,
      y: northY,
      width: unit.width,
      height: UNIT_DEPTH_NS
    };
    if (!hasOverlap(unitBounds, placedBounds, 0)) {
      placedBounds.push(unitBounds);
      spaces.push(createSpace(
        `unit_${unit.type}_${unitIndex}_f${floorIdx}`,
        'DWELLING_UNIT', unit.name, floorIdx,
        unitBounds.x, unitBounds.y, unit.width, UNIT_DEPTH_NS, false
      ));
    }
    northX += unit.width + UNIT_GAP;
    unitIndex++;
  }

  // ========================================
  // EAST SIDE - units facing east (windows on east edge)
  // Uses UNIT_DEPTH_EW; span from -corridorOuterH to +corridorOuterH
  // ========================================
  const eastX = h - MARGIN - UNIT_DEPTH_EW / 2;
  let eastY = -corridorOuterH;

  while (unitIndex < unitQueue.length && eastY + unitQueue[unitIndex].width <= corridorOuterH) {
    const unit = unitQueue[unitIndex];
    const unitBounds: BoundingBox = {
      x: eastX,
      y: eastY + unit.width / 2,
      width: UNIT_DEPTH_EW,
      height: unit.width
    };
    if (!hasOverlap(unitBounds, placedBounds, 0)) {
      placedBounds.push(unitBounds);
      spaces.push(createSpace(
        `unit_${unit.type}_${unitIndex}_f${floorIdx}`,
        'DWELLING_UNIT', unit.name, floorIdx,
        unitBounds.x, unitBounds.y, UNIT_DEPTH_EW, unit.width, false
      ));
    }
    eastY += unit.width + UNIT_GAP;
    unitIndex++;
  }

  // ========================================
  // SOUTH SIDE - units facing south (windows on south edge)
  // Uses UNIT_DEPTH_NS
  // ========================================
  const southY = h - MARGIN - UNIT_DEPTH_NS / 2;
  let southX = h - MARGIN;

  while (unitIndex < unitQueue.length && southX - unitQueue[unitIndex].width >= -h + MARGIN) {
    const unit = unitQueue[unitIndex];
    southX -= unit.width;
    const unitBounds: BoundingBox = {
      x: southX + unit.width / 2,
      y: southY,
      width: unit.width,
      height: UNIT_DEPTH_NS
    };
    if (!hasOverlap(unitBounds, placedBounds, 0)) {
      placedBounds.push(unitBounds);
      spaces.push(createSpace(
        `unit_${unit.type}_${unitIndex}_f${floorIdx}`,
        'DWELLING_UNIT', unit.name, floorIdx,
        unitBounds.x, unitBounds.y, unit.width, UNIT_DEPTH_NS, false
      ));
    }
    southX -= UNIT_GAP;
    unitIndex++;
  }

  // ========================================
  // WEST SIDE - units facing west (windows on west edge)
  // Uses UNIT_DEPTH_EW; span from -corridorOuterH to +corridorOuterH
  // ========================================
  const westX = -h + MARGIN + UNIT_DEPTH_EW / 2;
  let westY = corridorOuterH;

  while (unitIndex < unitQueue.length && westY - unitQueue[unitIndex].width >= -corridorOuterH) {
    const unit = unitQueue[unitIndex];
    westY -= unit.width;
    const unitBounds: BoundingBox = {
      x: westX,
      y: westY + unit.width / 2,
      width: UNIT_DEPTH_EW,
      height: unit.width
    };
    if (!hasOverlap(unitBounds, placedBounds, 0)) {
      placedBounds.push(unitBounds);
      spaces.push(createSpace(
        `unit_${unit.type}_${unitIndex}_f${floorIdx}`,
        'DWELLING_UNIT', unit.name, floorIdx,
        unitBounds.x, unitBounds.y, UNIT_DEPTH_EW, unit.width, false
      ));
    }
    westY -= UNIT_GAP;
    unitIndex++;
  }

  // Corridor is implicit — the gap between units and core IS the corridor.
}

/**
 * Distribute units evenly across residential floors
 */
function distributeUnitsToFloor(
  units: ExtractedBuildingData['dwelling_units'],
  floorNumber: number,
  totalFloors: number
): Array<{ unitType: ExtractedBuildingData['dwelling_units'][0]; count: number }> {
  const result: Array<{ unitType: ExtractedBuildingData['dwelling_units'][0]; count: number }> = [];

  for (const unit of units) {
    // Calculate how many of this unit type go on each floor
    const unitsPerFloor = Math.ceil(unit.count / totalFloors);
    const startingUnit = (floorNumber - 1) * unitsPerFloor;
    const endingUnit = Math.min(startingUnit + unitsPerFloor, unit.count);
    const countOnFloor = Math.max(0, endingUnit - startingUnit);

    if (countOnFloor > 0) {
      result.push({ unitType: unit, count: countOnFloor });
    }
  }

  return result;
}

/**
 * Legacy generation for backward compatibility
 * Also uses CENTER-ORIGIN coordinates
 */
function generateFromLegacyData(extracted: LegacyExtractedData): SolverResult {
  const props = extracted.properties || {};
  const constraints = extracted.constraints || {};
  const units = extracted.units || [];

  const lotArea = props.area_sf || 30000;
  const maxHeight = constraints.maximum_height_feet || 70;
  const totalUnits = props.total_units_proposed || units.reduce((sum, u) => sum + (u.count || 0), 0) || 100;

  const numFloors = Math.min(Math.floor(maxHeight / 10), 8);
  const floorPlateArea = lotArea * 0.6;
  const floorPlateSide = Math.sqrt(floorPlateArea);
  const halfSide = floorPlateSide / 2;

  const floors: FloorData[] = [];

  for (let i = -1; i < numFloors; i++) {
    const floorType = i < 0 ? 'PARKING_UNDERGROUND' : i === 0 ? 'GROUND' : 'RESIDENTIAL_TYPICAL';
    const spaces: SpaceData[] = [];

    // Add basic circulation at center
    spaces.push(createSpace(`elevator_f${i}`, 'CIRCULATION', 'Elevator', i,
      -5, 0, 10, 17, true));
    spaces.push(createSpace(`stair_f${i}`, 'CIRCULATION', 'Stair', i,
      10, 0, 12, 18, true));

    if (i < 0) {
      // Parking - centered layout
      for (let p = 0; p < 20; p++) {
        const row = Math.floor(p / 5);
        const col = p % 5;
        const x = -halfSide + 30 + col * 25;
        const y = -halfSide + 30 + row * 40;
        spaces.push(createSpace(`parking_${p}_f${i}`, 'PARKING', `Parking ${p + 1}`, i,
          x, y, 20, 35, false));
      }
    } else if (i === 0) {
      // Ground floor - centered layout
      spaces.push(createSpace(`lobby_f${i}`, 'CIRCULATION', 'Lobby', i,
        0, -halfSide + 25, 40, 30, false));
      spaces.push(createSpace(`retail_f${i}`, 'RETAIL', 'Retail', i,
        -halfSide + 40, 0, 50, 40, false));
    } else {
      // Residential - use calculated dimensions from area
      const unitsPerFloor = Math.ceil(totalUnits / (numFloors - 1));
      let xPos = -halfSide + 25;
      let northSide = true;

      for (const unit of units.slice(0, unitsPerFloor)) {
        const unitWidth = Math.sqrt((unit.area_sf || 700) * 1.2);
        const unitHeight = (unit.area_sf || 700) / unitWidth;
        const yPos = northSide ? -unitHeight / 2 - 5 : unitHeight / 2 + 5;

        spaces.push(createSpace(
          `unit_${unit.type}_f${i}`,
          'DWELLING_UNIT',
          `${unit.type}`,
          i, xPos + unitWidth / 2, yPos, unitWidth, unitHeight, false
        ));
        xPos += unitWidth + 5;
        if (xPos > halfSide - 25) {
          xPos = -halfSide + 25;
          northSide = !northSide;
        }
      }
    }

    // CENTER-ORIGIN boundary
    floors.push({
      floor_index: i,
      floor_type: floorType,
      boundary: [
        [-halfSide, -halfSide],
        [halfSide, -halfSide],
        [halfSide, halfSide],
        [-halfSide, halfSide],
      ],
      area_sf: floorPlateArea,
      spaces,
    });
  }

  const totalSpaces = floors.reduce((sum, f) => sum + f.spaces.length, 0);

  return {
    success: true,
    obstruction: 0,
    iterations: 1,
    message: 'Generated from legacy extraction data',
    violations: [],
    metrics: {
      placement_rate: '100.0%',
      avg_membership: '1.00',
      total_spaces: totalSpaces,
      placed_spaces: totalSpaces,
    },
    building: {
      floors,
      stalks: [],
      metrics: {
        total_floors: floors.length,
        total_spaces: totalSpaces,
        cohomology_obstruction: 0,
      },
    },
  };
}

function createSpace(
  id: string,
  type: string,
  name: string,
  floorIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
  isVertical: boolean
): SpaceData {
  const area = width * height;
  return {
    id,
    type,
    name,
    floor_index: floorIndex,
    geometry: {
      x,
      y,
      width,
      height,
      rotation: 0,
    },
    target_area_sf: area,
    actual_area_sf: area,
    membership: 1.0,
    area_deviation: '+0.0%',
    is_vertical: isVertical,
  };
}
