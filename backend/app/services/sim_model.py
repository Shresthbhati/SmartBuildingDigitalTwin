"""The seeded sensor model shared by the live simulator and the what-if scenario lab.

Pure functions only: no I/O, no globals. Same inputs + same RNG state -> same outputs,
which is what makes scenario runs reproducible and comparable.
"""

import random
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Fraction of the gap to the baseline closed each step. Without it a clamped random walk
# drifts to the sensor bounds and sits in permanent alert.
REVERSION = 0.15

POWER_TYPES = {"power_kw"}


def local_hour(ts: datetime, tz_name: str) -> float:
    """Local wall-clock hour (0-24, fractional) for the building's timezone (UTC if unknown)."""
    try:
        local = ts.astimezone(ZoneInfo(tz_name))
    except (ZoneInfoNotFoundError, ValueError):
        local = ts
    return local.hour + local.minute / 60.0


def occupancy_factor(hour: float) -> float:
    """Share of nominal electrical load by local hour: full 08-18, 45% overnight, 1h ramps."""
    if 8.0 <= hour < 18.0:
        return 1.0
    if 7.0 <= hour < 8.0:
        return 0.45 + 0.55 * (hour - 7.0)
    if 18.0 <= hour < 19.0:
        return 1.0 - 0.55 * (hour - 18.0)
    return 0.45


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def next_temperature(
    current: float, baseline: float, variation: float, low: float, high: float, rng: random.Random
) -> float:
    nxt = current + REVERSION * (baseline - current) + rng.uniform(-variation, variation)
    return round(clamp(nxt, low, high), 1)


def next_power(
    baseline_kw: float,
    variation: float,
    low: float,
    high: float,
    hour: float,
    rng: random.Random,
) -> float:
    target = baseline_kw * occupancy_factor(hour)
    return round(clamp(target + rng.uniform(-variation, variation), low, high), 2)


def simulate_series(
    *,
    sensor_id: str,
    sensor_type: str,
    baseline: float,
    variation: float,
    low: float,
    high: float,
    seed: int,
    start: datetime,
    steps: int,
    step_seconds: int,
    tz_name: str = "UTC",
) -> list[tuple[datetime, float]]:
    """Deterministic series of `steps` readings starting at `start`.

    The RNG is seeded from (seed, sensor_id) so a baseline run and a modified run of the
    same sensor consume identical noise: their difference is caused by the parameters alone.
    """
    rng = random.Random(f"{seed}:{sensor_id}")
    out: list[tuple[datetime, float]] = []
    current = clamp(baseline, low, high)
    for i in range(steps):
        ts = start + timedelta(seconds=i * step_seconds)
        if sensor_type in POWER_TYPES:
            value = next_power(baseline, variation, low, high, local_hour(ts, tz_name), rng)
        else:
            value = next_temperature(current, baseline, variation, low, high, rng)
            current = value
        out.append((ts, value))
    return out
