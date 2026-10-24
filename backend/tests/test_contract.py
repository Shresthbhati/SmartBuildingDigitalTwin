"""HTTP-level contract tests: real app, real routing, auth and serialisation (no lifespan)."""

from datetime import timedelta
from helpers import add_alert, add_anomaly, add_reading, minutes_ago, now


# --------------------------------------------------------------------- #
# Phase 0 regression: `metadata` came back as SQLAlchemy's MetaData      #
# --------------------------------------------------------------------- #
def test_get_alert_returns_metadata_dict(client, db_session):
    alert = add_alert(db_session)
    db_session.commit()
    res = client.get(f"/api/alerts/{alert.id}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["metadata"] == {"note": "synthetic"}
    assert "metadata_json" not in body


def test_get_anomaly_returns_metadata_dict(client, db_session):
    anomaly = add_anomaly(db_session)
    db_session.commit()
    res = client.get(f"/api/anomalies/{anomaly.id}")
    assert res.status_code == 200, res.text
    assert res.json()["metadata"]["rolling_mean"] == 22.0


def test_timestamps_are_utc_aware_in_json(client, db_session):
    """Naive SQLite datetimes must not leak out: browsers would read them as local time."""
    alert = add_alert(db_session)
    anomaly = add_anomaly(db_session)
    add_reading(db_session)
    db_session.commit()
    assert (
        client.get(f"/api/alerts/{alert.id}").json()["first_occurrence"].endswith(("Z", "+00:00"))
    )
    assert (
        client.get(f"/api/anomalies/{anomaly.id}").json()["detected_at"].endswith(("Z", "+00:00"))
    )
    assert client.get("/api/alerts").json()[0]["last_occurrence"].endswith(("Z", "+00:00"))
    assert (
        client.get("/api/history/room101")
        .json()["readings"][0]["event_timestamp"]
        .endswith(("Z", "+00:00"))
    )


def test_metadata_null_when_absent(client, db_session):
    alert = add_alert(db_session)
    alert.metadata_json = None
    db_session.commit()
    assert client.get(f"/api/alerts/{alert.id}").json()["metadata"] is None


# --------------------------------------------------------------------- #
# Health, meta, topology                                                 #
# --------------------------------------------------------------------- #
def test_health_and_detailed(client):
    assert client.get("/health").status_code == 200
    detail = client.get("/health/detailed").json()
    assert detail["database"] == "connected"
    assert isinstance(detail["recent_errors"], list)
    assert "websocket_clients" in detail and "event_seq" in detail


def test_meta_exposes_bounds_and_thresholds(client):
    meta = client.get("/api/meta").json()
    assert meta["stale_after_seconds"] == 120
    assert meta["retention_days"] == 30
    assert meta["scenario_bounds"]["baseline_offset"] == [-10.0, 10.0]
    assert meta["thresholds"]["warning"] < meta["thresholds"]["critical"]


def test_topology_tree_shape(client):
    tree = client.get("/api/topology").json()
    assert tree["building"]["code"] == "hq"
    assert [f["level"] for f in tree["floors"]] == [0, 1]
    ground = tree["floors"][0]
    assert [r["code"] for r in ground["rooms"]] == ["room101", "room102", "room103", "room104"]
    assert {a["kind"] for a in ground["assets"]} == {"hvac", "meter"}
    room = ground["rooms"][0]
    assert room["sensors"][0]["sensor_id"] == "temp-sensor-101"
    assert room["sensors"][0]["last_seen_at"] is None


def test_sensors_listing_has_types_and_locations(client):
    sensors = client.get("/api/sensors").json()
    assert len(sensors) == 10
    by_id = {s["sensor_id"]: s for s in sensors}
    assert by_id["temp-sensor-203"]["location"] == "room203"
    assert by_id["temp-sensor-203"]["floor"] == 1
    assert by_id["power-meter-f0"]["type"] == "power_kw"
    assert by_id["power-meter-f0"]["location"] == "meter-f0"


def test_latest_readings_one_per_sensor_with_real_timestamps(client, db_session):
    older = minutes_ago(10)
    newer = minutes_ago(2)
    add_reading(db_session, value=20.0, ts=older)
    add_reading(db_session, value=24.5, ts=newer)
    add_reading(
        db_session, "power-meter-f0", "meter-f0", 13.0, newer, measurement="power_kw", unit="kW"
    )
    db_session.commit()
    body = {r["sensor_id"]: r for r in client.get("/api/readings/latest").json()}
    assert set(body) == {"temp-sensor-101", "power-meter-f0"}
    assert body["temp-sensor-101"]["value"] == 24.5
    assert body["temp-sensor-101"]["event_timestamp"].startswith(newer.strftime("%Y-%m-%dT%H:%M"))
    assert (
        body["power-meter-f0"]["unit"] == "kW" and body["power-meter-f0"]["source"] == "simulated"
    )


def test_layout_comes_from_db_topology(client):
    layout = client.get("/api/layout").json()
    assert [f["level"] for f in layout["floors"]] == [0, 1]
    room101 = layout["floors"][0]["rooms"][0]
    assert room101["id"] == "room101" and room101["sensor_id"] == "temp-sensor-101"
    assert layout["dimensions"]["width"] == 20.0


def test_history_unknown_room_404_and_asset_location_ok(client):
    assert client.get("/api/history/room999").status_code == 404
    assert (
        client.get("/api/history/meter-f0", params={"measurement": "power_kw"}).status_code == 200
    )


# --------------------------------------------------------------------- #
# Auth                                                                   #
# --------------------------------------------------------------------- #
def test_login_rejects_bad_credentials(client):
    res = client.post("/api/auth/login", json={"username": "operator", "password": "nope"})
    assert res.status_code == 401


def test_login_throttles_repeated_failures(client):
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "viewer", "password": "bad"})
    res = client.post("/api/auth/login", json={"username": "viewer", "password": "viewer-demo"})
    assert res.status_code == 429


