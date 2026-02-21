/**
 * Hook for floor navigation state
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { FloorData } from '../types/solverOutput';

interface UseFloorNavigationResult {
  currentFloorIndex: number;
  currentFloor: FloorData | null;
  floorIndices: number[];
  goToFloor: (index: number) => void;
  nextFloor: () => void;
  prevFloor: () => void;
}

export const useFloorNavigation = (
  floors: FloorData[] | undefined
): UseFloorNavigationResult => {
  // Sort floors by index (highest first for typical building view)
  const sortedFloors = useMemo(() => 
    floors ? [...floors].sort((a, b) => b.floor_index - a.floor_index) : [],
    [floors]
  );

  const floorIndices = useMemo(() => 
    sortedFloors.map(f => f.floor_index),
    [sortedFloors]
  );

  // Prefer floor 1 (first residential) as default
  const defaultFloor = useMemo(() => {
    if (sortedFloors.length === 0) return 0;
    const floor1 = sortedFloors.find(f => f.floor_index === 1);
    return floor1 ? 1 : sortedFloors[0].floor_index;
  }, [sortedFloors]);

  const [currentFloorIndex, setCurrentFloorIndex] = useState<number>(0);
  const [initialized, setInitialized] = useState(false);

  // Get current floor data
  const currentFloor = useMemo(() =>
    sortedFloors.find(f => f.floor_index === currentFloorIndex) || null,
    [sortedFloors, currentFloorIndex]
  );

  // Jump to floor 1 when data first loads, or reset if current floor is invalid
  useEffect(() => {
    if (sortedFloors.length > 0) {
      if (!initialized) {
        setCurrentFloorIndex(defaultFloor);
        setInitialized(true);
      } else if (!floorIndices.includes(currentFloorIndex)) {
        setCurrentFloorIndex(defaultFloor);
      }
    }
  }, [sortedFloors, floorIndices, currentFloorIndex, defaultFloor, initialized]);

  const goToFloor = useCallback((index: number) => {
    if (floorIndices.includes(index)) {
      setCurrentFloorIndex(index);
    }
  }, [floorIndices]);

  const nextFloor = useCallback(() => {
    const currentPos = floorIndices.indexOf(currentFloorIndex);
    if (currentPos < floorIndices.length - 1) {
      setCurrentFloorIndex(floorIndices[currentPos + 1]);
    }
  }, [currentFloorIndex, floorIndices]);

  const prevFloor = useCallback(() => {
    const currentPos = floorIndices.indexOf(currentFloorIndex);
    if (currentPos > 0) {
      setCurrentFloorIndex(floorIndices[currentPos - 1]);
    }
  }, [currentFloorIndex, floorIndices]);

  // Keyboard navigation removed - handled in App.tsx

  return {
    currentFloorIndex,
    currentFloor,
    floorIndices,
    goToFloor,
    nextFloor,
    prevFloor,
  };
};
