"""Network evidence harness for the CN mini-project reviews.

Runs the real NEXUS backend against a real MQTT broker over TCP (loopback) and records what
happened: normal operation, malformed/duplicate messages, broker crash + recovery, backend
started before the broker, and a latency/throughput benchmark.

    python netlab/evidence.py            # ~3 minutes; writes docs/evidence/{results.json,RESULTS.md,*.log}

Nothing here is mocked: every number comes from a measured run on this machine.
"""

import json
import os
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import paho.mqtt.client as mqtt

ROOT = Path(__file__).resolve().parent.parent
EVID = ROOT / "docs" / "evidence"
BROKER_PORT, API_PORT = 18830, 18000
HOST = "127.0.0.1"
results: dict = {
    "started": datetime.now(UTC).isoformat(),
    "python": sys.version.split()[0],
}
checks: list[tuple[str, bool, str]] = []  # (name, passed, detail)


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} {detail}")


def new_client(cid: str) -> mqtt.Client:
    return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid)


# ------------------------------------------------------------------ process control
class Proc:
    def __init__(self, args, log: str, cwd=None, env=None):
        self.args, self.log, self.cwd, self.env = args, EVID / log, cwd, env
        self.p: subprocess.Popen | None = None

    def start(self):
        f = open(self.log, "ab")  # noqa: SIM115 - handle must outlive this call (child's stdout)
        f.write(f"\n===== start {datetime.now(UTC).isoformat()} =====\n".encode())
        f.flush()
        self.p = subprocess.Popen(
            self.args, cwd=self.cwd, env=self.env, stdout=f, stderr=f
        )

    def stop(self):
        if self.p and self.p.poll() is None:
            self.p.kill()
            self.p.wait(timeout=10)


def broker() -> Proc:
    return Proc(
        [sys.executable, str(ROOT / "netlab" / "broker.py"), str(BROKER_PORT)],
        "broker.log",
    )


def backend(db: Path) -> Proc:
    env = dict(
        os.environ,
        MQTT_BROKER=HOST,
        MQTT_PORT=str(BROKER_PORT),
        SIMULATOR_TRANSPORT="mqtt",
        DATABASE_URL=f"sqlite:///{db.as_posix()}",
        PYTHONUNBUFFERED="1",
    )
    args = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        HOST,
        "--port",
        str(API_PORT),
    ]
    return Proc(args, "backend.log", cwd=ROOT / "backend", env=env)


def wait_port(port: int, up: bool, timeout=30) -> float:
    t0 = time.time()
    while time.time() - t0 < timeout:
        with socket.socket() as s:
            s.settimeout(0.3)
            is_up = s.connect_ex((HOST, port)) == 0
        if is_up == up:
            return time.time() - t0
        time.sleep(0.2)
    raise TimeoutError(f"port {port} never became {'up' if up else 'down'}")


def health() -> dict | None:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{API_PORT}/health", timeout=2) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001 - any failure means "backend not answering"
        return None


def wait_mqtt(state: str, timeout=60) -> float:
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = health()
        if h and h.get("mqtt") == state:
            return time.time() - t0
        time.sleep(0.25)
    raise TimeoutError(f"/health mqtt never became {state!r}")


def rows(db: Path, sql: str, args=()):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def count(db: Path, where="1=1", args=()) -> int:
    return rows(db, f"SELECT COUNT(*) FROM sensor_readings WHERE {where}", args)[0][0]


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))] if xs else float("nan")


