import * as Runtime from "effect/Runtime";
import { BunServices } from "@effect/platform-bun";
import OpenAI from "openai";
import { it } from "@effect/vitest";
import { readFileSync } from "node:fs";

export const owned = [Runtime, BunServices, OpenAI, it, readFileSync];
