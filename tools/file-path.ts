import { String as Str, pipe } from "effect";

const driveRooted = /^\/(?=[A-Za-z]:\/)/u;

const filePath = (url: { readonly pathname: string }): string =>
	pipe(decodeURIComponent(url.pathname), Str.replace(driveRooted, ""));

export { filePath };
