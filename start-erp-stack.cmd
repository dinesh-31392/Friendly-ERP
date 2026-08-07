@echo off
rem ─── Friendly ERP: start the full local stack ──────────────────────────────
rem Opens three windows: the database, the ERP API server, and the WhatsApp
rem gateway (Evolution API, running from source — no Docker needed).
rem Then open the app at http://localhost:5173 (run `npm run dev` for it, or
rem use your usual way of starting the front end).

start "ERP Database (Postgres 5433)" cmd /k "cd /d %~dp0 && node localdb\start-db.mjs"
timeout /t 8 /nobreak >nul

start "ERP API Server (4000)" cmd /k "cd /d %~dp0server && npx tsx src/index.ts"
timeout /t 3 /nobreak >nul

start "WhatsApp Gateway (8080)" cmd /k "cd /d C:\Users\Admin\Desktop\evolution-api && npm run start:prod"

echo All three services launching in their own windows.
echo   - Database:        localhost:5433
echo   - ERP API:         http://localhost:4000
echo   - WhatsApp gateway http://localhost:8080
pause
