import { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { RoomCard } from './components/RoomCard';
import { ActivityLog } from './components/ActivityLog';
import { TemperatureChart } from './components/TemperatureChart';
import { TimeRangeSelector } from './components/TimeRangeSelector';
import { BuildingScene } from './building/BuildingScene';
import { AlertSummary } from './components/AlertSummary';
import { AlertList } from './components/AlertList';
import { AlertDetail } from './components/AlertDetail';
import { healthApi, sensorApi, activityApi, alertApi } from './api/client';
import type {
  HealthResponse,
  LatestDataResponse,
  RoomHistory,
  ActivityLog as ActivityLogType,
  DetailedHealthResponse,
  AggregateBucket,
  AlertListItem,
  Alert,
} from './types';
import './App.css';

function getDefaultTimeRange() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  return {
    start: oneHourAgo.toISOString().slice(0, 16),
    end: now.toISOString().slice(0, 16),
    interval: '15m',
  };
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [detailedHealth, setDetailedHealth] = useState<DetailedHealthResponse | null>(null);
  const [latestData, setLatestData] = useState<LatestDataResponse[]>([]);
  const [history, setHistory] = useState<RoomHistory[]>([]);
  const [aggregate, setAggregate] = useState<Record<string, AggregateBucket[]>>({});
  const [activityLogs, setActivityLogs] = useState<ActivityLogType[]>([]);
  const [alerts, setAlerts] = useState<AlertListItem[]>([]);
  const [alertCounts, setAlertCounts] = useState<{ total: number; open: number } | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<{ start: string; end: string; interval: string }>(() =>
    getDefaultTimeRange()
  );
  const [useAggregate, setUseAggregate] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'dashboard' | '3d'>('dashboard');

  const activeAlertRooms = new Set(
    alerts.filter(a => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED').map(a => a.room)
  );

  const fetchLatest = useCallback(async () => {
    try {
      const latestRes = await sensorApi.getLatest();
      setLatestData(latestRes);
    } catch (err) {
      console.error('Failed to fetch latest data:', err);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const historyRes = await sensorApi.getAllHistory({
        start: timeRange.start,
        end: timeRange.end,
        limit: 500,
      });
      setHistory(historyRes);
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }, [timeRange.start, timeRange.end]);

  const fetchAggregate = useCallback(async () => {
    try {
      const aggregateData: Record<string, AggregateBucket[]> = {};
      for (const room of latestData.map(r => r.room)) {
        const sensorId = `temp-sensor-${room.slice(-3)}`;
        const agg = await sensorApi.getAggregate({
          room,
          sensor_id: sensorId,
          start: timeRange.start,
          end: timeRange.end,
          interval: timeRange.interval,
        });
        aggregateData[room] = agg.buckets;
      }
      setAggregate(aggregateData);
    } catch (err) {
      console.error('Failed to fetch aggregate:', err);
    }
  }, [latestData, timeRange.start, timeRange.end, timeRange.interval]);

  const fetchActivity = useCallback(async () => {
    try {
      const activityRes = await activityApi.getLogs(20);
      setActivityLogs(activityRes);
    } catch (err) {
      console.error('Failed to fetch activity:', err);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const alertsRes = await alertApi.getAlerts({
        status: 'OPEN',
        limit: 100,
      });
      setAlerts(alertsRes);
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    }
  }, []);

  const fetchAlertCounts = useCallback(async () => {
    try {
      const counts = await alertApi.getAlertCounts();
      setAlertCounts({
        total: counts.total,
        open: counts.by_status.find(s => s.status === 'OPEN')?.count ?? 0,
      });
    } catch (err) {
      console.error('Failed to fetch alert counts:', err);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const [healthRes, detailedRes] = await Promise.all([healthApi.check(), healthApi.detailed()]);
      setHealth(healthRes);
      setDetailedHealth(detailedRes);
    } catch (err) {
      console.error('Failed to fetch health:', err);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    await fetchLatest();
    await Promise.all([fetchActivity(), fetchHealth(), fetchAlerts(), fetchAlertCounts()]);
    if (useAggregate) {
      await fetchAggregate();
    } else {
      await fetchHistory();
    }
  }, [
    fetchLatest,
    fetchActivity,
    fetchHealth,
    fetchHistory,
    fetchAggregate,
    fetchAlerts,
    fetchAlertCounts,
    useAggregate,
  ]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
    setError(null);
  }, [fetchAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchLatest();
      fetchActivity();
      fetchHealth();
      fetchAlerts();
      fetchAlertCounts();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchLatest, fetchActivity, fetchHealth, fetchAlerts, fetchAlertCounts]);

  useEffect(() => {
    if (useAggregate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAggregate();
    } else {
      fetchHistory();
    }
  }, [timeRange, useAggregate, fetchHistory, fetchAggregate]);

  const handleTimeRangeChange = (range: { start: string; end: string; interval: string }) => {
    setTimeRange(range);
  };

  const handleRoomSelect = (roomId: string | null) => {
    setSelectedRoomId(roomId);
  };

  const handleAlertSelect = (alert: AlertListItem) => {
    setSelectedRoomId(alert.room);
    setViewMode('dashboard');
  };

  const handleCloseAlertDetail = () => {
    setSelectedAlert(null);
  };

  const handleAlertUpdated = () => {
    fetchAlerts();
    fetchAlertCounts();
    setSelectedAlert(null);
  };

  return (
    <div className="app">
      <Header health={health} detailedHealth={detailedHealth} />
      <main className="main-content">
        {error && <div className="error-banner">{error}</div>}

        <div className="view-toolbar">
          <div className="view-toggle" role="tablist" aria-label="View mode">
            <button
              role="tab"
              aria-selected={viewMode === 'dashboard'}
              className={`view-btn ${viewMode === 'dashboard' ? 'active' : ''}`}
              onClick={() => setViewMode('dashboard')}
            >
              Dashboard
            </button>
            <button
              role="tab"
              aria-selected={viewMode === '3d'}
              className={`view-btn ${viewMode === '3d' ? 'active' : ''}`}
              onClick={() => setViewMode('3d')}
            >
              3D Building
            </button>
          </div>

          {viewMode === 'dashboard' && (
            <div className="controls-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={useAggregate}
                  onChange={e => setUseAggregate(e.target.checked)}
                />
                Use Aggregated Data
              </label>
            </div>
          )}
        </div>

        {viewMode === 'dashboard' ? (
          <>
            <AlertSummary counts={alertCounts} onAlertsClick={handleAlertSelect} />

            <section className="controls-section">
              <div className="controls-header">
                <h2>Historical Data</h2>
              </div>
              <TimeRangeSelector onRangeChange={handleTimeRangeChange} defaultRange={timeRange} />
            </section>

            <section className="rooms-section">
              <h2>Room Temperatures</h2>
              <div className="rooms-grid">
                {latestData.map(room => (
                  <RoomCard
                    key={room.room}
                    data={room}
                    isAlertActive={activeAlertRooms.has(room.room)}
                    onSelect={() => handleRoomSelect(room.room)}
                  />
                ))}
              </div>
            </section>

            <section className="charts-section">
              <h2>Temperature History</h2>
              <div className="charts-grid">
                {history.map(roomHistory => (
                  <TemperatureChart
                    key={roomHistory.room}
                    readings={roomHistory.readings}
                    room={roomHistory.room}
                  />
                ))}
                {Object.entries(aggregate).map(([room, buckets]) => (
                  <TemperatureChart
                    key={room}
                    aggregate={buckets}
                    room={room}
                    useAggregate={true}
                  />
                ))}
              </div>
            </section>

            <section className="activity-section">
              <ActivityLog logs={activityLogs} />
            </section>

            <section className="alerts-section">
              <AlertList
                initialFilter={{ status: 'OPEN', limit: 50 }}
                onAlertSelect={handleAlertSelect}
              />
            </section>
          </>
        ) : (
          <BuildingScene
            latestData={latestData}
            onRoomSelect={handleRoomSelect}
            selectedRoomId={selectedRoomId}
            timeRange={timeRange}
            useAggregate={useAggregate}
            activeAlertRooms={activeAlertRooms}
          />
        )}

        {selectedAlert && (
          <AlertDetail
            alert={selectedAlert}
            onClose={handleCloseAlertDetail}
            onAlertUpdated={handleAlertUpdated}
          />
        )}
      </main>
    </div>
  );
}

export default App;
