import { claudePlay } from "./claude.ts";
import { codexPlay } from "./codex.ts";
import { piPlay } from "./pi.ts";

/** Each harness `bun run wire` drives, and its play. */
const plays = { claude: claudePlay, codex: codexPlay, pi: piPlay } as const;

export { plays };
