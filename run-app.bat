@echo off
rem Smart Building Digital Twin (Nexus) launcher: backend :8000 + frontend :5173
rem No MQTT broker needed: the simulator feeds ingestion in-process.
rem To use a real Mosquitto broker instead, remove the next line.
set ROOT=%~dp0
set SIMULATOR_TRANSPORT=direct

if not exist "%ROOT%frontend\node_moduleseact-router-dom" (
    echo Installing frontend dependencies...
    pushd "%ROOT%frontend" && call npm install && popd
)

start "Backend :8000" /D "%ROOT%backend" cmd /k python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
start "Frontend :5173" /D "%ROOT%frontend" cmd /k npm run dev -- --host localhost --port 5173

rem wait for the backend, then open the app
:wait
timeout /t 2 /nobreak >nul
curl -s -o nul http://localhost:8000/health || goto wait
start "" http://localhost:5173
