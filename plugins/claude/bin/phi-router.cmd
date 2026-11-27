@echo off
setlocal
if not exist "%~dp0..\phi-router.mjs" (
	1>&2 echo This copy of phi-router is not built. Run bun run build in it, or install a release.
	exit /b 1
)
set "PHI_ROUTER_LAUNCHED=1"
set "PHI_ROUTER_GIVEN_NO_PROXY=%NO_PROXY%"
if defined NO_PROXY (set "NO_PROXY=127.0.0.1,%NO_PROXY%") else (set "NO_PROXY=127.0.0.1")
if /i "%~1"=="doctor" set "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"
where bun >nul 2>nul
if errorlevel 1 (node "%~dp0..\phi-router.mjs" %*) else (bun "%~dp0..\phi-router.mjs" %*)
exit /b %errorlevel%
