import type { BuildingRoom, BuildingFloor, BuildingLayout } from '../types';

export interface LayoutRoom extends BuildingRoom {
  position: [number, number, number];
  size: [number, number, number];
  sensorId?: string;
}

export interface LayoutFloor extends BuildingFloor {
  rooms: LayoutRoom[];
}

export interface LayoutBuilding extends BuildingLayout {
  floors: LayoutFloor[];
}

export function convertBuildingRoom(room: BuildingRoom): LayoutRoom {
  return {
    ...room,
    position: [room.position_x, room.position_y, room.position_z],
    size: [room.size_x, room.size_y, room.size_z],
    sensorId: room.sensor_id || undefined,
  };
}

export function convertBuildingFloor(floor: BuildingFloor): LayoutFloor {
  return {
    ...floor,
    rooms: floor.rooms.map(convertBuildingRoom),
  };
}

export function convertBuildingLayout(layout: BuildingLayout): LayoutBuilding {
  return {
    ...layout,
    floors: layout.floors.map(convertBuildingFloor),
  };
}

export function getRoomById(rooms: LayoutRoom[], roomId: string): LayoutRoom | undefined {
  return rooms.find(r => r.id === roomId);
}

export function getRoomsByFloor(rooms: LayoutRoom[], floorLevel: number): LayoutRoom[] {
  return rooms.filter(r => r.floor === floorLevel);
}

export function getAllRooms(rooms: LayoutRoom[]): LayoutRoom[] {
  return rooms;
}

export function getRoomSensorId(rooms: LayoutRoom[], roomId: string): string | undefined {
  const room = getRoomById(rooms, roomId);
  return room?.sensorId;
}
