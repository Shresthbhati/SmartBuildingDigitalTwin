import { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { LayoutRoom, LayoutBuilding } from './layout';

type ThreeGroup = THREE.Group;

interface BuildingStructureProps {
  rooms: LayoutRoom[];
  activeFloor: number;
  layout: LayoutBuilding | null;
  getRoomColor: (roomId: string) => string;
  getRoomOpacity: (roomId: string) => number;
  onRoomClick: (roomId: string) => void;
  onRoomHover: (roomId: string | null) => void;
  selectedRoomId: string | null;
  hoveredRoomId: string | null;
}

// Singleton pattern for shared resources
const sharedResources = {
  boxGeometry: null as THREE.BoxGeometry | null,
  floorMaterial: null as THREE.MeshStandardMaterial | null,
  wallMaterial: null as THREE.MeshStandardMaterial | null,
  init() {
    if (!this.boxGeometry) {
      this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    }
    if (!this.floorMaterial) {
      this.floorMaterial = new THREE.MeshStandardMaterial({
        color: '#1e293b',
        transparent: true,
        opacity: 0.9,
        roughness: 0.8,
        metalness: 0.1,
      });
    }
    if (!this.wallMaterial) {
      this.wallMaterial = new THREE.MeshStandardMaterial({
        color: '#334155',
        roughness: 0.7,
        metalness: 0.2,
        transparent: true,
        opacity: 0.7,
      });
    }
  },
  dispose() {
    if (this.boxGeometry) {
      this.boxGeometry.dispose();
      this.boxGeometry = null;
    }
    if (this.floorMaterial) {
      this.floorMaterial.dispose();
      this.floorMaterial = null;
    }
    if (this.wallMaterial) {
      this.wallMaterial.dispose();
      this.wallMaterial = null;
    }
  },
};

// Initialize on module load
sharedResources.init();

export function BuildingStructure({
  rooms,
  activeFloor,
  layout,
  getRoomColor,
  getRoomOpacity,
  onRoomClick,
  onRoomHover,
  selectedRoomId,
  hoveredRoomId,
}: BuildingStructureProps) {
  const groupRef = useRef<ThreeGroup>(null);
  const materialsRef = useRef<Map<string, THREE.MeshStandardMaterial>>(new Map());

  // Cleanup materials on unmount
  useEffect(() => {
    return () => {
      materialsRef.current.forEach(material => {
        material.dispose();
      });
      materialsRef.current.clear();
    };
  }, []);

  const buildingWidth = layout?.dimensions.width ?? 20;
  const buildingDepth = layout?.dimensions.depth ?? 15;
  const floorHeight = layout?.dimensions.floorHeight ?? 4;

  return (
    <group ref={groupRef}>
      <FloorSlab
        floorLevel={activeFloor}
        width={buildingWidth}
        depth={buildingDepth}
        height={0.2}
      />
      <Walls
        floorHeight={floorHeight}
        wallThickness={0.2}
        width={buildingWidth}
        depth={buildingDepth}
      />
      {rooms.map(room => (
        <RoomBox
          key={room.id}
          room={room}
          color={getRoomColor(room.id)}
          opacity={getRoomOpacity(room.id)}
          isSelected={selectedRoomId === room.id}
          isHovered={hoveredRoomId === room.id}
          onClick={() => onRoomClick(room.id)}
          onHover={() => onRoomHover(room.id)}
          onLeave={() => onRoomHover(null)}
          materialsRef={materialsRef}
        />
      ))}
    </group>
  );
}

function FloorSlab({
  floorLevel,
  width,
  depth,
  height,
}: {
  floorLevel: number;
  width: number;
  depth: number;
  height: number;
}) {
  return (
    <mesh position={[width / 2, floorLevel * 4 - height / 2, depth / 2]} receiveShadow>
      <boxGeometry args={[width, height, depth]} />
      <meshStandardMaterial
        color="#1e293b"
        transparent
        opacity={0.9}
        roughness={0.8}
        metalness={0.1}
      />
    </mesh>
  );
}

function Walls({
  floorHeight,
  wallThickness,
  width,
  depth,
}: {
  floorHeight: number;
  wallThickness: number;
  width: number;
  depth: number;
}) {
  return (
    <group>
      <mesh position={[width / 2, floorHeight / 2, -wallThickness / 2]} castShadow receiveShadow>
        <boxGeometry args={[width, floorHeight, wallThickness]} />
        <meshStandardMaterial
          color="#334155"
          roughness={0.7}
          metalness={0.2}
          transparent
          opacity={0.7}
        />
      </mesh>
      <mesh
        position={[width / 2, floorHeight / 2, depth + wallThickness / 2]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[width, floorHeight, wallThickness]} />
        <meshStandardMaterial
          color="#334155"
          roughness={0.7}
          metalness={0.2}
          transparent
          opacity={0.7}
        />
      </mesh>
      <mesh position={[-wallThickness / 2, floorHeight / 2, depth / 2]} castShadow receiveShadow>
        <boxGeometry args={[wallThickness, floorHeight, depth]} />
        <meshStandardMaterial
          color="#334155"
          roughness={0.7}
          metalness={0.2}
          transparent
          opacity={0.7}
        />
      </mesh>
      <mesh
        position={[width + wallThickness / 2, floorHeight / 2, depth / 2]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[wallThickness, floorHeight, depth]} />
        <meshStandardMaterial
          color="#334155"
          roughness={0.7}
          metalness={0.2}
          transparent
          opacity={0.7}
        />
      </mesh>
    </group>
  );
}

interface RoomBoxProps {
  room: LayoutRoom;
  color: string;
  opacity: number;
  isSelected: boolean;
  isHovered: boolean;
  onClick: () => void;
  onHover: () => void;
  onLeave: () => void;
  materialsRef: React.MutableRefObject<Map<string, THREE.MeshStandardMaterial>>;
}

function RoomBox({
  room,
  color,
  opacity,
  isSelected,
  isHovered: _isHovered,
  onClick,
  onHover,
  onLeave,
  materialsRef,
}: RoomBoxProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [isHoveredLocal, setIsHoveredLocal] = useState(false);

  // Get or create material for this room (cached by room ID + color + opacity + selected/hovered state)
  const materialKey = `${room.id}-${color}-${opacity}-${isSelected}-${isHoveredLocal}`;

  useEffect(() => {
    if (meshRef.current) {
      let material = materialsRef.current.get(materialKey);
      if (!material) {
        const materialColor = new THREE.Color(color);
        const emissiveColor =
          isSelected || isHoveredLocal
            ? new THREE.Color(color).multiplyScalar(0.3)
            : new THREE.Color(0x000000);

        material = new THREE.MeshStandardMaterial({
          color: materialColor,
          emissive: emissiveColor,
          emissiveIntensity: isSelected ? 0.5 : isHoveredLocal ? 0.3 : 0,
          transparent: true,
          opacity: opacity,
          roughness: 0.3,
          metalness: 0.2,
        });
        materialsRef.current.set(materialKey, material);
      }
      meshRef.current.material = material;
    }
    return () => {
      // Don't dispose here as material is cached
    };
  }, [color, opacity, isSelected, isHoveredLocal, materialKey, materialsRef]);

  const handlePointerOver = (e: React.PointerEvent) => {
    e.stopPropagation();
    setIsHoveredLocal(true);
    onHover();
  };

  const handlePointerOut = (e: React.PointerEvent) => {
    e.stopPropagation();
    setIsHoveredLocal(false);
    onLeave();
  };

  const handleClick = (e: React.PointerEvent) => {
    e.stopPropagation();
    onClick();
  };

  return (
    <mesh
      ref={meshRef}
      position={[room.position[0], room.position[1] + room.size[1] / 2, room.position[2]]}
      scale={[room.size[0], room.size[1], room.size[2]]}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[1, 1, 1]} />
    </mesh>
  );
}
