import pytest
from app.models.anomaly import AnomalyCategory, AnomalyEvent, AnomalySeverity, AnomalyStatus
from app.models.lifecycle import EventLifecycleEvent
from app.services.anomaly_service import AnomalyService, anomaly_service
from datetime import timedelta
from helpers import now

ROOM, SENSOR = "room101", "temp-sensor-101"
STEP = timedelta(seconds=5)


@pytest.fixture(autouse=True)
def fresh_detector():
    def reset():
        anomaly_service._cache.clear()
        anomaly_service._active.clear()
        anomaly_service._last_anomaly_time.clear()
        anomaly_service._streaks.clear()

    reset()
    yield anomaly_service
    reset()


class Feed:
    """Feeds timestamped readings to the detector on a 5s cadence."""

    def __init__(self, db):
        self.db = db
        self.t = now() - timedelta(minutes=30)

    def send(self, value, measurement="temperature", source="simulated"):
        self.t += STEP
        anomaly_service.evaluate_reading(
            ROOM, SENSOR, value, "celsius", source, self.t, measurement, db=self.db
        )

    def warm_up(self, n=30):
        # Alternating +-0.4 around 22.0: stddev ~0.4, comfortably past the 60s warm-up.
        for i in range(n):
            self.send(22.0 + (0.4 if i % 2 else -0.4))


def _all(db):
    db.expire_all()
    return db.query(AnomalyEvent).order_by(AnomalyEvent.id).all()


def test_no_anomaly_during_warm_up_even_for_extreme_values(db_session):
    feed = Feed(db_session)
    for v in (22.0, 22.4, 21.6, 22.0, 60.0):  # < 60s of history and < min_samples after the spike
        feed.send(v)
    assert _all(db_session) == []


def test_normal_readings_never_flag(db_session):
    Feed(db_session).warm_up(40)
    assert _all(db_session) == []


def test_spike_is_detected_against_the_baseline_that_excludes_it(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(32.0)
    (anomaly,) = _all(db_session)
    assert anomaly.anomaly_category == AnomalyCategory.Z_SCORE_SPIKE
    assert anomaly.severity == AnomalySeverity.CRITICAL
    assert anomaly.status == AnomalyStatus.OPEN
    # Had the outlier been averaged into its own baseline, z could never exceed ~4.25 (n=20).
    assert anomaly.deviation_score > 15
    assert anomaly.expected_baseline == pytest.approx(22.0, abs=0.1)


def test_drop_is_classified_as_drop_not_spike(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(12.0)
    (anomaly,) = _all(db_session)
    assert anomaly.anomaly_category == AnomalyCategory.Z_SCORE_DROP


def test_moderate_deviation_is_labelled_sustained_deviation(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    for _ in range(3):  # ~4 sigma: above the 3.0 z-threshold, below the 5.0 spike threshold
        feed.send(23.7)
    (anomaly,) = _all(db_session)
    assert anomaly.anomaly_category == AnomalyCategory.SUSTAINED_DEVIATION
    assert anomaly.severity == AnomalySeverity.WARNING


def test_one_noisy_reading_is_not_a_sustained_deviation(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(23.7)
    feed.send(23.7)
    feed.send(22.0)  # back to normal: the streak resets
    feed.send(23.7)
    feed.send(23.7)
    assert _all(db_session) == []


def test_moderate_readings_that_are_still_pending_stay_out_of_the_baseline(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    before = anomaly_service._cache.get_window(ROOM, SENSOR)
    feed.send(23.7)
    feed.send(23.7)
    assert anomaly_service._cache.get_window(ROOM, SENSOR) == before


def test_metadata_records_the_evidence_the_ui_needs(db_session):
    import json

    feed = Feed(db_session)
    feed.warm_up()
    feed.send(32.0, source="scenario")
    meta = json.loads(_all(db_session)[0].metadata_json)
    assert meta["source"] == "scenario"
    assert meta["rolling_mean"] == pytest.approx(22.0, abs=0.1)
    assert meta["sample_count"] == 20 and meta["window_size"] == 20
    assert meta["detector_config"]["z_score_threshold"] == 3.0


def test_repeated_spike_within_cooldown_updates_one_event(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    for v in (32.0, 33.0, 34.0):
        feed.send(v)
    (anomaly,) = _all(db_session)
    assert anomaly.occurrence_count == 3
    assert anomaly.observed_value == 34.0


def test_recovery_resolves_and_is_audited(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(32.0)
    feed.send(22.0)
    (anomaly,) = _all(db_session)
    assert anomaly.status == AnomalyStatus.RESOLVED
    rows = (
        db_session.query(EventLifecycleEvent)
        .filter_by(entity_type="anomaly", entity_id=anomaly.id)
        .order_by(EventLifecycleEvent.id)
        .all()
    )
    assert [(r.from_status, r.to_status, r.actor) for r in rows] == [
        (None, "OPEN", "system"),
        ("OPEN", "RESOLVED", "system"),
    ]


def test_a_new_spike_after_recovery_opens_a_new_event(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(32.0)
    feed.send(22.0)
    feed.send(33.0)
    events = _all(db_session)
    assert [e.status for e in events] == [AnomalyStatus.RESOLVED, AnomalyStatus.OPEN]


def test_user_resolution_frees_the_slot_for_the_next_anomaly(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(32.0)
    first = _all(db_session)[0]
    anomaly_service.resolve_anomaly(first.id, actor="ops", db=db_session)
    feed.send(33.0)
    assert [e.status for e in _all(db_session)] == [AnomalyStatus.RESOLVED, AnomalyStatus.OPEN]


def test_non_temperature_measurements_are_ignored(db_session):
    feed = Feed(db_session)
    for _ in range(30):
        feed.send(14.0, measurement="power_kw")
    feed.send(90.0, measurement="power_kw")
    assert _all(db_session) == []
    assert anomaly_service._cache.get_window(ROOM, SENSOR) == []


def test_non_finite_values_are_skipped_not_treated_as_zero(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(float("nan"))
    feed.send(float("inf"))
    assert _all(db_session) == []
    assert all(v == v and abs(v) < 1e6 for _, v in anomaly_service._cache.get_window(ROOM, SENSOR))


def test_open_anomalies_are_readopted_after_restart_without_duplicates(db_session):
    feed = Feed(db_session)
    feed.warm_up()
    feed.send(32.0)
    assert len(_all(db_session)) == 1

    # Simulate a process restart: fresh service, caches rebuilt from the database.
    restarted = AnomalyService()
    restarted._load_active(db_session)
    assert list(restarted._active.values()) == [_all(db_session)[0].id]
    for i, (_, v) in enumerate(anomaly_service._cache.get_window(ROOM, SENSOR)):
        restarted._cache.add(ROOM, SENSOR, feed.t - STEP * (20 - i), v)
    restarted.evaluate_reading(ROOM, SENSOR, 33.0, event_timestamp=feed.t + STEP, db=db_session)
    events = _all(db_session)
    assert len(events) == 1 and events[0].occurrence_count == 2


def test_flat_baseline_does_not_explode_on_sensor_resolution_noise(db_session):
    feed = Feed(db_session)
    for _ in range(30):
        feed.send(22.0)  # perfectly flat window: stddev would be 0
    feed.send(22.1)  # one resolution step
    assert _all(db_session) == []
