import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { isPrivateDacl } from "#router/client/private-file.ts";

const user = "S-1-5-21-1-2-3-1001";

const builtinAdmin = "S-1-5-21-1-2-3-500";

const judged = Effect.sync(() => {
	assert.deepStrictEqual(
		{
			adminAlias: isPrivateDacl({ sid: builtinAdmin, target: "folder" })(
				"D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)",
			),
			aliasForOther: isPrivateDacl({ sid: user, target: "file" })("D:PAI(A;;FA;;;LA)"),
			everyone: isPrivateDacl({ sid: user, target: "file" })(`D:PAI(A;;FA;;;${user})(A;;FR;;;WD)`),
			inherited: isPrivateDacl({ sid: user, target: "inheritedFile" })(`D:AI(A;ID;FA;;;${user})`),
			notProtected: isPrivateDacl({ sid: user, target: "file" })(`D:AI(A;;FA;;;${user})`),
			onlyTrusted: isPrivateDacl({ sid: user, target: "file" })("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)"),
			otherUser: isPrivateDacl({ sid: user, target: "file" })(`D:PAI(A;;FA;;;${user})(A;;FA;;;S-1-5-21-1-2-3-1002)`),
			owner: isPrivateDacl({ sid: user, target: "file" })(`D:PAI(A;;FA;;;${user})`),
			trailing: isPrivateDacl({ sid: user, target: "file" })(`D:PAI(A;;FA;;;${user})S:AI`),
			withSystem: isPrivateDacl({ sid: user, target: "folder" })(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})`),
		},
		{
			adminAlias: true,
			aliasForOther: false,
			everyone: false,
			inherited: true,
			notProtected: false,
			onlyTrusted: false,
			otherUser: false,
			owner: true,
			trailing: false,
			withSystem: true,
		},
	);
});

it.effect(
	"a private DACL names the current user, and may also name only SYSTEM and Administrators, who can read every file anyway",
	() => judged,
);
