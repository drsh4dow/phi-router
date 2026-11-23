import { Array, Number as Num, String as Str, pipe } from "effect";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";

interface Figure {
	readonly name: string;
	readonly born: number;
	readonly died: number;
	readonly knownFor: string;
}

const figures: Array.NonEmptyReadonlyArray<Figure> = [
	{ born: 1815, died: 1852, knownFor: "notes on the Analytical Engine", name: "Ada Lovelace" },
	{ born: 1791, died: 1871, knownFor: "the Difference Engine", name: "Charles Babbage" },
	{ born: 1815, died: 1864, knownFor: "the algebra of logic", name: "George Boole" },
	{ born: 1860, died: 1929, knownFor: "the punched-card tabulating machine", name: "Herman Hollerith" },
	{ born: 1867, died: 1934, knownFor: "radioactivity research and two Nobel Prizes", name: "Marie Curie" },
	{ born: 1882, died: 1935, knownFor: "abstract algebra and the conservation laws", name: "Emmy Noether" },
	{ born: 1850, died: 1891, knownFor: "partial differential equations", name: "Sofya Kovalevskaya" },
	{ born: 1887, died: 1920, knownFor: "number theory and infinite series", name: "Srinivasa Ramanujan" },
	{ born: 1868, died: 1921, knownFor: "measuring the distance to variable stars", name: "Henrietta Leavitt" },
	{ born: 1826, died: 1866, knownFor: "the geometry of curved spaces", name: "Bernhard Riemann" },
	{ born: 1791, died: 1867, knownFor: "electromagnetic induction", name: "Michael Faraday" },
	{ born: 1831, died: 1879, knownFor: "the equations of electromagnetism", name: "James Clerk Maxwell" },
	{ born: 1791, died: 1872, knownFor: "the single-wire telegraph and its code", name: "Samuel Morse" },
	{ born: 1899, died: 1938, knownFor: "eight Grand Slam singles titles", name: "Suzanne Lenglen" },
	{ born: 1861, died: 1939, knownFor: "inventing basketball", name: "James Naismith" },
	{ born: 1898, died: 1937, knownFor: "Rhapsody in Blue", name: "George Gershwin" },
];

const fewestFigures = 3;
const mostFigures = 6;

const someFigures = (rng: Random): Figure[] =>
	Array.take(rng.shuffle(figures), rng.between(fewestFigures, mostFigures));

const surname = ({ name }: Figure): string => pipe(name, Str.split(" "), Array.lastNonEmpty, Str.toLowerCase);

const seedData = (rng: Random): Sample => {
	const entries = pipe(
		someFigures(rng),
		Array.map(
			({ name, born, knownFor }) => `  {"name": "${name}", "born": ${String(born)}, "known_for": "${knownFor}"}`,
		),
	);

	return {
		payload: `[\n${Array.join(entries, ",\n")}\n]`,
		scene: {
			asks: [
				"The 'on this day' widget shows nothing for these. Is the seed file wrong?",
				"Load these into the trivia fixtures.",
			],
			commands: ["cat db/seeds/pioneers.json"],
			paths: ["db/seeds/pioneers.json"],
		},
	};
};

const podHashLength = 10;
const podSuffixLength = 5;
const restartsBelow = 4;
const youngestPodDays = 2;
const oldestPodDays = 40;

const serviceNames = (rng: Random): Sample => {
	const lines = pipe(
		someFigures(rng),
		Array.map(
			(figure) =>
				`${surname(figure)}-worker-${rng.hex(podHashLength)}-${rng.chars("bcdfghjklmnpqrstvwxz2456789", podSuffixLength)}   1/1     Running   ${String(rng.int(restartsBelow))}          ${String(rng.between(youngestPodDays, oldestPodDays))}d`,
		),
	);

	return {
		payload: Array.join(["NAME                                 READY   STATUS    RESTARTS   AGE", ...lines], "\n"),
		scene: {
			asks: [
				"One of these workers keeps restarting. Which one, and why?",
				"Rename these deployments to the new convention.",
			],
			commands: ["kubectl get pods -n batch"],
			paths: ["k8s/batch/workers.yaml"],
		},
	};
};

const lightestRoadWeight = 1;
const heaviestRoadWeight = 3;

