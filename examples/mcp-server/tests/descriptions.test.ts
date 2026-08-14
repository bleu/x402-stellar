import { describe, expect, it } from "vitest";

import { payDescription, searchDescription } from "../src/server.js";
import { TOOL_ERROR_CODES } from "../src/errors.js";
import { ability, connect } from "./helpers.js";

/**
 * Words that would give the agent prior knowledge of a service. The claim in
 * this demo is that the agent discovers where to go, so anything naming a
 * subject area, a seed-corpus service or a demo hostname must fail the build.
 */
const FORBIDDEN_IN_DESCRIPTIONS = [
  "weather",
  "forecast",
  "temperature",
  "geocode",
  "san francisco",
  "stellar weather",
  "localhost",
  "3001",
  ".com",
  "/weather",
];

describe("tool descriptions", () => {
  it("name no service, domain or subject area", () => {
    const text = [searchDescription(ability), payDescription()].join(" ").toLowerCase();

    for (const forbidden of FORBIDDEN_IN_DESCRIPTIONS) {
      expect(text, `"${forbidden}" must not appear in a tool description`).not.toContain(forbidden);
    }
  });

  it("still tell the agent what it can pay in and what the parameters mean", () => {
    const search = searchDescription(ability);

    // Documenting units and the wallet's own limits is not a hint about a service.
    expect(search).toContain("maxUsdPrice");
    expect(search).toContain("US dollars");
    expect(search).toContain(ability.describe());
    expect(payDescription()).toContain("402");
  });

  it("explain a ceiling price, since a row's price may be more than it charges", () => {
    // The row carries scheme: "upto" and nothing else marks it, so the only
    // place an agent can learn what that price means is here.
    const search = searchDescription(ability).toLowerCase();

    expect(search).toContain("upto");
    expect(search).toContain("ceiling");
  });

  it("reach the client verbatim", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const search = tools.find((tool) => tool.name === "search_bazaar");
    expect(search?.description).toBe(searchDescription(ability));
  });
});

describe("error codes", () => {
  it("are unique and lower_snake_case, so callers can branch on them", () => {
    expect(new Set(TOOL_ERROR_CODES).size).toBe(TOOL_ERROR_CODES.length);
    for (const code of TOOL_ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