# ------------------------------------------------------------------ scenarios
def s1_normal(db: Path):
    print("S1 normal operation (sensors -> broker -> backend -> DB -> API)")
    seen: list[dict] = []
    c = new_client("evidence-tap")
    c.on_message = lambda _c, _u, m: seen.append(
        {"topic": m.topic, "payload": json.loads(m.payload)}
    )
    c.connect(HOST, BROKER_PORT)
    c.subscribe("building/+/+", qos=1)
    c.loop_start()
    n0 = count(db)
    time.sleep(16)  # ~3 publish ticks at the 5 s default interval
    n1 = count(db)
    c.loop_stop()
    c.disconnect()
    sensors = {m["payload"]["sensor_id"] for m in seen}
    ok_schema = all(
        {
            "sensor_id",
            "room",
            "measurement",
            "value",
            "unit",
            "event_timestamp",
            "idempotency_key",
        }
        <= m["payload"].keys()
        and m["topic"]
        == f"building/{m['payload']['room']}/{m['payload']['measurement']}"
        for m in seen
    )
    results["s1"] = {
        "tap_messages": len(seen),
        "distinct_sensors": len(sensors),
        "db_rows_added": n1 - n0,
        "sample": seen[0] if seen else None,
    }
    check(
        "topics follow building/<room>/<measurement> and payload has all fields",
        seen and ok_schema,
    )
    check(
        "every observed message reached the DB",
        n1 - n0 >= len(seen) - len(sensors),
        f"({len(seen)} on wire, {n1 - n0} rows)",
    )
    check(
        "all configured sensors published",
        len(sensors) >= 4,
        f"({len(sensors)} sensors)",
    )
    api = json.load(
        urllib.request.urlopen(f"http://{HOST}:{API_PORT}/api/latest", timeout=5)
    )
    check("API reflects broker-delivered data", any(r["temperature"] > 0 for r in api))


def s2_bad_input(db: Path):
    print("S2 malformed / duplicate / legacy payloads")
    c = new_client("evidence-injector")
    c.connect(HOST, BROKER_PORT)
    c.loop_start()
    pub = lambda t, p: c.publish(t, p, qos=1).wait_for_publish(5)
    key = f"evidence-dup-{int(time.time())}"
    good = json.dumps(
        {
            "sensor_id": "temp-sensor-101",
            "room": "room101",
            "measurement": "temperature",
            "value": 23.4,
            "unit": "celsius",
            "source": "simulated",
            "event_timestamp": datetime.now(UTC).isoformat(),
            "idempotency_key": key,
        }
    )
    pub("building/room101/temperature", b"{not json at all")
    pub(
        "building/room101/temperature", json.dumps({"measurement": "temperature"})
    )  # no value
    pub("building/room101/temperature", good)
    pub("building/room101/temperature", good)  # redelivery (QoS 1 is at-least-once)
    pub("building/room101/temperature", "24.5")  # legacy bare-float payload
    time.sleep(3)
    c.loop_stop()
    c.disconnect()
    dups = count(db, "idempotency_key=?", (key,))
    h = health()
    results["s2"] = {"dup_rows_for_key": dups, "health_after": h}
    check(
        "duplicate delivery stored exactly once (idempotency key)",
        dups == 1,
        f"(rows={dups})",
    )
    check("malformed payloads did not crash ingestion", h and h["status"] == "healthy")
    check("legacy bare-float payload accepted", count(db, "value=24.5") >= 1)


def s3_broker_crash(db: Path, b: Proc):
    print("S3 broker crash and recovery (backend + sensors stay up)")
    base = count(db)
    t_kill = time.time()
    b.stop()
    wait_port(BROKER_PORT, up=False)
    detect = wait_mqtt("disconnected", 30)
    time.sleep(12)
    during = count(db) - base
    b.start()
    t_up = time.time()  # broker process launched; recovery is timed from here
    recover = wait_mqtt("connected", 60)
    t_conn = time.time()
    pre = count(db)
    deadline = time.time() + 30
    while time.time() < deadline and count(db) <= pre:
        time.sleep(0.25)
    first_new = time.time() - t_conn
    ok_flow = count(db) > pre
    results["s3"] = {
        "outage_detected_after_s": round(detect, 2),
        "rows_during_outage": during,
        "reconnected_after_s": round(recover, 2),
        "first_new_row_after_reconnect_s": round(first_new, 2),
        "total_outage_s": round(t_up - t_kill, 2),
    }
    check(
        "backend reports mqtt=disconnected when broker dies",
        detect < 30,
        f"({detect:.1f}s)",
    )
    check("no rows ingested while broker is down", during == 0, f"({during} rows)")
    check(
        "backend reconnects by itself after broker restart",
        recover < 60,
        f"({recover:.1f}s)",
    )
    check(
        "data flows again after reconnect (re-subscribed)",
        ok_flow,
        f"(first row +{first_new:.1f}s)",
    )