const dispatch = (rng: Random): Sample => ({
	payload: Array.join(
		[
			"/** Edsger Dijkstra's shortest-path algorithm over the road graph, from the station to the scene. */",
			"export function dijkstra(graph: RoadGraph, station: NodeId): Map<NodeId, number> {",
			"  const dist = new Map<NodeId, number>([[station, 0]]);",
			"  const queue = new MinHeap<[NodeId, number]>(([, a], [, b]) => a - b);",
			"  queue.push([station, 0]);",
			"  while (queue.size > 0) {",
			"    const [node, d] = queue.pop();",
			`    for (const { to, minutes } of graph.edges(node)) {`,
			`      const next = d + minutes * ${String(rng.between(lightestRoadWeight, heaviestRoadWeight))};`,
			"      if (next < (dist.get(to) ?? Infinity)) {",
			"        dist.set(to, next);",
			"        queue.push([to, next]);",
			"      }",
			"    }",
			"  }",
			"  return dist;",
			"}",
		],
		"\n",
	),
	scene: {
		asks: [
			"The ambulance routing picks a longer route here. Is my Dijkstra wrong?",
			"Add a test for unreachable stations.",
		],
		commands: ["sed -n '1,40p' src/dispatch/route.ts"],
		paths: ["src/dispatch/route.ts"],
	},
});

const hospitals: Array.NonEmptyReadonlyArray<string> = [
	"Johns Hopkins Hospital, Baltimore, MD",
	"Mayo Clinic, Rochester, MN",
	"Dana-Farber Cancer Institute, Boston, MA",
	"Memorial Sloan Kettering Cancer Center, New York, NY",
	"Cedars-Sinai Medical Center, Los Angeles, CA",
	"Vanderbilt University Medical Center, Nashville, TN",
	"Barnes-Jewish Hospital, St. Louis, MO",
];

const fewestHospitals = 3;

const referralDirectory = (rng: Random): Sample => {
	const listed = Array.take(rng.shuffle(hospitals), rng.between(fewestHospitals, hospitals.length));

	return {
		payload: Array.join(
			[
				"export const destinations = [",
				...pipe(
					listed,
					Array.map((hospital) => `  "${hospital}",`),
				),
				"];",
			],
			"\n",
		),
		scene: {
			asks: [
				"The referral dropdown sorts these wrong. Can you fix the comparator?",
				"Add a search box over this list.",
			],
			commands: ["cat src/referrals/destinations.ts"],
			paths: ["src/referrals/destinations.ts"],
		},
	};
};

const fewestHits = 2;
const mostHits = 9;

const searchTest = (rng: Random): Sample => {
	const figure = rng.pick(figures);

	return {
		payload: Array.join(
			[
				`test("finds articles about ${figure.name}", async () => {`,
				`  const hits = await index.search("${figure.name}");`,
				`  expect(hits[0]?.title).toBe("${figure.name} and ${figure.knownFor}");`,
				`  expect(hits).toHaveLength(${String(rng.between(fewestHits, mostHits))});`,
				"});",
			],
			"\n",
		),
		scene: {
			asks: ["This search test flakes in CI. Why?", "Why does the ranking put the wrong article first?"],
			commands: ["bun test test/search.test.ts"],
			paths: ["test/search.test.ts"],
		},
	};
};

const fewestVotes = 3;
const mostVotes = 90;
const lowestFloor = 2;
const highestFloor = 9;

const roomPoll = (rng: Random): Sample => ({
	payload: Array.join(
		[
			"rank,room_name_candidate,votes,floor",
			...pipe(
				someFigures(rng),
				Array.map(
					({ name }, index) =>
						`${String(Num.increment(index))},${name},${String(rng.between(fewestVotes, mostVotes))},${String(rng.between(lowestFloor, highestFloor))}`,
				),
			),
		],
		"\n",
	),
	scene: {
		asks: [
			"The poll results page renders these out of order. Can you check the sort?",
			"Convert this poll export to JSON.",
		],
		commands: ["cat exports/room-naming-poll.csv"],
		paths: ["exports/room-naming-poll.csv"],
	},
});

const commitHashLength = 7;
const oldestTypescriptMinor = 4;
const newestTypescriptMinor = 9;
const lowestPatch = 2;
const highestPatch = 9;

const changelog = (rng: Random): Sample => {
	const [first, second] = [rng.pick(figures), rng.pick(figures)];

	return {
		payload: Array.join(
			[
				`${rng.hex(commitHashLength)} feat(scheduler): name the new queue "${surname(first)}" after ${first.name}`,
				`${rng.hex(commitHashLength)} docs: quote ${second.name} in the contributing guide`,
				`${rng.hex(commitHashLength)} fix(scheduler): drain the ${surname(first)} queue on shutdown`,
				`${rng.hex(commitHashLength)} chore: bump typescript to 5.${String(rng.between(oldestTypescriptMinor, newestTypescriptMinor))}.${String(rng.between(lowestPatch, highestPatch))}`,
			],
			"\n",
		),
		scene: {
			asks: ["Tidy up this changelog entry before the release.", "Write release notes from these commits."],
			commands: ["git log --oneline -6"],
			paths: ["CHANGELOG.md"],
		},
	};
};

const publicFigures: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	seedData,
	serviceNames,
	dispatch,
	referralDirectory,
	searchTest,
	roomPoll,
	changelog,
];

export { figures, publicFigures };
