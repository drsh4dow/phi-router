import { Schema } from "effect";

class NoConfigFile extends Schema.TaggedError<NoConfigFile, { readonly brand: unique symbol }>()("NoConfigFile", {
	file: Schema.String,
}) {
	public override get message(): string {
		return `${this.file} does not exist`;
	}
}

export { NoConfigFile };
