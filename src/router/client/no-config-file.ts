import { Schema } from "effect";

/** `config.json` does not exist, as before setup ran. */
class NoConfigFile extends Schema.TaggedError<NoConfigFile, { readonly brand: unique symbol }>()("NoConfigFile", {
	file: Schema.String,
}) {
	public override get message(): string {
		return `${this.file} does not exist`;
	}
}

export { NoConfigFile };
