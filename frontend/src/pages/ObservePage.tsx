import { BuildingScene } from '../building/BuildingScene';
import { PartialNotice } from '../state/StateViews';
import { useNexus } from '../store';

export function ObservePage() {
  const errors = useNexus(s => s.errors);
  const missing = [
    errors.readings && 'latest readings',
    errors.alerts && 'alerts',
    errors.anomalies && 'anomalies',
  ].filter(Boolean) as string[];
  return (
    <div className="page observe">
      <PartialNotice missing={missing} />
      <BuildingScene />
    </div>
  );
}
