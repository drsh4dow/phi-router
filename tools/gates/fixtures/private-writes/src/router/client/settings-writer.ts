import { Effect, FileSystem } from "effect";

const written = Effect.fnUntraced(function* written(folder: string, text: string) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.makeDirectory(folder, { recursive: true });
	yield* fs.writeFileString(`${folder}/settings.json`, text);
	yield* fs.chmod(`${folder}/settings.json`, 0o600);
});

export { written };