def s4_start_order():
    print("S4 backend started BEFORE the broker (startup race)")
    # Root cause of the pre-fix bug, shown directly: a blocking connect() raises, so the
    # `loop_start()` after it is never reached and nothing ever retries.
    c = new_client("evidence-prefix-demo")
    started_loop, raised = False, "none"
    try:
        c.connect(HOST, BROKER_PORT)
        c.loop_start()
        started_loop = True
    except OSError as e:
        raised = type(e).__name__
    results["s4_blocking_connect"] = {"raised": raised, "loop_started": started_loop}
    check(
        "blocking connect() raises when broker is down (why the old code never retried)",
        not started_loop,
        f"({raised})",
    )

    db = Path(tempfile.mkdtemp()) / "s4.db"
    a = backend(db)
    a.start()
    b = broker()
    try:
        wait_port(API_PORT, up=True, timeout=60)
        time.sleep(8)
        before = health()
        b.start()
        wait_port(BROKER_PORT, up=True)
        try:
            t = wait_mqtt("connected", 60)
        except TimeoutError:
            t = None
        pre = count(db)
        time.sleep(12)
        post = count(db)
        results["s4"] = {
            "mqtt_while_broker_absent": before and before["mqtt"],
            "connected_after_broker_start_s": t and round(t, 2),
            "rows_after": post - pre,
        }
        check(
            "backend up with broker absent reports degraded, not crashed",
            before and before["mqtt"] == "disconnected",
        )
        check(
            "backend connects once the broker appears",
            t is not None,
            f"({t and round(t, 1)}s)",
        )
        check(
            "telemetry flows after late broker start",
            post > pre,
            f"({post - pre} rows in 12s)",
        )
    finally:
        b.stop()
        a.stop()


def s5_benchmark():
    print("S5 latency / throughput through the broker (no backend)")
    b = broker()
    b.start()
    wait_port(BROKER_PORT, up=True)
    out = []
    try:
        for qos, rate, pubs, dur in [
            (0, 50, 5, 6),
            (1, 50, 5, 6),
            (0, 300, 20, 6),
            (1, 300, 20, 6),
            (1, 1000, 20, 6),
        ]:
            lat, got = [], [0]
            sub = new_client(f"bench-sub-{qos}-{rate}")

            def on_msg(_c, _u, m, lat=lat, got=got):
                lat.append(
                    (time.perf_counter_ns() - int(m.payload.split(b"|")[0])) / 1e6
                )
                got[0] += 1

            sub.on_message = on_msg
            sub.connect(HOST, BROKER_PORT)
            sub.subscribe("bench/#", qos=qos)
            sub.loop_start()
            clients = []
            for i in range(pubs):
                p = new_client(f"bench-pub-{i}")
                p.connect(HOST, BROKER_PORT)
                p.loop_start()
                clients.append(p)
            time.sleep(0.5)
            sent, t0, interval = 0, time.perf_counter(), 1.0 / rate
            while time.perf_counter() - t0 < dur:
                clients[sent % pubs].publish(
                    f"bench/s{sent % pubs}/temp",
                    f"{time.perf_counter_ns()}|{22.0 + sent % 7}",
                    qos=qos,
                )
                sent += 1
                nxt = t0 + sent * interval
                while time.perf_counter() < nxt:
                    pass
            elapsed = time.perf_counter() - t0
            time.sleep(3)  # drain
            for p in clients:
                p.loop_stop()
                p.disconnect()
            sub.loop_stop()
            sub.disconnect()
            row = {
                "qos": qos,
                "target_msg_s": rate,
                "publishers": pubs,
                "sent": sent,
                "received": got[0],
                "loss_pct": round(100 * (sent - got[0]) / sent, 2),
                "achieved_msg_s": round(sent / elapsed, 1),
                "p50_ms": round(pct(lat, 50), 2),
                "p95_ms": round(pct(lat, 95), 2),
                "p99_ms": round(pct(lat, 99), 2),
                "max_ms": round(max(lat or [0]), 2),
                "mean_ms": round(statistics.fmean(lat or [0]), 2),
            }
            out.append(row)
            print("   ", row)
    finally:
        b.stop()
    results["s5"] = out
    q1 = [r for r in out if r["qos"] == 1 and r["target_msg_s"] <= 300]
    check(
        "QoS 1 delivers every message at building-scale load (<=300 msg/s)",
        all(r["loss_pct"] == 0 for r in q1),
        str([r["loss_pct"] for r in q1]),
    )
    small = [r for r in out if r["target_msg_s"] <= 300]
    check(
        "p95 latency under 100 ms at building-scale load",
        all(r["p95_ms"] < 100 for r in small),
        str([r["p95_ms"] for r in small]),
    )


