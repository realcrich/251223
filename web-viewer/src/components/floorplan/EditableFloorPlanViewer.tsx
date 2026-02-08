/**
 * Editable floor plan viewer with vertex editing support
 * Supports pan and zoom navigation
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { FloorData, SpaceData, isPolygonGeometry, rectToPolygon } from '../../types/solverOutput';
import { getSpaceColor } from '../../constants/colors';
import {
  getFloorBounds,
  createSvgTransform,
  boundaryToSvgPoints,
  worldToSvg,
} from '../../utils/geometry';
import { PolygonEditor } from '../editor/PolygonEditor';
import { EditMode } from '../../hooks/usePolygonEditor';

interface EditableSpaceData extends SpaceData {
  editableVertices?: [number, number][];
  hasChanges?: boolean;
  hasCollision?: boolean;
}

interface EditableFloorPlanViewerProps {
  floor: FloorData;
  editableSpaces?: EditableSpaceData[];
  selectedSpaceId: string | null;
  editMode: EditMode;
  onSpaceClick: (space: SpaceData) => void;
  onVertexMove?: (spaceId: string, vertexIndex: number, x: number, y: number) => void;
  onVertexRemove?: (spaceId: string, vertexIndex: number) => void;
  onVertexAdd?: (spaceId: string, edgeIndex: number) => void;
  onSpaceMove?: (spaceId: string, dx: number, dy: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  scale?: number;
  showLabels?: boolean;
}

export const EditableFloorPlanViewer: React.FC<EditableFloorPlanViewerProps> = ({
  floor,
  editableSpaces,
  selectedSpaceId,
  editMode,
  onSpaceClick,
  onVertexMove,
  onVertexRemove,
  onVertexAdd,
  onSpaceMove,
  onDragStart,
  onDragEnd,
  scale = 3,
  showLabels = true,
}) => {
  const bounds = getFloorBounds(floor);
  const transform = createSvgTransform(bounds, scale, 30);
  const svgRef = useRef<SVGSVGElement>(null);

  // Pan and zoom state
  const [viewBox, setViewBox] = useState({
    x: 0,
    y: 0,
    width: transform.svgWidth,
    height: transform.svgHeight,
  });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [zoomLevel, setZoomLevel] = useState(1);

  // Handle mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.5, Math.min(5, zoomLevel * zoomFactor));

    // Get mouse position relative to SVG
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate zoom point in viewBox coordinates
    const zoomPointX = viewBox.x + (mouseX / rect.width) * viewBox.width;
    const zoomPointY = viewBox.y + (mouseY / rect.height) * viewBox.height;

    const newWidth = transform.svgWidth / newZoom;
    const newHeight = transform.svgHeight / newZoom;

    // Adjust viewBox to zoom toward mouse position
    const newX = zoomPointX - (mouseX / rect.width) * newWidth;
    const newY = zoomPointY - (mouseY / rect.height) * newHeight;

    setZoomLevel(newZoom);
    setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
  }, [viewBox, zoomLevel, transform]);

  // Handle pan start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start panning with middle mouse button or when holding space
    // Or when in select mode
    if (e.button === 1 || editMode === 'select') {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  }, [editMode]);

  // Handle pan move
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;

    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - panStart.x) * (viewBox.width / rect.width);
    const dy = (e.clientY - panStart.y) * (viewBox.height / rect.height);

    setViewBox(prev => ({
      ...prev,
      x: prev.x - dx,
      y: prev.y - dy,
    }));
    setPanStart({ x: e.clientX, y: e.clientY });
  }, [isPanning, panStart, viewBox]);

  // Handle pan end
  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Reset view
  const resetView = useCallback(() => {
    setZoomLevel(1);
    setViewBox({
      x: 0,
      y: 0,
      width: transform.svgWidth,
      height: transform.svgHeight,
    });
  }, [transform]);

  // Button zoom — zoom toward center of current view
  const zoomBy = useCallback((factor: number) => {
    const newZoom = Math.max(0.5, Math.min(5, zoomLevel * factor));
    const cx = viewBox.x + viewBox.width / 2;
    const cy = viewBox.y + viewBox.height / 2;
    const newWidth = transform.svgWidth / newZoom;
    const newHeight = transform.svgHeight / newZoom;
    setZoomLevel(newZoom);
    setViewBox({ x: cx - newWidth / 2, y: cy - newHeight / 2, width: newWidth, height: newHeight });
  }, [viewBox, zoomLevel, transform]);

  // Use editable spaces if provided, otherwise use floor.spaces
  const spaces = useMemo(() => {
    if (editableSpaces && editableSpaces.length > 0) {
      return editableSpaces.filter(s => s.floor_index === floor.floor_index);
    }
    return floor.spaces;
  }, [editableSpaces, floor]);

  // Separate vertical and non-vertical spaces
  const nonVerticalSpaces = spaces.filter(s => !s.is_vertical);
  const verticalSpaces = spaces.filter(s => s.is_vertical);

  // Check if we're in vertex editing mode or move mode
  const isEditingVertices = editMode === 'vertex';
  const isMoveMode = editMode === 'move';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Zoom controls */}
      <div style={{
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        <button
          onClick={() => zoomBy(1.25)}
          style={zoomButtonStyle}
          title="Zoom In"
        >+</button>
        <button
          onClick={() => zoomBy(0.8)}
          style={zoomButtonStyle}
          title="Zoom Out"
        >−</button>
        <button
          onClick={resetView}
          style={zoomButtonStyle}
          title="Reset View"
        >⌂</button>
      </div>

      {/* Zoom level indicator */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        right: 10,
        zIndex: 10,
        background: 'rgba(45, 45, 63, 0.9)',
        color: '#a0a0b0',
        padding: '4px 8px',
        borderRadius: 4,
        fontSize: 11,
      }}>
        {Math.round(zoomLevel * 100)}%
      </div>

    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      style={{
        border: '1px solid #333',
        background: '#1e1e2e',
        cursor: isPanning ? 'grabbing' : (editMode === 'select' ? 'grab' : 'default'),
      }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Background */}
      <rect
        x={0}
        y={0}
        width={transform.svgWidth}
        height={transform.svgHeight}
        fill="#1e1e2e"
      />

      {/* Floor boundary */}
      <path
        d={boundaryToSvgPoints(floor.boundary, transform)}
        fill="#2d2d3f"
        stroke="#4a4a5a"
        strokeWidth={2}
      />

      {/* Non-vertical spaces (draw first) */}
      {nonVerticalSpaces.map(space => (
        <EditableSpace
          key={space.id}
          space={space as EditableSpaceData}
          transform={transform}
          isSelected={space.id === selectedSpaceId}
          isVertical={false}
          showLabel={showLabels}
          isEditMode={isEditingVertices && space.id === selectedSpaceId}
          isMoveMode={isMoveMode && space.id === selectedSpaceId}
          zoomLevel={zoomLevel}
          onClick={() => onSpaceClick(space)}
          onVertexMove={onVertexMove}
          onVertexRemove={onVertexRemove}
          onVertexAdd={onVertexAdd}
          onSpaceMove={onSpaceMove}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ))}

      {/* Vertical spaces (draw on top) */}
      {verticalSpaces.map(space => (
        <EditableSpace
          key={space.id}
          space={space as EditableSpaceData}
          transform={transform}
          isSelected={space.id === selectedSpaceId}
          isVertical={true}
          showLabel={showLabels}
          isEditMode={isEditingVertices && space.id === selectedSpaceId}
          isMoveMode={isMoveMode && space.id === selectedSpaceId}
          zoomLevel={zoomLevel}
          onClick={() => onSpaceClick(space)}
          onVertexMove={onVertexMove}
          onVertexRemove={onVertexRemove}
          onVertexAdd={onVertexAdd}
          onSpaceMove={onSpaceMove}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ))}

      {/* Edit mode indicator */}
      {isEditingVertices && selectedSpaceId && (
        <text
          x={viewBox.x + 10}
          y={viewBox.y + 20}
          fontSize={11}
          fill="#7c3aed"
          fontWeight="bold"
        >
          EDIT MODE: Drag vertices to reshape
        </text>
      )}
    </svg>
    </div>
  );
};

