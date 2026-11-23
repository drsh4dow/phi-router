import { Effect, FileSystem } from "effect";

const spelled = Effect.fnUntraced(function* spelled(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const { writeFileString } = fs;
	const { open: opened } = yield* FileSystem.FileSystem;
	const made = fs.makeDirectory;

	yield* fs["chmod"](file, 0o644);
	yield* writeFileString(file, text);
	yield* opened(file);
	yield* made(file);
});

export { spelled };
