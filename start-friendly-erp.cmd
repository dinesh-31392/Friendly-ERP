@echo off
setlocal
rem ─── Friendly ERP — start the whole thing on this PC ───────────────────────
rem
rem Three tiers, three windows, in dependency order:
rem
rem   PostgreSQL 5433   the real database (embedded — no install, no Docker).
rem                     Data lives in localdb\pgdata and persists between runs.
rem   Fastify API 4000  the backend. Row-level security and permissions are
rem                     enforced HERE, in the database, not in the browser.
rem   Web server 8080   serves the built app and proxies /api -> 4000, which is
rem                     what nginx does in production. Same origin, so no CORS.
rem
rem Keep the three windows open while you use the ERP; closing them stops it.
rem
rem NOTE: start-erp-stack.cmd also uses 8080, for the WhatsApp gateway. The two
rem cannot run together. Use this one unless you are working on WhatsApp.

cd /d "%~dp0"

rem The web server serves dist\, so there has to be one. VITE_API_URL=/ is what
rem makes the build talk to the API instead of the in-browser demo store.
if not exist "dist\index.html" (
  echo No build found. Building the app first — this takes about a minute...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   Build failed. Fix the error above and run this again.
    pause
    exit /b 1
  )
)

rem Both tools are called by FULL PATH, and the delay is ping rather than
rem timeout, for two reasons found the hard way:
rem
rem   a bare `timeout` resolves to GNU coreutils when Git Bash is on PATH, which
rem   rejects /t and silently skips every wait — so the API launched before
rem   Postgres was listening;
rem   and timeout.exe itself refuses to run at all when stdin is redirected
rem   ("Input redirection is not supported"), which is how it is invoked by any
rem   automation rather than a double-click.
rem
rem ping.exe has neither problem. -n N sends N pings a second apart, so the
rem delay is N-1 seconds.
set "SLEEP=%SystemRoot%\System32\ping.exe -n"
set "CURL=%SystemRoot%\System32\curl.exe"

echo Starting the database...
start "Friendly ERP - Database (5433)" cmd /k "cd /d %~dp0 && node localdb\start-db.mjs"

echo   waiting for Postgres to accept connections...
%SLEEP% 13 127.0.0.1 >nul

echo Starting the API...
start "Friendly ERP - API (4000)" cmd /k "cd /d %~dp0server && npx tsx src/index.ts"

rem Wait for the thing itself rather than guessing: on a cold machine the API
rem takes noticeably longer, and starting the web server early just serves an
rem app whose first requests fail.
echo   waiting for the API to answer...
for /l %%i in (1,1,40) do (
  %CURL% -sf -o nul --max-time 2 http://localhost:4000/api/health >nul 2>&1 && goto :apiup
  %SLEEP% 2 127.0.0.1 >nul
)
echo   The API never answered on 4000 — check its window for the reason.
:apiup

echo Starting the web server...
start "Friendly ERP - Web (8080)" cmd /k "cd /d %~dp0 && node serve-full.mjs"

%SLEEP% 4 127.0.0.1 >nul
start "" "http://localhost:8080"

echo.
echo   Friendly ERP is starting in three windows.
echo.
echo     App        http://localhost:8080
echo     API        http://localhost:4000/api/health
echo     Database   localhost:5433  (data in localdb\pgdata)
echo.
echo   Sign in with the demo builder workspace:
echo     admin@acme.test / Friendly@2026        (owner — sees everything)
echo     sales@acme.test / Friendly@2026        (sales executive)
echo     site@acme.test  / Friendly@2026        (site engineer)
echo.
echo   The app is also reachable from your phone on the same Wi-Fi —
echo   the web server window prints the address to use.
echo.
pause
