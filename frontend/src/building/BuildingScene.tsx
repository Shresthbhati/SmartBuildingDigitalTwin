import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { BuildingStructure } from './BuildingStructure';
import { RoomMarker } from './RoomMarker';
import { FloorSelector } from './FloorSelector';
import { RoomInspectionPanel } from './RoomInspectionPanel';
import { Legend } from './Legend';
import {
  convertBuildingLayout,
  getAllRooms,
  getRoomsByFloor,
  type LayoutRoom,
  type LayoutFloor,
  type LayoutBuilding,
} from './layout';
import type { RoomTelemetryState } from './state';
import { getRoomVisualState, VISUAL_STATE_COLORS, ROOM_OPACITY } from './state';
import { sensorApi, layoutApi } from '../api/client';
import type { LatestDataResponse, SensorReading, AggregateBucket } from '../types';
import './BuildingScene.css';

interface BuildingSceneProps {
  latestData: LatestDataResponse[];
  onRoomSelect: (roomId: string | null) => void;
  selectedRoomId: string | null;
  timeRange: { start: string; end: string; interval: string };
  useAggregate: boolean;
  activeAlertRooms: Set<string>;
}

export function BuildingScene({
  latestData,
  onRoomSelect,
  selectedRoomId,
  timeRange,
  useAggregate,
}: BuildingSceneProps) {
  const [roomsTelemetry, setRoomsTelemetry] = useState<Map<string, RoomTelemetryState>>(new Map());
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutBuilding | null>(null);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const handleCameraChange = useCallback(() => {
    // Camera change handler - can be used for viewport sync if needed
  }, []);

  const resetCamera = useCallback(() => {
    if (cameraRef.current) {
      cameraRef.current.position.set(15, 12, 15);
      cameraRef.current.lookAt(10, 4, 7.5);
      handleCameraChange();
    }
  }, [handleCameraChange]);

  const fitToView = useCallback(() => {
    if (cameraRef.current && layout) {
      const bounds = new THREE.Box3();
      const allRooms = getAllRooms(layout.floors.flatMap(f => f.rooms));
      allRooms.forEach((room: LayoutRoom) => {
        const [x, y, z] = room.position;
        const [w, h, d] = room.size;
        bounds.expandByPoint(new THREE.Vector3(x - w / 2, y, z - d / 2));
        bounds.expandByPoint(new THREE.Vector3(x + w / 2, y + h, z + d / 2));
      });
      if (!bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = cameraRef.current.fov * (Math.PI / 180);
        let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        cameraZ *= 1.5;
        cameraRef.current.position.set(center.x, center.y + cameraZ, center.z + cameraZ);
        cameraRef.current.lookAt(center.x, center.y, center.z);
        handleCameraChange();
      }
    }
  }, [layout, handleCameraChange]);

  // Fetch building layout from backend
  useEffect(() => {
    let mounted = true;

    async function fetchLayout() {
      try {
        const backendLayout = await layoutApi.getLayout();
        if (mounted) {
          setLayout(convertBuildingLayout(backendLayout));
        }
      } catch (err) {
        console.error('Failed to fetch building layout:', err);
        if (mounted) {
          setError('Failed to load building layout');
          setIsLoading(false);
        }
      }
    }

    fetchLayout();

    return () => {
      mounted = false;
    };
  }, []);

  // Fetch telemetry data
  useEffect(() => {
    if (!layout) return;

    let mounted = true;
    const rooms = getAllRooms(layout.floors.flatMap(f => f.rooms));

    async function fetchTelemetry() {
      if (!mounted) return;
      try {
        const newTelemetry = new Map<string, RoomTelemetryState>();
        const latestDataMap = new Map(latestData.map(d => [d.room, d]));

        for (const room of rooms) {
          const latest = latestDataMap.get(room.id);
          let history: SensorReading[] = [];
          let aggregate: AggregateBucket[] = [];

          if (!useAggregate) {
            try {
              const historyRes = await sensorApi.getRoomHistory(room.id, {
                start: timeRange.start,
                end: timeRange.end,
                limit: 500,
              });
              history = historyRes.readings;
            } catch (err) {
              console.error(`Failed to fetch history for ${room.id}:`, err);
            }
          } else {
            try {
              const sensorId = room.sensorId || `temp-sensor-${room.id.slice(-3)}`;
              const agg = await sensorApi.getAggregate({
                room: room.id,
                sensor_id: sensorId,
                start: timeRange.start,
                end: timeRange.end,
                interval: timeRange.interval,
              });
              aggregate = agg.buckets;
            } catch (err) {
              console.error(`Failed to fetch aggregate for ${room.id}:`, err);
            }
          }

          const status = latest?.status || 'UNKNOWN';
          const temperature = latest?.temperature ?? null;
          const lastUpdated = latest ? new Date().toISOString() : null;
          const source = latest ? 'simulated' : null;

          const isStale =
            latest && lastUpdated ? Date.now() - new Date(lastUpdated).getTime() > 30000 : true;

          newTelemetry.set(room.id, {
            roomId: room.id,
            roomName: room.name,
            floor: room.floor,
            sensorId: room.sensorId,
            currentTemperature: temperature,
            status: status as 'NORMAL' | 'HIGH' | 'ALERT' | 'UNKNOWN',
            lastUpdated: lastUpdated || null,
            source,
            isStale,
            history,
            aggregate,
            loading: false,
            error: null,
          });
        }

        if (mounted) {
          setRoomsTelemetry(newTelemetry);
          setIsLoading(false);
          setError(null);
        }
      } catch {
        if (mounted) {
          setError('Failed to fetch telemetry data');
          setIsLoading(false);
        }
      }
    }

    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 10000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [layout, latestData, timeRange, useAggregate]);

  const handleRoomClick = useCallback(
    (roomId: string) => {
      onRoomSelect(roomId);
    },
    [onRoomSelect]
  );

  const handleRoomHover = useCallback((roomId: string | null) => {
    setHoveredRoomId(roomId);
  }, []);

  const getRoomColor = useCallback(
    (roomId: string): string => {
      const room = roomsTelemetry.get(roomId);
      if (!room) return VISUAL_STATE_COLORS.unknown;

      if (selectedRoomId === roomId) return VISUAL_STATE_COLORS.selected;
      if (hoveredRoomId === roomId) return VISUAL_STATE_COLORS.hovered;

      const visualState = getRoomVisualState(room);
      return VISUAL_STATE_COLORS[visualState];
    },
    [roomsTelemetry, selectedRoomId, hoveredRoomId]
  );

  const getRoomOpacity = useCallback(
    (roomId: string): number => {
      const room = roomsTelemetry.get(roomId);
      if (!room) return ROOM_OPACITY.unknown;

      if (selectedRoomId === roomId) return ROOM_OPACITY.selected;
      if (hoveredRoomId === roomId) return ROOM_OPACITY.hovered;

      const visualState = getRoomVisualState(room);
      return ROOM_OPACITY[visualState];
    },
    [roomsTelemetry, selectedRoomId, hoveredRoomId]
  );

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (
        canvasRef.current &&
        cameraRef.current &&
        cameraRef.current instanceof THREE.PerspectiveCamera
      ) {
        const width = canvasRef.current.clientWidth;
        const height = canvasRef.current.clientHeight;
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // WebGL context loss handling
  useEffect(() => {
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      console.warn('WebGL context lost');
      setError('WebGL context lost. Please reload the page.');
    };

    const handleContextRestored = () => {
      console.log('WebGL context restored');
      setError(null);
      // Re-initialize scene would be needed here in a full implementation
    };

    const canvas = document.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('webglcontextlost', handleContextLost);
      canvas.addEventListener('webglcontextrestored', handleContextRestored);
    }

    return () => {
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      }
    };
  }, []);

  if (isLoading && roomsTelemetry.size === 0) {
    return (
      <div className="building-scene loading" ref={canvasRef}>
        <div className="loading-spinner" />
        <p>Loading 3D building...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="building-scene error" ref={canvasRef}>
        <p>Error: {error}</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }

  if (!layout) {
    return (
      <div className="building-scene loading" ref={canvasRef}>
        <div className="loading-spinner" />
        <p>Loading building layout...</p>
      </div>
    );
  }

  const floorRooms = getRoomsByFloor(
    layout.floors.flatMap(f => f.rooms),
    activeFloor
  );
  const floorsForSelector = layout.floors.map(f => ({
    level: f.level,
    name: f.name,
    height: f.height,
    rooms: f.rooms.map(r => ({ ...r })),
  }));

  return (
    <div className="building-scene" ref={canvasRef}>
      <div className="scene-header">
        <h2>Digital Twin - 3D Building</h2>
        <div className="scene-controls">
          <FloorSelector
            activeFloor={activeFloor}
            onFloorChange={setActiveFloor}
            floors={floorsForSelector as LayoutFloor[]}
          />
          <div className="camera-controls">
            <button onClick={resetCamera} title="Reset Camera">
              Reset View
            </button>
            <button onClick={fitToView} title="Fit Building to View">
              Fit View
            </button>
          </div>
        </div>
      </div>

      <div className="canvas-container">
        <Canvas
          camera={{ position: [15, 12, 15], fov: 50 }}
          onCreated={({ camera, gl }) => {
            if (camera instanceof THREE.PerspectiveCamera) {
              cameraRef.current = camera;
            }
            // Configure renderer for better quality
            gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
          }}
          style={{ width: '100%', height: '100%', touchAction: 'none' }}
        >
          <PerspectiveCamera makeDefault position={[15, 12, 15]} fov={50} ref={cameraRef} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[10, 20, 10]} intensity={0.8} castShadow />
          <directionalLight position={[-10, 20, -10]} intensity={0.4} />

          <OrbitControls
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minPolarAngle={0}
            maxPolarAngle={Math.PI / 2 - 0.05}
            minZoom={0.5}
            maxZoom={10}
            target={[10, 4, 7.5]}
            onChange={handleCameraChange}
          />

          <BuildingStructure
            rooms={floorRooms}
            activeFloor={activeFloor}
            layout={layout}
            getRoomColor={getRoomColor}
            getRoomOpacity={getRoomOpacity}
            onRoomClick={handleRoomClick}
            onRoomHover={handleRoomHover}
            selectedRoomId={selectedRoomId}
            hoveredRoomId={hoveredRoomId}
          />

          {roomsTelemetry.size > 0 && (
            <>
              {floorRooms.map((room: LayoutRoom) => {
                const telemetry = roomsTelemetry.get(room.id);
                const color = getRoomColor(room.id);
                const opacity = getRoomOpacity(room.id);
                const hasActiveAlert = activeAlertRooms.has(room.id);
                return (
                  <RoomMarker
                    key={room.id}
                    room={room}
                    telemetry={telemetry}
                    color={color}
                    opacity={opacity}
                    isSelected={selectedRoomId === room.id}
                    isHovered={hoveredRoomId === room.id}
                    hasActiveAlert={hasActiveAlert}
                    onClick={() => handleRoomClick(room.id)}
                    onHover={() => handleRoomHover(room.id)}
                    onLeave={() => handleRoomHover(null)}
                  />
                );
              })}
            </>
          )}

          <GridGround
            size={layout.dimensions.width}
            divisions={1}
            colorCenterLine="#0f172a"
            colorGrid="#1e293b"
            position={[layout.dimensions.width / 2, 0, layout.dimensions.depth / 2]}
          />
        </Canvas>

        <div className="scene-overlay">
          <Legend roomsTelemetry={roomsTelemetry} selectedRoomId={selectedRoomId} />
        </div>
      </div>

      {selectedRoomId && roomsTelemetry.has(selectedRoomId) && (
        <RoomInspectionPanel
          roomTelemetry={roomsTelemetry.get(selectedRoomId)!}
          onClose={() => onRoomSelect(null)}
          timeRange={timeRange}
          useAggregate={useAggregate}
        />
      )}
    </div>
  );
}

function GridGround({
  size = 20,
  divisions = 1,
  colorCenterLine = '#0f172a',
  colorGrid = '#1e293b',
  position = [0, 0, 0],
}: {
  size?: number;
  divisions?: number;
  colorCenterLine?: string;
  colorGrid?: string;
  position?: [number, number, number];
}) {
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const gridHelper = new THREE.GridHelper(size, divisions, colorCenterLine, colorGrid);
    group.add(gridHelper);
    return () => {
      group.remove(gridHelper);
      gridHelper.geometry.dispose();
      if (Array.isArray(gridHelper.material)) {
        gridHelper.material.forEach(m => m.dispose());
      } else {
        gridHelper.material.dispose();
      }
    };
  }, [size, divisions, colorCenterLine, colorGrid]);

  return <group ref={groupRef} position={position} />;
}
