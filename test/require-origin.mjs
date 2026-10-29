// Test-only: every Codex/installer/live test imports this first. It makes eol-connect's origin() refuse to fall back to
// config.json or the production Lobby (see common.mjs), and the flag is inherited by every child process the tests spawn.
process.env.EOL_REQUIRE_ORIGIN = '1';
