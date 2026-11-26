import { Array, Config, Console, Effect, Schema } from "effect";
import { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { modelAddressSetting } from "#router/features/cli/claude/index.ts";
import { piWire } from "#shared/pi.ts";
import { portOf } from "./session-start.ts";
import { standardInput } from "#router/client/standard-input.ts";
import { statusLine } from "./phi-text.ts";

const StatusLineInput = Schema.fromJsonString(
	Schema.Struct({ model: Schema.Struct({ id: Schema.String }), session_id: SessionId }),
);

const phiModels: readonly string[] = [piWire.models.auto, piWire.models.sealed];

const statusline = Effect.fn("statusline")(function* statusline() {
	const input = yield* standardInput.pipe(Effect.flatMap(Schema.decodeEffect(StatusLineInput)));

	if (!Array.contains(phiModels, input.model.id)) {
		return;
	}

	const address = yield* Config.String(modelAddressSetting);
	const port = yield* Effect.fromOption(portOf(address));
	const requests = yield* SessionRequests;
	const status = yield* requests.status(port, input.session_id);

	yield* Console.log(statusLine(status));
}, Effect.ignore);

export { statusline };
