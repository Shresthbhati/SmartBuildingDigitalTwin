import type { LayoutFloor } from './layout';
import './FloorSelector.css';

interface FloorSelectorProps {
  activeFloor: number;
  onFloorChange: (floor: number) => void;
  floors: LayoutFloor[];
}

export function FloorSelector({ activeFloor, onFloorChange, floors }: FloorSelectorProps) {
  return (
    <div className="floor-selector" role="tablist" aria-label="Building floors">
      {floors
        .slice()
        .sort((a, b) => b.level - a.level)
        .map(floor => (
          <button
            key={floor.level}
            role="tab"
            aria-selected={activeFloor === floor.level}
            className={`floor-btn ${activeFloor === floor.level ? 'active' : ''}`}
            onClick={() => onFloorChange(floor.level)}
          >
            <span className="floor-level">F{floor.level}</span>
            <span className="floor-name">{floor.name}</span>
          </button>
        ))}
    </div>
  );
}