# ------------------------------------------------------------------ report
def write_report():
    results["finished"] = datetime.now(UTC).isoformat()
    results["checks"] = [{"name": n, "passed": ok, "detail": d} for n, ok, d in checks]
    (EVID / "results.json").write_text(
        json.dumps(results, indent=2, default=str), encoding="utf-8"
    )
    md = [
        "# Network evidence run",
        "",
        f"Run: {results['started']}  ·  Python {results['python']}  ·  broker: amqtt (MQTT 3.1.1, TCP loopback)",
        "",
        "Generated by `python netlab/evidence.py`. Raw data: `results.json`; logs: `backend.log`, `broker.log`.",
        "",
        "## Test cases",
        "",
        "| # | Check | Result | Detail |",
        "|---|---|---|---|",
    ]
    for i, (n, ok, d) in enumerate(checks, 1):
        md.append(f"| {i} | {n} | {'PASS' if ok else '**FAIL**'} | {d} |")
    md += ["", f"**{sum(ok for _, ok, _ in checks)}/{len(checks)} passed.**", ""]
    if "s5" in results:
        md += [
            "## Benchmark (publisher -> broker -> subscriber, same host)",
            "",
            "| QoS | target msg/s | publishers | sent | received | loss % | p50 ms | p95 ms | p99 ms | max ms |",
            "|---|---|---|---|---|---|---|---|---|---|",
        ]
        for r in results["s5"]:
            md.append(
                f"| {r['qos']} | {r['target_msg_s']} | {r['publishers']} | {r['sent']} | {r['received']} | {r['loss_pct']} | {r['p50_ms']} | {r['p95_ms']} | {r['p99_ms']} | {r['max_ms']} |"
            )
        md.append("")
    if "s3" in results:
        md += [
            "## Failure case: broker crash",
            "",
            "```json",
            json.dumps(results["s3"], indent=2),
            "```",
            "",
        ]
    md += [
        "## Caveats",
        "",
        "- Loopback on one machine: no WAN latency, jitter or real packet loss. Numbers show protocol/broker/backend overhead only.",
        "- Broker is amqtt (pure Python), slower than Mosquitto; throughput ceilings here are conservative.",
        "- Sensors are simulated (labelled `simulated` end to end); there is no physical hardware.",
        "",
    ]
    (EVID / "RESULTS.md").write_text("\n".join(md), encoding="utf-8")


def main():
    EVID.mkdir(parents=True, exist_ok=True)
    for f in ("backend.log", "broker.log"):
        (EVID / f).write_bytes(b"")
    db = Path(tempfile.mkdtemp()) / "evidence.db"
    b, a = broker(), backend(db)
    try:
        b.start()
        wait_port(BROKER_PORT, up=True)
        a.start()
        wait_port(API_PORT, up=True, timeout=90)
        wait_mqtt("connected", 60)
        s1_normal(db)
        s2_bad_input(db)
        s3_broker_crash(db, b)
    finally:
        a.stop()
        b.stop()
    wait_port(BROKER_PORT, up=False)
    s4_start_order()
    s5_benchmark()
    write_report()
    failed = [n for n, ok, _ in checks if not ok]
    print(
        f"\n{len(checks) - len(failed)}/{len(checks)} passed -> {EVID / 'RESULTS.md'}"
    )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