// Zoom button style
const zoomButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  background: '#2d2d3f',
  color: '#fff',
  border: '1px solid #4a4a5a',
  borderRadius: 4,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 16,
  fontWeight: 'bold',
};

interface EditableSpaceProps {
  space: EditableSpaceData;
  transform: ReturnType<typeof createSvgTransform>;
  isSelected: boolean;
  isVertical: boolean;
  showLabel: boolean;
  isEditMode: boolean;
  isMoveMode?: boolean;
  zoomLevel?: number;
  onClick: () => void;
  onVertexMove?: (spaceId: string, vertexIndex: number, x: number, y: number) => void;
  onVertexRemove?: (spaceId: string, vertexIndex: number) => void;
  onVertexAdd?: (spaceId: string, edgeIndex: number) => void;
  onSpaceMove?: (spaceId: string, dx: number, dy: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

const EditableSpace: React.FC<EditableSpaceProps> = ({
  space,
  transform,
  isSelected,
  isVertical,
  showLabel,
  isEditMode,
  isMoveMode = false,
  zoomLevel = 1,
  onClick,
  onVertexMove,
  onVertexRemove,
  onVertexAdd,
  onSpaceMove,
  onDragStart,
  onDragEnd,
}) => {
  const [isHovered, setIsHovered] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragStart, setDragStart] = React.useState<{ x: number; y: number } | null>(null);
  const color = getSpaceColor(space.type);
  const geometry = space.geometry;

  // Handle polygon drag for move mode
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMoveMode && isSelected) {
      e.stopPropagation();
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      onDragStart?.();
    }
  }, [isMoveMode, isSelected, onDragStart]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragStart && onSpaceMove) {
      e.stopPropagation();
      // Calculate delta in world coordinates
      const dx = (e.clientX - dragStart.x) / transform.scale;
      const dy = -(e.clientY - dragStart.y) / transform.scale; // Invert Y for world coords
      onSpaceMove(space.id, dx, dy);
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  }, [isDragging, dragStart, onSpaceMove, space.id, transform.scale]);

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      setDragStart(null);
      onDragEnd?.();
    }
  }, [isDragging, onDragEnd]);

  // Handle global mouse up to end drag
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => handleMouseUp();
      window.addEventListener('mouseup', handleGlobalMouseUp);
      return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }
  }, [isDragging, handleMouseUp]);
  
  // Auto-hide labels when zoomed out too far
  const shouldShowLabel = showLabel && (zoomLevel >= 0.7 || isSelected || isHovered);

  // Get vertices for rendering and editing
  const vertices = useMemo(() => {
    if (space.editableVertices) {
      return space.editableVertices;
    }
    if (isPolygonGeometry(geometry)) {
      return geometry.vertices;
    }
    return rectToPolygon(geometry);
  }, [space.editableVertices, geometry]);

  // Convert vertices to SVG path
  const pathD = useMemo(() => {
    return vertices
      .map((v, i) => {
        const svg = worldToSvg(v[0], v[1], transform);
        return `${i === 0 ? 'M' : 'L'}${svg.x},${svg.y}`;
      })
      .join(' ') + ' Z';
  }, [vertices, transform]);

  // Get center for label
  const center = useMemo(() => {
    const xs = vertices.map(v => v[0]);
    const ys = vertices.map(v => v[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return worldToSvg(cx, cy, transform);
  }, [vertices, transform]);

  // Determine stroke style based on hover/selection state
  const strokeColor = space.hasCollision
    ? '#ef4444' // Red for collision
    : isSelected
    ? '#7c3aed' // Purple when selected
    : isHovered
    ? '#a78bfa' // Light purple on hover
    : '#4a4a5a'; // Default dark

  const strokeWidth = isSelected ? 2.5 : isHovered ? 2 : 1;
  
  // Glow filter for hover/selected state
  const glowFilter = (isHovered || isSelected) ? 'url(#space-glow)' : undefined;

  return (
    <g
      style={{ cursor: isMoveMode && isSelected ? (isDragging ? 'grabbing' : 'grab') : 'pointer' }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { setIsHovered(false); if (!isDragging) handleMouseUp(); }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Glow filter definition */}
      <defs>
        <filter id="space-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Space shape */}
      <path
        d={pathD}
        fill={color}
        fillOpacity={isSelected ? 1 : isHovered ? 0.95 : 0.85}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={isVertical ? '4,2' : undefined}
        onClick={onClick}
        filter={glowFilter}
        style={{
          transition: 'fill-opacity 0.15s ease, stroke 0.15s ease, stroke-width 0.15s ease',
        }}
      />

      {/* Label with background pill */}
      {shouldShowLabel && (
        <g pointerEvents="none">
          {/* Background pill */}
          <rect
            x={center.x - (Math.min(space.name.length, 15) * 3.5) - 6}
            y={center.y - 8}
            width={Math.min(space.name.length, 15) * 7 + 12}
            height={16}
            rx={8}
            ry={8}
            fill="rgba(0, 0, 0, 0.6)"
            style={{ transition: 'opacity 0.15s ease' }}
          />
          {/* Label text */}
          <text
            x={center.x}
            y={center.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={isHovered || isSelected ? 10 : 9}
            fill="#fff"
            fontWeight={isSelected ? 'bold' : isHovered ? '600' : 'normal'}
            style={{ 
              transition: 'font-size 0.15s ease, opacity 0.15s ease',
            }}
          >
            {space.name.length > 15 ? space.name.slice(0, 15) + '...' : space.name}
          </text>
        </g>
      )}

      {/* Change indicator */}
      {space.hasChanges && (
        <circle
          cx={center.x + 20}
          cy={center.y - 10}
          r={4}
          fill="#f59e0b"
          stroke="#fff"
          strokeWidth={1}
        />
      )}

      {/* Collision warning */}
      {space.hasCollision && (
        <text
          x={center.x}
          y={center.y + 12}
          textAnchor="middle"
          fontSize={8}
          fill="#ef4444"
          fontWeight="bold"
          pointerEvents="none"
        >
          ⚠ OVERLAP
        </text>
      )}

      {/* Polygon editor overlay when in edit mode */}
      {isEditMode && (
        <PolygonEditor
          vertices={vertices}
          transform={transform}
          isSelected={true}
          showVertexHandles={true}
          showEdgeHandles={true}
          onVertexMove={(vertexIndex, x, y) =>
            onVertexMove?.(space.id, vertexIndex, x, y)
          }
          onVertexRemove={(vertexIndex) =>
            onVertexRemove?.(space.id, vertexIndex)
          }
          onEdgeAddVertex={(edgeIndex) =>
            onVertexAdd?.(space.id, edgeIndex)
          }
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      )}
    </g>
  );
};

export default EditableFloorPlanViewer;