def test_mutations_require_authentication(client, db_session):
    alert = add_alert(db_session)
    db_session.commit()
    assert client.post(f"/api/alerts/{alert.id}/acknowledge").status_code == 401
    assert client.post("/api/retention/run").status_code == 401
    assert client.post("/api/simulator/start").status_code == 401
    assert (
        client.post("/api/simulator/inject", json={"sensor_id": "x", "kind": "spike"}).status_code
        == 401
    )
    assert (
        client.post("/api/scenarios/run", json={"sensor_id": "temp-sensor-101"}).status_code == 401
    )


def test_invalid_token_is_401(client, db_session):
    alert = add_alert(db_session)
    db_session.commit()
    res = client.post(
        f"/api/alerts/{alert.id}/acknowledge", headers={"Authorization": "Bearer not-a-jwt"}
    )
    assert res.status_code == 401


def test_viewer_cannot_mutate_operator_can(client, db_session, viewer_headers, operator_headers):
    alert = add_alert(db_session)
    db_session.commit()
    url = f"/api/alerts/{alert.id}/acknowledge"
    assert client.post(url, headers=viewer_headers).status_code == 403
    assert client.post(url, headers=operator_headers).status_code == 200


def test_operator_cannot_run_admin_endpoints(client, operator_headers, admin_headers):
    assert client.post("/api/retention/run", headers=operator_headers).status_code == 403
    assert client.post("/api/retention/run", headers=admin_headers).status_code == 200


def test_actor_comes_from_token_not_body(client, db_session, operator_headers):
    alert = add_alert(db_session)
    db_session.commit()
    res = client.post(
        f"/api/alerts/{alert.id}/acknowledge", headers=operator_headers, json={"actor": "mallory"}
    )
    assert res.status_code == 200
    assert res.json()["acknowledged_by"] == "operator"


def test_reads_stay_open_without_token(client):
    for path in (
        "/api/alerts",
        "/api/anomalies",
        "/api/topology",
        "/api/maintenance",
        "/api/energy",
    ):
        assert client.get(path).status_code == 200, path


# --------------------------------------------------------------------- #
# Alerts: ack/resolve through HTTP, time filter                          #
# --------------------------------------------------------------------- #
def test_ack_then_resolve_persists_and_double_resolve_is_400(client, db_session, operator_headers):
    anomaly = add_anomaly(db_session)
    db_session.commit()
    base = f"/api/anomalies/{anomaly.id}"
    assert (
        client.post(f"{base}/acknowledge", headers=operator_headers).json()["status"]
        == "ACKNOWLEDGED"
    )
    assert client.post(f"{base}/resolve", headers=operator_headers).json()["status"] == "RESOLVED"
    assert client.post(f"{base}/resolve", headers=operator_headers).status_code == 400
    assert client.get(base).json()["status"] == "RESOLVED"
    assert (
        client.post("/api/anomalies/99999/acknowledge", headers=operator_headers).status_code == 404
    )


def test_alerts_time_filter_uses_overlap(client, db_session):
    old = add_alert(db_session, started=minutes_ago(300), resolved=minutes_ago(290))
    recent = add_alert(db_session, started=minutes_ago(20))
    db_session.commit()
    start = (now() - timedelta(minutes=60)).isoformat()
    ids = [a["id"] for a in client.get("/api/alerts", params={"start": start}).json()]
    assert recent.id in ids and old.id not in ids
    end = (now() - timedelta(minutes=250)).isoformat()
    ids = [a["id"] for a in client.get("/api/alerts", params={"end": end}).json()]
    assert old.id in ids and recent.id not in ids
    bad = client.get("/api/alerts", params={"start": start, "end": end})
    assert bad.status_code == 400


# --------------------------------------------------------------------- #
# Replay / context / anticipate validation                               #
# --------------------------------------------------------------------- #
def test_replay_param_validation(client):
    t = now()
    res = client.get(
        "/api/replay", params={"start": t.isoformat(), "end": (t - timedelta(hours=1)).isoformat()}
    )
    assert res.status_code == 400
    assert client.get("/api/replay").status_code == 422


def test_replay_returns_documented_shape(client, db_session):
    add_reading(db_session, ts=minutes_ago(5))
    db_session.commit()
    res = client.get(
        "/api/replay",
        params={"start": minutes_ago(30).isoformat(), "end": now().isoformat(), "floor": 0},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    for key in (
        "sensors",
        "alerts",
        "anomalies",
        "events",
        "truncated",
        "retention_days",
        "stale_after_seconds",
    ):
        assert key in body
    assert {s["sensor_id"] for s in body["sensors"]} >= {"temp-sensor-101", "power-meter-f0"}
    assert all(s["floor"] == 0 for s in body["sensors"])


def test_context_404_and_shape(client, db_session):
    assert client.get("/api/anomalies/999/context").status_code == 404
    anomaly = add_anomaly(db_session)
    db_session.commit()
    body = client.get(f"/api/anomalies/{anomaly.id}/context").json()
    assert body["anomaly_id"] == anomaly.id
    kinds = {e["kind"] for e in body["edges"]}
    assert kinds <= {"structural", "temporal_cooccurrence"}
    assert "causation" in body["disclaimer"]


def test_forecast_unknown_sensor_404_and_sparse_abstains(client):
    assert client.get("/api/forecast", params={"sensor_id": "nope"}).status_code == 404
    body = client.get("/api/forecast", params={"sensor_id": "temp-sensor-101"}).json()
    assert body["abstained"] is True and body["label"] == "estimated"


def test_maintenance_is_labelled_rule_based(client):
    body = client.get("/api/maintenance").json()
    assert body["basis"] == "rule-based (v1)"
    assert body["flags"] == []


def test_scenario_endpoint_enforces_bounds(client, operator_headers):
    ok = client.post(
        "/api/scenarios/run",
        headers=operator_headers,
        json={"sensor_id": "temp-sensor-101", "baseline_offset": 2, "window_minutes": 30},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["advisory"].startswith("Simulation")
    for payload in (
        {"sensor_id": "temp-sensor-101", "baseline_offset": 99},
        {"sensor_id": "temp-sensor-101", "variation_scale": -1},
        {"sensor_id": "temp-sensor-101", "window_minutes": 0},
        {"sensor_id": "temp-sensor-101", "floor": 0},
        {},
    ):
        assert (
            client.post("/api/scenarios/run", headers=operator_headers, json=payload).status_code
            == 422
        ), payload
    missing = client.post(
        "/api/scenarios/run", headers=operator_headers, json={"sensor_id": "nope"}
    )
    assert missing.status_code == 404


def test_inject_requires_running_simulator(client, operator_headers):
    # No lifespan in tests, so the simulator is not running: a clear 409, not a silent no-op.
    res = client.post(
        "/api/simulator/inject",
        headers=operator_headers,
        json={"sensor_id": "temp-sensor-101", "kind": "spike", "duration_seconds": 10},
    )
    assert res.status_code in (404, 409)
